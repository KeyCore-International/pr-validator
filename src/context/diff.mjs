// Diff context: what changed between the base branch and the PR head.
//
// Every AI check reads from here, so truncation is measured rather than
// silent. The previous generation of this tool cut the diff at a fixed budget
// and said nothing, which meant a large PR got a partial review that looked
// identical to a full one.

import { execFileSync } from 'node:child_process';

export const DEFAULT_MAX_DIFF_CHARS = 36000;

export class DiffError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiffError';
  }
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

/**
 * Count how many distinct files survive inside a (possibly truncated) diff
 * body, by counting `diff --git` headers.
 */
function countDiffFiles(diff) {
  const matches = diff.match(/^diff --git /gm);
  return matches ? matches.length : 0;
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
 *   stat: string, diff: string, block: string, empty: boolean,
 *   truncated: boolean, totalChars: number, totalFiles: number,
 *   includedFiles: number, omittedFiles: number
 * }}
 */
export function buildDiff({ repo = '.', base, head = 'HEAD', maxChars = DEFAULT_MAX_DIFF_CHARS } = {}) {
  if (!base) throw new DiffError('buildDiff requires a base ref');

  let stat;
  let diff;
  try {
    // Three-dot: changes the PR introduces relative to the merge base, not
    // changes that happened on the base branch meanwhile.
    stat = git(repo, ['diff', '--stat', `${base}...${head}`]).trim();
    diff = git(repo, ['diff', `${base}...${head}`]);
  } catch (err) {
    throw new DiffError(`git diff ${base}...${head} failed: ${err.message}`);
  }

  const totalChars = diff.length;
  const totalFiles = countStatFiles(stat);
  const empty = diff.trim().length === 0;

  let truncated = false;
  if (totalChars > maxChars) {
    // Cut on a file boundary when one exists inside the budget, so the model
    // never sees half a hunk and reasons about code that isn't there.
    const slice = diff.slice(0, maxChars);
    const boundary = slice.lastIndexOf('\ndiff --git ');
    diff = boundary > 0 ? slice.slice(0, boundary + 1) : slice;
    diff += `\n\n[... diff truncated at ${maxChars} chars ...]`;
    truncated = true;
  }

  const includedFiles = truncated ? countDiffFiles(diff) : totalFiles;

  return {
    stat,
    diff,
    block: empty ? '(empty — the branch has no changes vs base)' : '```diff\n' + diff + '\n```',
    empty,
    truncated,
    totalChars,
    totalFiles,
    includedFiles,
    omittedFiles: Math.max(0, totalFiles - includedFiles),
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
  return `Diff truncado en ${diffCtx.diff.length} de ${diffCtx.totalChars} caracteres: ${scope}. La revisión es parcial.`;
}
