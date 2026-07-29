// Do two symbols do the same thing?
//
// The strongest of the three signals and the only one that survives renaming.
// A body is normalised down to its control-flow skeleton — identifiers, literals
// and comments erased, keywords and operators kept — and then compared as a set
// of overlapping token windows.
//
// Erasing identifiers is the point. A developer who reimplements an existing
// routine names everything differently; what they cannot help repeating is the
// order of the ifs, the loops and the calls.

/** Words that shape control flow. Everything else becomes a placeholder. */
const KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'throw',
  'try',
  'catch',
  'finally',
  'new',
  'await',
  'yield',
  'null',
  'true',
  'false',
  'this',
  'self',
  'typeof',
  'instanceof',
  'in',
  'of',
  'as',
  'is',
]);

/** Window size for the shingles. Small enough to survive an inserted line. */
const SHINGLE = 4;

/** A body shorter than this has no shape worth comparing — `return x;` matches everything. */
const MIN_TOKENS = 8;

/**
 * Hard bound on the text normalised in one call.
 *
 * A body is other people's source, so its size is theirs to choose, and the
 * strippers below are not linear on hostile input: a block comment that never
 * closes, or a run of escaped quotes, makes every start offset scan to the end
 * of the string, which is quadratic in the length of the body.
 * `src/context/symbol-index.mjs` already keeps a body window well under this,
 * so the clamp never touches real code — it is here so no caller can hand the
 * patterns a string long enough for that cost to matter.
 */
const MAX_BODY_CHARS = 20_000;

/**
 * A body reduced to its skeleton.
 *
 * @param {string} body
 * @returns {string[]} tokens
 */
export function normalizeBody(body) {
  const stripped = String(body || '')
    .slice(0, MAX_BODY_CHARS)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/(^|\s)#[^\n]*/g, '$1 ') // PHP and shell-style comments
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "S" ')
    .replace(/'(?:[^'\\]|\\.)*'/g, ' "S" ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' "S" ')
    .replace(/\b\d[\d_.]*\b/g, ' 0 ');

  const tokens = [];
  // Identifiers, then operators and punctuation one character at a time.
  const pattern = /[A-Za-z_$][\w$]*|[{}()[\];,.=<>+\-*/%!&|?:]/g;

  for (const [match] of stripped.matchAll(pattern)) {
    if (/^[A-Za-z_$]/.test(match)) {
      const lower = match.toLowerCase();
      tokens.push(KEYWORDS.has(lower) ? lower : 'X');
    } else {
      tokens.push(match);
    }
  }

  return tokens;
}

/** Overlapping windows of the skeleton. */
export function shingles(tokens, size = SHINGLE) {
  const out = new Set();
  for (let i = 0; i + size <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + size).join(' '));
  }
  return out;
}

/**
 * Skeleton overlap between two bodies, 0..1.
 *
 * Returns 0 for anything too short to have a shape: a two-line accessor matches
 * every other two-line accessor in the repository, and reporting that as
 * duplication is how a check earns the right to be ignored.
 */
export function bodySimilarity(a, b) {
  const left = normalizeBody(a);
  const right = normalizeBody(b);

  if (left.length < MIN_TOKENS || right.length < MIN_TOKENS) return 0;

  const leftShingles = shingles(left);
  const rightShingles = shingles(right);

  if (!leftShingles.size || !rightShingles.size) return 0;

  let shared = 0;
  for (const shingle of leftShingles) if (rightShingles.has(shingle)) shared += 1;

  // Jaccard here, not overlap: a body that merely CONTAINS another's shape is
  // usually the bigger routine doing more, not a copy of it.
  return shared / (leftShingles.size + rightShingles.size - shared);
}
