// Assemble the context one check declared it needs.
//
// Lives apart from the runner so that something other than CI can build the
// exact same context: the local mode renders the same prompt a CI run would
// send, and it can only promise that if both paths call this one function.
//
// The task manager is injected rather than imported. CI passes the real HTTP
// client; a caller that has no task manager at all passes nothing, and every
// lookup then fails the way an unreachable manager does — which already has a
// documented fallback (the PR body's `criteria` block).

import { buildDiff, ensureBaseRef } from './diff.mjs';
import { classifyDiffFiles } from './files.mjs';
import { crossWithTests } from './coverage.mjs';
import { buildDuplicationContext } from './duplication.mjs';
import { symbolsFromDiff } from '../symbols/index.mjs';
import { loadRules } from './rules.mjs';
import { resolveTaskRef } from './task-ref.mjs';

/** The default task source: none. Fails like an unreachable task manager. */
async function noTaskSource(id) {
  throw new Error(`no task source is configured to fetch #${id}`);
}

/**
 * Assemble only the context this check declared it needs.
 *
 * @param {object} opts
 * @param {{meta: {contextNeeds: string[]}}} opts.check
 * @param {object} opts.inputs   `readInputs()` shape: base, head, repo, headRef, prTitle, prBody.
 * @param {object} opts.config   `resolveConfig()` output for this check.
 * @param {(message: string) => void} [opts.log]
 * @param {(id: string) => Promise<object>} [opts.fetchTask]
 * @param {boolean} [opts.fetchBase=true] Fetch the base ref before diffing. CI
 *   needs it; a local run diffs refs that already exist and must not touch the network.
 * @returns {Promise<object>}
 */
export async function buildContext({
  check,
  inputs,
  config,
  log = () => {},
  fetchTask = noTaskSource,
  fetchBase = true,
}) {
  const needs = new Set(check.meta.contextNeeds);
  const ctx = {
    base: inputs.base,
    head: inputs.head,
    repo: inputs.repo,
    taskId: null,
    config,
    // What the developer says they did. Every check gets it, because judging a
    // change without reading its author's account of it is judging half the
    // conversation. It is untrusted input and each check renders it as such.
    prTitle: inputs.prTitle,
    prBody: inputs.prBody,
    headRef: inputs.headRef,
  };

  if (needs.has('diff')) {
    if (fetchBase) ensureBaseRef(inputs.repo, inputs.base);
    ctx.diff = buildDiff({
      repo: inputs.repo,
      base: inputs.base,
      head: inputs.head,
      maxChars: config.maxDiffChars,
    });
    ctx.files = classifyDiffFiles(ctx.diff);
  }

  if (needs.has('rules')) {
    ctx.rules = loadRules({
      repo: inputs.repo,
      maxChars: config.maxRulesChars,
      // Rules that declare which files they govern are matched against what
      // this pull request actually touches, so an out-of-scope convention never
      // takes budget from one that applies.
      touched: ctx.files?.files ?? null,
    });
  }

  // The symbol passes read the whole reviewable diff, never the budgeted one:
  // what the prompt had room to show must not decide which symbols exist. A
  // truncated diff used to report "3 symbols, no candidates" for a branch whose
  // facts listed 22 symbols and 8 candidates.
  const symbolDiff = ctx.diff?.fullDiff ?? ctx.diff?.diff ?? '';

  if (needs.has('coverage')) {
    ctx.coverage = crossWithTests({
      symbols: symbolsFromDiff(symbolDiff),
      repo: inputs.repo,
    });
  }

  if (needs.has('duplication')) {
    ctx.duplication = buildDuplicationContext({
      diffText: symbolDiff,
      repo: inputs.repo,
      threshold: config.threshold,
      maxCandidates: config.maxCandidates,
    });
  }

  if (needs.has('task')) {
    const ref = resolveTaskRef({
      headRef: inputs.headRef,
      prTitle: inputs.prTitle,
      prBody: inputs.prBody,
    });
    ctx.taskRef = ref;
    ctx.taskId = ref.subjectId;

    if (ref.mode === 'task' && ref.subjectId) {
      try {
        ctx.task = await fetchTask(ref.subjectId);
        // The fence is deliberately *not* carried over here. It is the fallback
        // for an unreachable task manager, and on the success path it would let
        // the author of the change write the criteria they are judged against —
        // while the comment still carries the real task's id, so a reviewer
        // reads it as the real criteria having been checked.
        if (ref.criteriaBlock) {
          ctx.criteriaBlockIgnored = true;
          log(`ignoring the PR body criteria fence: task #${ref.subjectId} was fetched`);
        }
      } catch (err) {
        log(`task fetch failed for #${ref.subjectId}: ${err.message}`);
        // The PR-body block is the documented fallback for an unreachable
        // task manager.
        ctx.task = ref.criteriaBlock ? { criteriaBlock: ref.criteriaBlock } : null;
        ctx.taskFetchError = err.message;
      }

      // Context tasks are a nicety, never a requirement: one that fails to
      // load costs the model some background and nothing else, so a failure
      // here must not touch the verdict.
      ctx.contextTasks = [];
      for (const id of ref.contextIds) {
        try {
          ctx.contextTasks.push(await fetchTask(id));
        } catch (err) {
          log(`context task fetch failed for #${id}: ${err.message}`);
        }
      }
    } else if (ref.criteriaBlock) {
      ctx.task = { criteriaBlock: ref.criteriaBlock };
    }
  }

  return ctx;
}
