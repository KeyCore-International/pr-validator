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
 *
 * With a document-frequency table (`buildDocumentFrequency`) the overlap is
 * weighted, so a window that half the repository shares counts for less than
 * one only these two bodies share. Without one it is plain Jaccard, exactly as
 * before the table existed.
 */
export function bodySimilarity(a, b, table = null) {
  const left = normalizeBody(a);
  const right = normalizeBody(b);

  if (left.length < MIN_TOKENS || right.length < MIN_TOKENS) return 0;

  // Jaccard here, not overlap: a body that merely CONTAINS another's shape is
  // usually the bigger routine doing more, not a copy of it.
  return weightedJaccard(shingles(left), shingles(right), table);
}

/** The shortest body, in skeleton tokens, that has a shape worth comparing. */
export const MIN_BODY_TOKENS = MIN_TOKENS;

// ---------------------------------------------------------------------------
// Inverse document frequency over the shingles.
//
// Some windows are in every function of a repository: `) { return X` and its
// friends. Two bodies sharing them share nothing that says "copy". Weighting
// each shingle by how rare it is across the indexed functions lets the
// distinctive part of a body decide, which is what a reviewer would look at.
// ---------------------------------------------------------------------------

/**
 * Below this many documents a frequency is noise, not evidence: in a tiny
 * index two functions sharing a window is already "10 % of the repository".
 * Every shingle then weighs 1 and the score is plain Jaccard.
 */
export const IDF_MIN_DOCUMENTS = 20;

/** A shingle found in more than this share of the OTHER functions is down-weighted. */
export const COMMON_SHINGLE_RATE = 0.05;

function defaultShinglesOf(symbol) {
  return shingles(normalizeBody(symbol?.body ?? ''));
}

/**
 * How many indexed functions contain each shingle.
 *
 * @param {Array<object>} symbols the index, each with a `body`
 * @param {(symbol: object) => Set<string>} [shinglesOf] reuse a caller's cache
 * @returns {{documents: number, counts: Map<string, number>}}
 */
export function buildDocumentFrequency(symbols = [], shinglesOf = defaultShinglesOf) {
  const counts = new Map();
  let documents = 0;

  for (const symbol of symbols) {
    const set = shinglesOf(symbol);
    if (!set || !set.size) continue;
    documents += 1;
    for (const shingle of set) counts.set(shingle, (counts.get(shingle) ?? 0) + 1);
  }

  return { documents, counts };
}

/**
 * The weight of one shingle, 0..1.
 *
 * Its frequency is counted among the OTHER documents — the one holding it is
 * taken off — so a window shared only by the pair under comparison is never
 * down-weighted by that pair itself. Up to the common rate it weighs 1; past
 * it the weight falls with the log of the rarity and reaches 0 only for a
 * shingle in every document, which cannot happen once one is taken off.
 *
 * The weight depends on the shingle and the table alone, never on the pair, so
 * a body's total weight can be computed once and bounds every pair it is in.
 */
export function shingleWeight(shingle, table) {
  if (!table || table.documents < IDF_MIN_DOCUMENTS) return 1;

  const others = Math.max(0, (table.counts.get(shingle) ?? 0) - 1);
  const rate = others / table.documents;
  if (rate <= COMMON_SHINGLE_RATE) return 1;

  return Math.log(1 / rate) / Math.log(1 / COMMON_SHINGLE_RATE);
}

/** Sum of the weights of a shingle set. */
export function totalWeight(set, table) {
  if (!table || table.documents < IDF_MIN_DOCUMENTS) return set.size;

  let total = 0;
  for (const shingle of set) total += shingleWeight(shingle, table);
  return total;
}

/**
 * Weighted Jaccard of two shingle sets, 0..1. Plain Jaccard without a table.
 *
 * Bounded above by min(W)/max(W) of the two sets' total weights — the shared
 * part weighs at most the lighter set, the union at least the heavier one —
 * which is what lets the scoring pre-filter rule a pair out without scoring it.
 */
export function weightedJaccard(left, right, table = null) {
  if (!left.size || !right.size) return 0;

  if (!table || table.documents < IDF_MIN_DOCUMENTS) {
    let shared = 0;
    for (const shingle of left) if (right.has(shingle)) shared += 1;
    return shared / (left.size + right.size - shared);
  }

  let shared = 0;
  let union = 0;
  for (const shingle of left) {
    const weight = shingleWeight(shingle, table);
    union += weight;
    if (right.has(shingle)) shared += weight;
  }
  for (const shingle of right) {
    if (!left.has(shingle)) union += shingleWeight(shingle, table);
  }

  return union > 0 ? shared / union : 0;
}

// ---------------------------------------------------------------------------
// Vocabulary: the APIs a body talks to.
//
// The skeleton erases every name on purpose, which is what makes it survive a
// rename — and also what makes two unrelated routines with the same control
// flow look identical. What a body CALLS survives a rename too: whoever copies
// a currency formatter still calls `Intl.NumberFormat`, and whoever copies a
// date formatter still calls `padStart` and `getFullYear`. So the members,
// callees and constructors a body names are compared as a second, independent
// signal.
// ---------------------------------------------------------------------------

/**
 * Comments out, strings and regular-expression literals reduced to markers,
 * newlines kept so line-based measures still line up.
 *
 * A single linear pass rather than a chain of patterns: a body is somebody
 * else's source, and an unclosed comment or a run of escaped quotes must not
 * cost more than one walk over the text. JavaScript and C# share enough
 * lexical rules for this to serve both: `//` and block comments, single,
 * double and template quotes, C# verbatim strings (`@"…"` with `""` escapes).
 * A single- or double-quoted string ends at the end of its line whatever
 * happens, so an apostrophe in JSX text spoils one line, never the rest.
 *
 * @param {string} text
 * @returns {{code: string, regexLiterals: number}}
 */
export function stripCode(text) {
  const src = String(text || '').slice(0, MAX_BODY_CHARS);
  const out = [];
  let regexLiterals = 0;
  let last = ''; // last significant character emitted
  let word = ''; // identifier being emitted
  let lastWord = ''; // last complete identifier

  const emit = (chunk, significant) => {
    out.push(chunk);
    if (significant) last = significant;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (/[\w$]/.test(c)) {
      word += c;
      emit(c, c);
      i += 1;
      continue;
    }
    if (word) {
      lastWord = word;
      word = '';
    }

    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j += 1;
      emit(' ', null);
      i = j;
      continue;
    }

    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      const lines = countNewlines(src, i, stop);
      emit(lines ? '\n'.repeat(lines) : ' ', null);
      i = stop;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      const verbatim = c === '"' && (src[i - 1] === '@' || (src[i - 1] === '$' && src[i - 2] === '@'));
      let j = i + 1;
      let lines = 0;
      while (j < src.length) {
        const ch = src[j];
        if (!verbatim && ch === '\\') {
          j += 2;
          continue;
        }
        if (verbatim && ch === '"' && src[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (ch === c) {
          j += 1;
          break;
        }
        if (ch === '\n') {
          if (c !== '`' && !verbatim) break;
          lines += 1;
        }
        j += 1;
      }
      emit(`""${'\n'.repeat(lines)}`, '"');
      i = j;
      continue;
    }

    if (c === '/' && regexMayStart(last, lastWord)) {
      const end = regexEnd(src, i);
      if (end !== -1) {
        regexLiterals += 1;
        emit(' __regex__ ', '_');
        i = end;
        continue;
      }
    }

    emit(c, /\s/.test(c) ? null : c);
    i += 1;
  }

  return { code: out.join(''), regexLiterals };
}

function countNewlines(src, from, to) {
  let lines = 0;
  for (let k = from; k < to; k += 1) if (src[k] === '\n') lines += 1;
  return lines;
}

/** Keywords after which a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'yield', 'await', 'void', 'delete', 'throw']);

/**
 * Can a `/` here start a regular-expression literal?
 *
 * After an operand (`a / b`) it divides; after punctuation that expects an
 * operand it opens a regex. `<` is left out on purpose: `</div>` is JSX, not
 * a regex, and `>` and `}` are left out because they close things far more
 * often than they precede a literal.
 */
function regexMayStart(last, lastWord) {
  if (last === '') return true;
  if (/[\w$]/.test(last)) return REGEX_AFTER_WORD.has(lastWord);
  return '(,=:[!&|?{;+-*%~^'.includes(last);
}

/** Index just past a regex literal starting at `start`, or -1 when it is not one. */
function regexEnd(src, start) {
  let inClass = false;
  for (let j = start + 1; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '\n') return -1;
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      if (j === start + 1) return -1; // `//` is a comment, handled before
      let k = j + 1;
      while (k < src.length && /[a-z]/.test(src[k])) k += 1;
      return k;
    }
  }
  return -1;
}

/**
 * Objects whose members are an API rather than somebody's data. A call on one
 * of them is kept with its owner — `intl.numberformat`, `math.round`,
 * `string.join` — because the owner is what says which API it is.
 */
const KNOWN_GLOBALS = new Set([
  'intl',
  'math',
  'mathf',
  'date',
  'json',
  'number',
  'object',
  'array',
  'string',
  'console',
  'promise',
  'reflect',
  'symbol',
  'datetime',
  'datetimeoffset',
  'dateonly',
  'timeonly',
  'timespan',
  'timezoneinfo',
  'cultureinfo',
  'convert',
  'regex',
  'guid',
  'enumerable',
  'decimal',
  'encoding',
  'moment',
  'dayjs',
  'window',
  'document',
  'localstorage',
  'sessionstorage',
  'url',
  'urlsearchparams',
  'buffer',
  'crypto',
]);

/** Words a call pattern matches that are language, not vocabulary. */
const NOT_CALLEES = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'typeof',
  'await',
  'new',
  'sizeof',
  'nameof',
  'using',
  'lock',
  'base',
  'this',
  'super',
  'constructor',
  'async',
  'yield',
  'throw',
  'when',
  'with',
  'fixed',
  'checked',
  'unchecked',
  'default',
  'in',
  'of',
  'and',
  'or',
  'not',
]);

/**
 * The names a body uses: members, callees, constructors and known globals.
 *
 * Lowercased, so `string.Join` in C# and `.join` in TypeScript meet. Local
 * variables are left out — they are what a copy renames — and so is the
 * symbol's own name, which appears in its declaration line and would make
 * every renamed copy disagree with the original.
 *
 * @param {string} body
 * @param {{exclude?: Array<string>}} [opts]
 * @returns {Set<string>}
 */
export function vocabulary(body, { exclude = [] } = {}) {
  const { code } = stripCode(body);
  const skip = new Set(exclude.filter(Boolean).map((name) => String(name).toLowerCase()));
  const out = new Set();
  const add = (word) => {
    const lower = word.toLowerCase();
    if (!skip.has(lower) && !NOT_CALLEES.has(lower)) out.add(lower);
  };

  // Member chains: `a.b.c`, `a?.b`. The root is somebody's variable unless it
  // is a known global; the members after it are API either way.
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)+/g)) {
    const parts = match[0].split('.').map((part) => part.replace(/[\s?]/g, ''));
    // `foo().bar.baz`: the chain starts after `).`, so its first part is a
    // member too, not a root.
    let k = match.index - 1;
    while (k >= 0 && /[\s?]/.test(code[k])) k -= 1;
    const afterDot = code[k] === '.';
    const [root, ...members] = parts;

    if (afterDot) {
      add(root);
    } else if (KNOWN_GLOBALS.has(root.toLowerCase())) {
      add(root);
      if (members[0]) out.add(`${root}.${members[0]}`.toLowerCase());
    }
    for (const member of members) add(member);
  }

  // Callees, generic ones included: `format(`, `Parse<T>(`.
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?:<[^<>()]{0,200}>)?\s*\(/g)) {
    add(match[1]);
  }

  // Constructors: `new Intl.NumberFormat(`, `new Date(`.
  for (const match of code.matchAll(/\bnew\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
    const parts = match[1].split('.');
    for (const part of parts) {
      if (part === parts[0] && parts.length > 1 && !KNOWN_GLOBALS.has(part.toLowerCase())) continue;
      add(part);
    }
  }

  return out;
}

/**
 * Overlap of two vocabularies, 0..1 (Jaccard).
 *
 * Two empty vocabularies score 0 here: there is nothing to agree on. Whether
 * that should block a strong skeleton is the scorer's call, not this one's.
 */
export function vocabularySimilarity(left, right) {
  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}
