// What kind of files does this pull request touch?
//
// Checks that review code have nothing to say about a change that only edits
// prose, and spending a model call on it is a cost every consuming repository
// pays on every documentation PR.
//
// The classification reads the diff STAT rather than the diff body, because the
// body is subject to a truncation budget: whether a pull request touches code
// at all must not depend on how much of it fit in the prompt.
//
// This module also owns the guard every context applies before reading a file
// off disk — see `isRegularFileWithin`.

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Is `path` a regular file that really lives inside `root`?
 *
 * Every file this validator reads off disk comes from a tree the pull request
 * can rewrite, and what it reads ends up in a prompt sent to an external
 * gateway. A rule file replaced by a symlink to `.git/config` would publish the
 * checkout credential; one pointing outside the checkout would publish whatever
 * the runner can read.
 *
 * Two conditions, and both are load-bearing:
 *
 *   - `lstat` — never `stat`, which follows the link and reports the target —
 *     must report a REGULAR file, so a symlink is refused whatever it points
 *     at. Refusing only the links that escape the repository is not enough:
 *     `.git/config` is inside it.
 *   - the real path must stay inside the real `root`, which is what catches a
 *     symlinked DIRECTORY whose entries then look local.
 *
 * Never throws. A missing, unreadable, dangling or looping path is `false`:
 * callers already treat "cannot read this" as "not part of the corpus", and an
 * exception raised here would surface as a tool error instead.
 *
 * @param {string} path
 * @param {string} root
 * @returns {boolean}
 */
export function isRegularFileWithin(path, root) {
  try {
    if (!lstatSync(path).isFile()) return false;

    // Both sides resolved: a checkout that itself sits under a symlinked
    // directory must not read as an escape from its own root.
    const relativePath = relative(realpathSync(root), realpathSync(path));

    // Component-wise. A `startsWith(root)` test would accept `/srv/repo-secrets`
    // for a root of `/srv/repo`.
    return (
      relativePath !== '' &&
      !isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`)
    );
  } catch {
    return false;
  }
}

/**
 * Extensions that are not code.
 *
 * Deliberately short. Everything else counts as code — YAML, JSON, Terraform,
 * Dockerfiles, SQL, lockfiles and shell scripts included. Infrastructure and
 * configuration are exactly where embedded secrets and wrong permissions live,
 * and treating them as prose would leave the most dangerous files unreviewed.
 */
const NON_CODE_EXTENSION =
  /\.(md|markdown|txt|rst|adoc|png|jpe?g|gif|svg|webp|ico|bmp|pdf|woff2?|ttf|eot|mp4|mov|zip|gz)$/i;

/** Files that are not code even though they carry no extension at all. */
const NON_CODE_NAME = /^(LICENSE|NOTICE|AUTHORS|CODEOWNERS|\.gitattributes|\.gitignore)$/i;

/**
 * Pull the file paths out of a `git diff --stat` block.
 *
 * Handles the rename form git emits — `src/{a => b}.cs` — by keeping the
 * destination, which is the file that actually exists afterwards.
 *
 * @returns {string[]}
 */
export function filesFromStat(stat) {
  const out = [];

  for (const line of String(stat || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /\bfiles?\s+changed\b/.test(trimmed)) continue;

    const separator = trimmed.lastIndexOf('|');
    if (separator === -1) continue;

    let path = trimmed.slice(0, separator).trim();
    if (!path) continue;

    const rename = path.match(/^(.*)\{.*=>\s*(.*?)\}(.*)$/);
    if (rename) path = `${rename[1]}${rename[2]}${rename[3]}`.replace(/\/{2,}/g, '/');

    out.push(path.trim());
  }

  return out;
}

/** Is this path something a code reviewer would have an opinion about? */
export function isCodeFile(path) {
  const name = String(path || '').split('/').pop() ?? '';
  if (!name) return false;
  if (NON_CODE_NAME.test(name)) return false;
  return !NON_CODE_EXTENSION.test(name);
}

/**
 * Split the files a diff touches into code and everything else.
 *
 * @param {{stat?: string}} diffCtx
 * @returns {{files: string[], code: string[], nonCode: string[], hasCode: boolean}}
 */
export function classifyDiffFiles(diffCtx) {
  const files = filesFromStat(diffCtx?.stat);
  const code = files.filter(isCodeFile);

  return {
    files,
    code,
    nonCode: files.filter((path) => !isCodeFile(path)),
    // An empty diff has no code, but it is already short-circuited earlier as
    // "no changes"; saying `false` here keeps this function honest either way.
    hasCode: code.length > 0,
  };
}
