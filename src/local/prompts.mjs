// `prompts`: the system and user prompt each check would send in CI.
//
// The sequence mirrors `runCheck` up to the model call — same context builder,
// same short-circuits, same notes, same `buildPrompt` — so what a local reviewer
// reads is what the CI model would have read. The one thing that cannot match
// byte for byte is the per-call id inside each untrusted block, which is random
// by design.
//
// Alongside each prompt goes `<check>.ctx.json`: the slice of the context that
// `render` needs later to turn an answer into a verdict the way CI would.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContext } from '../context/build.mjs';
import { loadRepoConfig } from '../context/repo-config.mjs';
import { getCheck, listChecks } from '../checks/registry.mjs';
import { contextNotes, isContentFailure, shortCircuit } from '../checks/short-circuit.mjs';
import { skippedVerdict, toolErrorVerdict, unreviewableVerdict } from '../report/verdict.mjs';
import { checkConfig } from './config.mjs';
import { UsageError } from './errors.mjs';
import { repoName, resolveBranch, resolveSha, topLevel } from './git.mjs';
import { stableStringify } from './json.mjs';

/**
 * A task source backed by a file the caller prepared.
 *
 * Accepts one task object (with `id`) or `{ "tasks": { "<id>": task } }`. An id
 * the file does not hold fails like an unreachable task manager, which sends the
 * criteria check to the PR body's `criteria` block exactly as CI would.
 */
export function fileTaskSource(path) {
  if (!path) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read the task file ${path}: ${err.message}`);
  }

  const tasks = new Map();
  if (parsed?.tasks && typeof parsed.tasks === 'object') {
    for (const [id, task] of Object.entries(parsed.tasks)) tasks.set(String(id), { id: String(id), ...task });
  } else if (parsed && typeof parsed === 'object' && parsed.id !== undefined) {
    tasks.set(String(parsed.id), parsed);
  } else {
    throw new UsageError(`the task file ${path} must hold a task with an "id", or {"tasks": {...}}`);
  }

  return async (id) => {
    const task = tasks.get(String(id));
    if (!task) throw new Error(`task #${id} is not in the task file`);
    return task;
  };
}

/** Parse `--checks a,b`; every name must exist. Defaults to every check. */
export function parseChecks(value) {
  if (!value) return listChecks();
  const names = String(value)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const known = new Set(listChecks());
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length) {
    throw new UsageError(`unknown check(s): ${unknown.join(', ')}. Available: ${listChecks().join(', ')}.`);
  }
  return [...new Set(names)];
}

/**
 * What the prompt could not show, as data a caller can branch on.
 *
 * The notes say the same in prose, for a person. A local orchestrator needs a
 * flag instead: a reviewer handed a partial prompt must read the rest of the
 * branch from `diff.patch` before judging it, and "the note contained the word
 * truncado" is not a contract.
 *
 * @returns {{partial: boolean, reasons: string[], diff: object|null}}
 */
export function promptCompleteness(ctx) {
  const reasons = [];
  const diff = ctx.diff ?? null;
  if (diff?.truncated) reasons.push('diff-truncated');
  if (ctx.rules?.truncated) reasons.push('rules-truncated');
  const dup = ctx.duplication;
  if (dup?.indexTruncated) reasons.push('duplication-index-truncated');
  if (dup?.comparisonTruncated) reasons.push('duplication-comparison-truncated');
  return {
    partial: reasons.length > 0,
    reasons,
    diff: diff
      ? {
          truncated: Boolean(diff.truncated),
          shownChars: diff.diff.length,
          totalChars: diff.totalChars,
          totalFiles: diff.totalFiles,
          includedFiles: diff.includedFiles,
          omittedFiles: diff.omittedFiles,
          // By name: the reviewer of a partial prompt reads exactly these from
          // diff.patch, instead of guessing which part of the branch it missed.
          omittedPaths: diff.omittedPaths ?? [],
          partialPath: diff.partialPath ?? null,
          exemptFiles: diff.exemptFiles ?? [],
        }
      : null,
  };
}

/** What `render` needs from the context. Plain data only. */
function renderContext({ name, check, config, ctx, notes }) {
  const completeness = promptCompleteness(ctx);
  return {
    check: name,
    title: check.meta.title,
    config,
    notes,
    partial: completeness.partial,
    partialReasons: completeness.reasons,
    diff: completeness.diff,
    taskId: ctx.taskId ?? null,
    taskRef: ctx.taskRef ?? null,
    task: ctx.task ?? null,
  };
}

/**
 * The prompt one check would send, or the verdict it reaches without a model.
 *
 * @returns {Promise<{kind: 'prompt', system: string, user: string, render: object}
 *                  | {kind: 'skip', verdict: object}>}
 */
export async function preparePrompt({ name, inputs, repoConfig, fetchTask, log = () => {} }) {
  const check = getCheck(name);
  const config = checkConfig(repoConfig, name, inputs);

  let ctx;
  try {
    ctx = await buildContext({ check, inputs, config, log, fetchTask, fetchBase: false });
  } catch (err) {
    if (isContentFailure(err)) {
      return {
        kind: 'skip',
        verdict: unreviewableVerdict({
          check: name,
          title: check.meta.title,
          error: err.message,
          blocking: config.blocking,
          meta: { model: config.model },
        }),
      };
    }
    return {
      kind: 'skip',
      verdict: toolErrorVerdict({ check: name, title: check.meta.title, error: err.message }),
    };
  }

  const early = shortCircuit({ name, check, inputs, ctx });
  if (early) return { kind: 'skip', verdict: early };

  const notes = contextNotes(ctx, repoConfig, name);

  if (ctx.diff?.empty && name !== 'criteria') {
    return {
      kind: 'skip',
      verdict: skippedVerdict({
        check: name,
        title: check.meta.title,
        reason: 'El PR no introduce cambios respecto a la rama base.',
      }),
    };
  }

  let built;
  try {
    // The header names the repository, not the folder it is checked out in: two
    // worktrees of one commit must write the same prompt.
    built = check.buildPrompt(inputs.repoName ? { ...ctx, repo: inputs.repoName } : ctx);
  } catch (err) {
    return {
      kind: 'skip',
      verdict: toolErrorVerdict({
        check: name,
        title: check.meta.title,
        error: err.message,
        meta: { model: config.model },
        notes,
      }),
    };
  }

  return {
    kind: 'prompt',
    system: built.system,
    user: built.prompt,
    render: renderContext({ name, check, config, ctx, notes }),
  };
}

/**
 * Run `prompts` and write one set of files per check under `<out>/prompts/`.
 *
 * @param {object} opts
 * @param {string} opts.repo
 * @param {string} opts.base
 * @param {string} opts.out
 * @param {string} [opts.checks]      Comma-separated list.
 * @param {string} [opts.headRef]     Branch name as CI would see it.
 * @param {string} [opts.title]
 * @param {string|null} [opts.bodyFile]
 * @param {string|null} [opts.taskFile]
 * @param {string} [opts.configPath]
 * @param {string} [opts.model]
 * @returns {Promise<object>} the index written to `prompts/index.json`.
 */
export async function writePrompts({
  repo: repoArg,
  base,
  out,
  checks,
  headRef,
  title = '',
  bodyFile = null,
  taskFile = null,
  configPath,
  model = '',
  log = () => {},
}) {
  const names = parseChecks(checks);
  const repo = topLevel(repoArg);
  // Validated up front so a missing base is a git error, not six tool errors.
  resolveSha(repo, base);
  const headSha = resolveSha(repo, 'HEAD');

  let prBody = '';
  if (bodyFile) {
    try {
      prBody = readFileSync(bodyFile, 'utf8');
    } catch (err) {
      throw new UsageError(`cannot read the body file ${bodyFile}: ${err.message}`);
    }
  }

  const inputs = {
    base,
    head: headSha,
    repo,
    repoName: repoName(repo),
    headRef: resolveBranch(repo, { explicit: headRef, base }).branch,
    prTitle: title,
    prBody,
    model,
    configPath,
  };
  const repoConfig = loadRepoConfig({ repo, configPath });
  const fetchTask = fileTaskSource(taskFile);

  const dir = join(out, 'prompts');
  mkdirSync(dir, { recursive: true });

  const index = { head: headSha, base, partial: false, checks: [] };
  for (const name of names) {
    const result = await preparePrompt({ name, inputs, repoConfig, fetchTask, log });
    // A previous run may have left the other outcome's files behind.
    for (const suffix of ['skip.json', 'system.md', 'user.md', 'ctx.json']) {
      rmSync(join(dir, `${name}.${suffix}`), { force: true });
    }
    if (result.kind === 'skip') {
      writeFileSync(join(dir, `${name}.skip.json`), stableStringify(result.verdict), 'utf8');
      index.checks.push({ check: name, kind: 'skip', status: result.verdict.status, file: `${name}.skip.json` });
      continue;
    }
    // Written exactly as built: no trailing newline added, nothing normalised.
    writeFileSync(join(dir, `${name}.system.md`), result.system, 'utf8');
    writeFileSync(join(dir, `${name}.user.md`), result.user, 'utf8');
    writeFileSync(join(dir, `${name}.ctx.json`), stableStringify(result.render), 'utf8');
    index.checks.push({
      check: name,
      kind: 'prompt',
      files: { system: `${name}.system.md`, user: `${name}.user.md`, ctx: `${name}.ctx.json` },
      // true when the prompt shows only part of what it reviews; the reasons and
      // the diff counts are in the ctx file.
      partial: result.render.partial,
      partialReasons: result.render.partialReasons,
    });
  }

  index.partial = index.checks.some((entry) => entry.partial === true);
  writeFileSync(join(dir, 'index.json'), stableStringify(index), 'utf8');
  return index;
}
