// Which public symbols does this pull request introduce?
//
// Reads the added lines of the diff — not the whole repository — because the
// question is what the change brings in, and because it keeps the work
// proportional to the size of the pull request.
//
// A language with no extractor returns nothing. That is an honest omission
// rather than an error: the check reports on what it can read and stays quiet
// about the rest.

import { extract as csharp } from './csharp.mjs';
import { extract as typescript } from './typescript.mjs';
import { extract as vue } from './vue.mjs';
import { extract as php } from './php.mjs';

const EXTRACTORS = [
  [/\.cs$/i, csharp],
  [/\.vue$/i, vue],
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, typescript],
  [/\.php$/i, php],
];

/** The extractor for a path, or null when the language is not supported. */
export function extractorFor(path) {
  for (const [pattern, extractor] of EXTRACTORS) {
    if (pattern.test(String(path || ''))) return extractor;
  }
  return null;
}

/**
 * Added lines per file, with the line numbers they will have afterwards.
 *
 * Reads the unified diff directly rather than re-reading files from disk, so
 * the numbers line up with what the reviewer sees in the pull request.
 *
 * @param {string} diffText
 * @returns {Map<string, Array<{line: number, text: string}>>}
 */
export function addedLinesByFile(diffText) {
  const byFile = new Map();

  let path = null;
  let lineNumber = 0;

  for (const raw of String(diffText || '').split('\n')) {
    const fileHeader = raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) {
      path = fileHeader[1] === 'dev/null' ? null : fileHeader[1];
      continue;
    }

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }

    if (!path) continue;

    if (raw.startsWith('+')) {
      const list = byFile.get(path) ?? [];
      list.push({ line: lineNumber, text: raw.slice(1) });
      byFile.set(path, list);
      lineNumber += 1;
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // Removed lines and the "no newline" marker do not advance the counter
      // on the new side of the diff.
    } else if (raw.startsWith(' ')) {
      lineNumber += 1;
    }
  }

  return byFile;
}

/**
 * Public symbols introduced by a diff.
 *
 * @param {string} diffText
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean, path: string}>}
 */
export function symbolsFromDiff(diffText) {
  const out = [];

  for (const [path, lines] of addedLinesByFile(diffText)) {
    const extractor = extractorFor(path);
    if (!extractor) continue;

    for (const symbol of extractor(lines, path)) {
      // Only what the outside world can reach. A module-private helper is an
      // implementation detail, and demanding a test for it pushes people to
      // pin down things they should stay free to rename.
      if (symbol.exported) out.push({ ...symbol, path });
    }
  }

  return out;
}
