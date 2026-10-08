// Diff context: what changed between the base branch and the PR head.
//
// Every AI check reads from here, so truncation is measured rather than
// silent. The previous generation of this tool cut the diff at a fixed budget
// and said nothing, which meant a large PR got a partial review that looked
// identical to a full one.

import { execFileSync } from 'node:child_process';
import { categorize, isBudgetExempt } from './categories.mjs';

export const DEFAULT_MAX_DIFF_CHARS = 36000;

export class DiffError extends Error {
  /**
   * @param {string} message
   * @param {{contentFailure?: boolean}} [opts] `contentFailure` marks a failure
   *   caused by the change under review rather than by the environment, so the
   *   runner can block on it instead of reporting a non-blocking tool error.
   */
  constructor(message, { contentFailure = false } = {}) {
    super(message);
    this.name = 'DiffError';
    this.contentFailure = contentFailure;
  }
}

/**
 * Did `git` fail because its output did not fit the buffer?
 *
 * That is a property of the branch, not of the runner, so it has to be told apart
 * from a genuine git failure: the first means this pull request could not be
 * reviewed and the second means something is broken here. The `maxChars` budget
 * cannot prevent it — it applies to the returned string, long after the child has
 * already been killed.
 */
export function isTooLargeError(err) {
  return err?.code === 'ENOBUFS' || /maxBuffer/i.test(String(err?.message ?? ''));
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Capture stderr instead of inheriting it: a failed fetch is handled here
    // and must not spray git noise into the CI log as if something broke.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Count files in a `git diff --stat` block. The last line is the
 * "N files changed, ..." summary, so it is not a file entry.
 */
function countStatFiles(stat) {
  if (!stat) return 0;
  const lines = stat.split('\n').filter((l) => l.trim());
  if (!lines.length) return 0;
  const last = lines[lines.length - 1];
  return /\bfiles? changed\b/.test(last) ? lines.length - 1 : lines.length;
}

/** Files listed by name in the line about files left out of the budget. */
const MAX_EXEMPT_LISTED = 20;

/** The destination path of one `diff --git a/X b/Y` section. */
function sectionPath(section) {
  const plus = section.match(/^\+\+\+ b\/(.+?)\r?$/m);
  if (plus) return plus[1];
  // A deletion has `+++ /dev/null`; its path is on the header.
  const header = section.match(/^diff --git a\/.+? b\/(.+?)\r?$/m);
  return header ? header[1] : '';
}

/**
 * Split a unified diff into the part a reviewer reads and the files nobody
 * writes by hand (lockfiles, snapshots, generated output).
 *
 * Applied BEFORE the budget: a migration's `.Designer.cs` or a lockfile churn
 * of tens of thousands of characters used to fill the budget on its own and
 * push the hand-written half of the branch out of the prompt. The stat still
 * lists the exempt files, and the diff names the ones it left out.
 *
 * @param {string} diff
 * @returns {{reviewable: string, exempt: Array<{path: string, chars: number}>}}
 */
export function splitBudgetExempt(diff) {
  const sections = String(diff ?? '').split(/(?=^diff --git )/m);
  const kept = [];
  const exempt = [];
  for (const section of sections) {
    const path = section.startsWith('diff --git ') ? sectionPath(section) : '';
    if (path && isBudgetExempt(path)) exempt.push({ path, chars: section.length });
    else kept.push(section);
  }
  return { reviewable: kept.join(''), exempt };
}

/** The line appended to a diff body naming the files kept out of the budget. */
function exemptLine(exempt) {
  const shown = exempt.slice(0, MAX_EXEMPT_LISTED).map((entry) => entry.path);
  const more = exempt.length > shown.length ? `, +${exempt.length - shown.length} more` : '';
  return (
    `[... ${exempt.length} generated, lockfile or snapshot file(s) left out of the diff body, ` +
    `not reviewed line by line: ${shown.join(', ')}${more} ...]`
  );
}

/**
 * Where a file stands in the queue for the diff budget; lower goes first.
 *
 * Production code is what a reviewer is asked to judge, so it is never pushed
 * out by the tests that exercise it, and neither is pushed out by prose. Docs,
 * tooling folders and assets only get what the code left over: on a branch
 * that also committed a long design note and the PR description, those used to
 * take the budget from the services the change was about.
 *
 * @param {string} path
 * @returns {0|1|2|3}
 */
export function budgetRank(path) {
  switch (categorize(path)) {
    case 'prod':
      return 0;
    case 'style':
    case 'locale':
      return 1;
    case 'test':
      return 2;
    default:
      return 3;
  }
}

/**
 * The head of one section within `maxChars`, cut on a hunk boundary when one
 * exists inside the budget, else on a line boundary.
 */
function sectionHead(text, maxChars) {
  const slice = text.slice(0, Math.max(0, maxChars));
  const firstHunk = text.indexOf('\n@@ ');
  const lastHunk = slice.lastIndexOf('\n@@ ');
  if (firstHunk >= 0 && lastHunk > firstHunk) return slice.slice(0, lastHunk + 1);
  const line = slice.lastIndexOf('\n');
  return line > 0 ? slice.slice(0, line + 1) : slice;
}

/**
 * Fit a reviewable diff into `maxChars`, whole files only and by rank.
 *
 * Files are taken in budget order (`budgetRank`, then the order git printed
 * them), and one that does not fit is skipped rather than ending the walk, so a
 * large file never hides the smaller ones after it. What is shown keeps git's
 * order. Only when not a single file fits is the first one in budget order cut
 * short, so the prompt never goes out empty for a branch that changed code.
 *
 * @param {string} reviewable  The diff with the budget-exempt files already out.
 * @param {number} maxChars
 * @returns {{diff: string, truncated: boolean, included: string[],
 *   omitted: string[], partial: string|null}}
 */
export function fitDiffToBudget(reviewable, maxChars) {
  const text = String(reviewable ?? '');
  const sections = text.split(/(?=^diff --git )/m).map((body, index) => {
    const isFile = body.startsWith('diff --git ');
    const path = isFile ? sectionPath(body) : '';
    return { body, index, isFile, path, rank: isFile ? budgetRank(path) : -1 };
  });
  const files = sections.filter((section) => section.isFile);

  if (text.length <= maxChars) {
    return { diff: text, truncated: false, included: files.map((f) => f.path), omitted: [], partial: null };
  }

  const queue = [...files].sort((a, b) => a.rank - b.rank || a.index - b.index);
  let used = sections.filter((section) => !section.isFile).reduce((sum, section) => sum + section.body.length, 0);
  const shown = new Map();
  for (const section of queue) {
    if (used + section.body.length > maxChars) continue;
    shown.set(section.index, section.body);
    used += section.body.length;
  }

  let partial = null;
  if (!shown.size && queue.length) {
    const first = queue[0];
    shown.set(first.index, sectionHead(first.body, maxChars - used));
    partial = first.path;
  }

  return {
    diff: sections
      .filter((section) => !section.isFile || shown.has(section.index))
      .map((section) => (section.isFile ? shown.get(section.index) : section.body))
      .join(''),
    truncated: true,
    included: files.filter((section) => shown.has(section.index)).map((section) => section.path),
    omitted: files.filter((section) => !shown.has(section.index)).map((section) => section.path),
    partial,
  };
}

/** The line closing a cut diff. It names every file it left out. */
function truncatedLine(maxChars, fit) {
  let line = `[... diff truncated at ${maxChars} chars`;
  if (fit.partial) line += `; ${fit.partial} is cut short`;
  if (fit.omitted.length) {
    line +=
      `; ${fit.omitted.length} file(s) left out of this prompt and not reviewed here ` +
      `(production code goes first, then tests, then docs): ${fit.omitted.join(', ')}`;
  }
  return `${line} ...]`;
}

/**
 * Make sure the base ref exists locally before diffing against it.
 *
 * `actions/checkout` gives the runner the PR head; the base branch is not
 * necessarily present as a remote-tracking ref. Previously this was a shell
 * step in every consumer's workflow, which meant every consumer could get it
 * wrong. Failures are swallowed: the ref may already be there, or the runner
 * may be offline in a test.
 *
 * @param {string} repo
 * @param {string} base  Ref name, with or without an `origin/` prefix.
 */
export function ensureBaseRef(repo, base) {
  const branch = base.replace(/^origin\//, '');
  try {
    git(repo, [
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the diff context for a check.
 *
 * @param {object} opts
 * @param {string} [opts.repo='.']
 * @param {string} opts.base       Base ref, e.g. `origin/develop`.
 * @param {string} [opts.head='HEAD']
 * @param {number} [opts.maxChars]
 * @returns {{
 *   stat: string, diff: string, fullDiff: string, block: string, empty: boolean,
 *   truncated: boolean, totalChars: number, totalFiles: number,
 *   includedFiles: number, omittedFiles: number, omittedPaths: string[],
 *   partialPath: string|null, exemptFiles: string[], exemptChars: number
 * }}
 *
 * `diff` is what the prompt shows, within the budget. `fullDiff` is the whole
 * reviewable diff, uncut, for the deterministic passes (symbols, duplication,
 * coverage), which must not depend on how much of the branch fit the prompt.
 * `totalChars` is the size of the reviewable diff before the cut. `omittedPaths`
 * names every file the cut left out; the diff body closes with the same list.
 */
export function buildDiff({ repo = '.', base, head = 'HEAD', maxChars = DEFAULT_MAX_DIFF_CHARS } = {}) {
  if (!base) throw new DiffError('buildDiff requires a base ref');

  let stat;
  let diff;
  try {
    // Three-dot: changes the PR introduces relative to the merge base, not
    // changes that happened on the base branch meanwhile.
    // Full paths: the default stat abbreviates long ones to `.../Services/X.cs`,
    // and the file list read from it decides which scoped rules apply.
    stat = git(repo, ['diff', '--stat=10000', '--stat-graph-width=20', `${base}...${head}`]).trim();
    diff = git(repo, ['diff', `${base}...${head}`]);
  } catch (err) {
    const tooLarge = isTooLargeError(err);
    throw new DiffError(
      tooLarge
        ? `El diff entre ${base} y ${head} excede el máximo que se puede leer (64 MB). ` +
          'Divide el PR en cambios más pequeños.'
        : `git diff ${base}...${head} failed: ${err.message}`,
      { contentFailure: tooLarge },
    );
  }

  const empty = diff.trim().length === 0;
  const totalFiles = countStatFiles(stat);

  const { reviewable, exempt } = splitBudgetExempt(diff);
  diff = reviewable;
  const fullDiff = reviewable;
  const totalChars = diff.length;

  // Whole files, production first, so the model never sees half a hunk and
  // reasons about code that isn't there, and never loses a service to a doc.
  const fit = fitDiffToBudget(diff, maxChars);
  const truncated = fit.truncated;
  diff = fit.diff;
  if (truncated) diff += `${diff && !diff.endsWith('\n') ? '\n' : ''}\n${truncatedLine(maxChars, fit)}`;

  const includedFiles = truncated ? fit.included.length : Math.max(0, totalFiles - exempt.length);
  if (exempt.length) diff += `${diff && !diff.endsWith('\n') ? '\n' : ''}\n${exemptLine(exempt)}`;

  return {
    stat,
    diff,
    fullDiff,
    block: empty ? '(empty — the branch has no changes vs base)' : '```diff\n' + diff + '\n```',
    empty,
    truncated,
    totalChars,
    totalFiles,
    includedFiles,
    omittedFiles: Math.max(0, totalFiles - includedFiles - exempt.length),
    omittedPaths: fit.omitted,
    partialPath: fit.partial,
    exemptFiles: exempt.map((entry) => entry.path),
    exemptChars: exempt.reduce((sum, entry) => sum + entry.chars, 0),
  };
}

/**
 * Human-readable note about truncation, for the PR comment (AC-6).
 * Returns null when nothing was cut.
 */
export function truncationNote(diffCtx) {
  if (!diffCtx.truncated) return null;
  const omitted = diffCtx.omittedFiles;
  const scope =
    omitted > 0
      ? `${omitted} de ${diffCtx.totalFiles} archivos quedaron fuera`
      : 'el último archivo quedó incompleto';
  const exempt = diffCtx.exemptFiles?.length
    ? ` Antes del recorte se apartaron ${diffCtx.exemptFiles.length} archivo(s) generados, lockfiles o snapshots.`
    : '';
  return `Diff truncado en ${diffCtx.diff.length} de ${diffCtx.totalChars} caracteres: ${scope}. La revisión es parcial.${exempt}`;
}
