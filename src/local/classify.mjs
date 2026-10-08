// What each changed file is, and how many production lines the change adds.
//
// PROD_LINES decides how much review a change gets, so what counts as
// production is a policy and it lives in one table. Tests, generated output,
// lockfiles, prose, locale catalogues and pure stylesheets are left out: a
// thousand-line snapshot update is not a thousand lines of logic to review.

import { categorize } from '../context/categories.mjs';
import { gitRun } from './git.mjs';

// The category table lives in context/categories.mjs, shared with the diff
// budget; re-exported here for the callers that always imported it from here.
export { categorize };

/** Split a `-z` listing into its NUL-separated fields, dropping the trailing empty one. */
function fields(text) {
  const out = String(text || '').split('\0');
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Per-file status between two commits, renames resolved to their destination.
 *
 * @returns {Map<string, {status: string, oldPath: string|null}>}
 */
function nameStatus(repo, from, to) {
  const parts = fields(gitRun(repo, ['diff', '--name-status', '-z', '-M', from, to]).stdout);
  const out = new Map();

  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const letter = code.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      out.set(path, { status: letter, oldPath });
    } else {
      const path = parts[i++];
      out.set(path, { status: letter, oldPath: null });
    }
  }
  return out;
}

/**
 * Added and deleted lines per file, ignoring whitespace-only changes.
 *
 * @returns {Map<string, {added: number, deleted: number, binary: boolean}>}
 */
function numstat(repo, from, to) {
  const parts = fields(gitRun(repo, ['diff', '--numstat', '-z', '-w', '-M', from, to]).stdout);
  const out = new Map();

  for (let i = 0; i < parts.length; ) {
    const [added, deleted, path] = parts[i++].split('\t');
    // A rename prints an empty path followed by the old and new paths as
    // separate fields.
    let target = path;
    if (!path) {
      i += 1; // old path
      target = parts[i++];
    }
    const binary = added === '-' || deleted === '-';
    out.set(target, {
      added: binary ? 0 : Number(added) || 0,
      deleted: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return out;
}

/**
 * Every file changed between two commits, classified and counted.
 *
 * @param {string} repo
 * @param {string} from  Older commit (the merge-base, or `--since`).
 * @param {string} to    Newer commit (HEAD).
 * @returns {{
 *   files: Array<{path: string, status: string, oldPath: string|null,
 *                 added: number, deleted: number, binary: boolean, category: string}>,
 *   prodLines: number,
 *   counts: object
 * }}
 */
export function classifyRange(repo, from, to) {
  const statuses = nameStatus(repo, from, to);
  const lines = numstat(repo, from, to);

  const files = [];
  for (const [path, info] of statuses) {
    const count = lines.get(path) ?? { added: 0, deleted: 0, binary: false };
    files.push({
      path,
      status: info.status,
      oldPath: info.oldPath,
      added: count.added,
      deleted: count.deleted,
      binary: count.binary,
      category: categorize(path),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const byCategory = {};
  let prodLines = 0;
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    byCategory[file.category] = (byCategory[file.category] ?? 0) + 1;
    added += file.added;
    deleted += file.deleted;
    if (file.category === 'prod') prodLines += file.added;
  }

  return {
    files,
    prodLines,
    counts: {
      files: files.length,
      prodFiles: byCategory.prod ?? 0,
      addedLines: added,
      deletedLines: deleted,
      byCategory,
    },
  };
}
