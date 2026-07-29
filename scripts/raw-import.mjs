// Containment rule for the `?raw` imports that scripts/build.mjs inlines.
//
// The plugin exists so a check's prompt stays editable Markdown and still ends
// up inside a committed bundle. Without a rule the specifier alone decides
// which file is read: `../../../.env?raw`, or an absolute path, resolves out of
// the repository and the build inlines that file verbatim into a bundle that is
// committed to a public repository. The person who leaks is whoever runs
// `npm run build` — exactly what the documentation tells a maintainer to do
// when CI reports a stale bundle — and the diff is collapsed by
// `linguist-generated`, so nobody reads it.
//
// So the resolver decides, not the specifier: the target must live inside the
// repository and be Markdown under src/checks/. Anything else is a build error.
// The allowlist is deliberately tighter than "inside the repository": .env and
// .git/config sit inside the root and are precisely the files worth inlining.

import { isAbsolute, relative, resolve, sep } from 'node:path';

/** The only directory a `?raw` import may read from, repo-relative and POSIX. */
const RAW_ROOT = 'src/checks';

/** The only extension a `?raw` import may read. */
const RAW_EXTENSION = '.md';

/** Build errors name the specifier and the rule; never a machine-local path. */
function refusal(specifier, why) {
  return (
    `raw-text: refusing to inline "${specifier}" — ${why}. A ?raw import may only read ` +
    `${RAW_EXTENSION} files under ${RAW_ROOT}/, so a build can never inline a file that ` +
    `is not committed prose.`
  );
}

/**
 * Resolve a `?raw` specifier to a repo-relative POSIX path.
 *
 * The path is repo-relative, not absolute, because esbuild writes the module
 * path into the bundle as a comment: an absolute one would publish the author's
 * local directory layout and make the build unreproducible across machines.
 *
 * @param {string} specifier import specifier, with or without the `?raw` suffix
 * @param {string} resolveDir absolute directory the specifier is relative to
 * @param {string} root absolute repository root
 * @returns {string} repo-relative POSIX path of the file to inline
 * @throws {Error} if the specifier resolves anywhere else
 */
export function resolveRawImport(specifier, resolveDir, root) {
  const target = resolve(resolveDir, specifier.replace(/\?raw$/, ''));
  const rel = relative(root, target);

  // `relative()` reports an out-of-root target with leading parent segments,
  // and an unrelated Windows drive as an absolute path. Compare whole segments
  // rather than string prefixes: /srv/repo-secrets starts with /srv/repo
  // without being inside it.
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(refusal(specifier, 'it resolves outside the repository'));
  }

  const path = rel.split(sep).join('/');

  if (!path.startsWith(`${RAW_ROOT}/`) || !path.endsWith(RAW_EXTENSION)) {
    throw new Error(refusal(specifier, `it resolves to "${path}"`));
  }

  return path;
}
