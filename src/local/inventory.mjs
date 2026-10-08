// `inventory`: what the helper and primitive directories already offer.
//
// "Search before creating" only works if the search is cheap and complete, so
// this lists every exported symbol under the given directories with its
// signature — never its body. A reviewer reads the list, not the files.

import { matchesAny } from '../context/rules.mjs';
import { buildSymbolIndex } from '../context/symbol-index.mjs';
import { compact } from './json.mjs';
import { UsageError } from './errors.mjs';
import { topLevel } from './git.mjs';

/** `src/utils` or `src/**\/utils` → a glob that matches everything below it. */
function dirGlob(dir) {
  const clean = String(dir).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return `${clean}/**`;
}

/**
 * @param {object} opts
 * @param {string} opts.repo
 * @param {string[]} opts.dirs  Repository-relative directories; globs allowed.
 * @returns {{dirs: string[], fileCount: number, truncated: boolean, symbols: Array<object>}}
 */
export function buildInventory({ repo: repoArg, dirs }) {
  if (!dirs?.length) throw new UsageError('inventory needs --dirs <dir>[,<dir>…]');
  const repo = topLevel(repoArg);
  const globs = dirs.map(dirGlob);
  const inside = (path) => globs.some((glob) => matchesAny([glob], [path]));

  const index = buildSymbolIndex({ repo, exclude: (path) => !inside(path) });

  const symbols = index.symbols
    // Only what a caller can import. An extractor that does not say is trusted
    // to have returned exported symbols only, as the original ones do.
    .filter((symbol) => symbol.exported !== false)
    .map((symbol) => compact(symbol))
    .sort((a, b) =>
      a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.line !== b.line ? a.line - b.line : a.name < b.name ? -1 : 1,
    );

  return {
    dirs: [...dirs].sort(),
    fileCount: index.fileCount,
    truncated: index.truncated,
    symbols,
  };
}
