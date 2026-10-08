// Which symbols does this pull request introduce or touch?
//
// `symbolsFromDiff` reads the added lines of the diff — not the whole
// repository — because the tests check asks what public surface the change
// brings in, and because it keeps the work proportional to the size of the pull
// request. `symbolsFromSource` and `spanChange` answer the duplication check's
// question instead: which functions, of any scope, did the change reach.
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
 * Walk a unified diff, reporting every line with the number it has on the new
 * side.
 *
 * Reads the unified diff directly rather than re-reading files from disk, so
 * the numbers line up with what the reviewer sees in the pull request.
 *
 * @param {string} diffText
 * @param {(path: string, type: 'added'|'removed', line: number, text: string) => void} visit
 *   `line` is the new-side number of an added line; for a removed line, the
 *   new-side number of the line that now stands where it was
 */
function walkDiff(diffText, visit) {
  let path = null;
  let lineNumber = 0;
  let inHunk = false;

  for (const raw of String(diffText || '').split('\n')) {
    // A new file's diff begins. Everything about the previous one is stale,
    // including whether we were reading its hunks.
    if (raw.startsWith('diff --git ')) {
      path = null;
      inHunk = false;
      continue;
    }

    // A `+++ b/…` line is only a file header before the first hunk. Inside a
    // hunk the same shape is an *added line* whose content happens to be
    // `++ b/…`, which the author writes. Trusting it there let a pull request
    // point the parser at dev/null and drop every symbol the file introduced,
    // green-skipping the blocking checks that read them.
    const fileHeader = inHunk ? null : raw.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) {
      path = fileHeader[1] === 'dev/null' ? null : fileHeader[1];
      continue;
    }

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      inHunk = true;
      continue;
    }

    if (!path) continue;

    if (raw.startsWith('+')) {
      visit(path, 'added', lineNumber, raw.slice(1));
      lineNumber += 1;
    } else if (raw.startsWith('-')) {
      // Removed lines do not advance the counter on the new side of the diff.
      if (inHunk) visit(path, 'removed', lineNumber, raw.slice(1));
    } else if (raw.startsWith('\\')) {
      // The "no newline" marker is not a line on either side.
    } else if (raw.startsWith(' ')) {
      lineNumber += 1;
    }
  }
}

/**
 * Added lines per file, with the line numbers they will have afterwards.
 *
 * @param {string} diffText
 * @returns {Map<string, Array<{line: number, text: string}>>}
 */
export function addedLinesByFile(diffText) {
  const byFile = new Map();

  walkDiff(diffText, (path, type, line, text) => {
    if (type !== 'added') return;
    const list = byFile.get(path) ?? [];
    list.push({ line, text });
    byFile.set(path, list);
  });

  return byFile;
}

/**
 * The lines a diff touches in each file, on the new side.
 *
 * `added` holds the numbers of added lines. `removed` holds, for each removed
 * line, the number of the line that now stands where it was: a deletion inside
 * a function changes that function even though nothing was added to it.
 *
 * @param {string} diffText
 * @returns {Map<string, {added: Set<number>, removed: Set<number>}>}
 */
export function changedLinesByFile(diffText) {
  const byFile = new Map();

  walkDiff(diffText, (path, type, line) => {
    let entry = byFile.get(path);
    if (!entry) {
      entry = { added: new Set(), removed: new Set() };
      byFile.set(path, entry);
    }
    entry[type].add(line);
  });

  return byFile;
}

/**
 * How a diff touched a symbol, judged by its span.
 *
 * `added` when its declaration line is an added line: a new symbol, or one
 * whose signature was rewritten. `modified` when the declaration stands but a
 * line inside its span was added, or one was removed from inside it. null when
 * the diff does not reach it.
 *
 * Asking only about the declaration line, as this used to, missed the change
 * that matters most for duplication: a function that already existed and was
 * rewritten into a copy of another one.
 *
 * @param {{line: number, span?: [number, number]}} symbol
 * @param {{added: Set<number>, removed: Set<number>}|undefined} changes for the symbol's file
 * @returns {'added'|'modified'|null}
 */
export function spanChange(symbol, changes) {
  if (!changes) return null;

  const start = Number(symbol.line);
  const rawEnd = Array.isArray(symbol.span) ? Number(symbol.span[1]) : start;
  const end = Math.max(start, Number.isFinite(rawEnd) ? rawEnd : start);

  if (changes.added.has(start)) return 'added';

  for (const line of changes.added) {
    if (line > start && line <= end) return 'modified';
  }

  // A removed line is anchored on the line that follows it, so one removed
  // right before the declaration anchors ON the declaration and is not inside.
  for (const line of changes.removed) {
    if (line > start && line <= end) return 'modified';
  }

  return null;
}

/**
 * Every symbol in a whole file, each with its scope, container and span.
 *
 * Unlike `symbolsFromDiff` this reads every scope, and it reads the file as it
 * is, so nesting — a method in its class, a helper in its composable — comes
 * out right.
 *
 * @param {string} path
 * @param {string} content
 * @returns {Array<object>}
 */
export function symbolsFromSource(path, content) {
  const extractor = extractorFor(path);
  if (!extractor) return [];

  const numbered = String(content ?? '')
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }));

  return extractor(numbered, path).map((symbol) => withDefaults(symbol, path));
}

/**
 * Fill in the fields an extractor that predates them does not set.
 *
 * The PHP extractor reports only what it always did: an exported symbol, or a
 * protected one, with no nesting.
 */
export function withDefaults(symbol, path) {
  return {
    ...symbol,
    path,
    scope: symbol.scope ?? (symbol.exported ? 'exported' : 'protected'),
    container: symbol.container ?? null,
    span: Array.isArray(symbol.span) ? symbol.span : [symbol.line, symbol.line],
  };
}

/**
 * Public symbols introduced by a diff.
 *
 * @param {string} diffText
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean,
 *   path: string, scope: string, container: string|null, span: [number, number]}>}
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
      if (symbol.exported) out.push(withDefaults(symbol, path));
    }
  }

  return out;
}
