// Which existing symbols is a new one worth comparing against?
//
// Four deterministic signals combined into one number, a threshold, and a cap
// of five candidates per symbol. Only what clears the threshold reaches the
// model — which is the whole reason this check is affordable on every pull
// request instead of a nightly job.
//
// The weights say what we actually believe: what a routine DOES matters more
// than what it is called, and what it is called matters more than the types it
// happens to take. What it does is read twice — once as its control-flow
// skeleton, once as the vocabulary of APIs it calls — because the skeleton
// alone cannot tell a copied currency formatter from an unrelated function
// that happens to branch the same way.

import { nameSimilarity, tokenize } from './name.mjs';
import { normalizeSignature, signatureSimilarity } from './signature.mjs';
import {
  bodySimilarity,
  buildDocumentFrequency,
  normalizeBody,
  shingles,
  stripCode,
  totalWeight,
  vocabulary,
  vocabularySimilarity,
  weightedJaccard,
} from './body.mjs';
import { compileAllowPairs, isExcludedPath } from './exclusions.mjs';

export const DEFAULT_WEIGHTS = { name: 0.25, signature: 0.15, body: 0.45, vocabulary: 0.15 };

/** Below this a pair is not worth a model's attention. */
export const DEFAULT_THRESHOLD = 0.55;

/**
 * Bodies this alike are duplicates whatever the name and the signature say —
 * provided they also talk to the same APIs (see `VOCABULARY_AGREEMENT`).
 */
const STRONG_BODY = 0.8;

/**
 * The vocabulary overlap the body-only floor requires.
 *
 * A skeleton erases every name, so two routines that loop and accumulate look
 * identical whether they sum invoice lines or count retries. Requiring them to
 * share a third of their callees and members before the skeleton alone can
 * carry the pair is what separates a copy from a coincidence. Two bodies that
 * call nothing at all have no vocabulary to disagree on, and pass.
 */
export const VOCABULARY_AGREEMENT = 0.3;

/** Per symbol. More than five candidates is a prompt nobody reads. */
export const MAX_CANDIDATES = 5;

/**
 * The shortest body compared, by visibility, in skeleton tokens.
 *
 * An exported helper of eight tokens is still a contract somebody may have
 * re-implemented, and it is measured whole. A private or inner function is
 * held to sixteen tokens AFTER its declaration head (see `bodyTail`): the head
 * is the same in every function — `const X = ( ) : X = > {` is nine tokens on
 * its own — and measured with it, a one-statement handler cleared the floor and
 * then matched every other one-statement handler at 1.00. There are hundreds
 * of those in any repository.
 */
export const MIN_TOKENS_EXPORTED = 8;
export const MIN_TOKENS_PRIVATE = 16;

/**
 * What counts as reachable from outside its file, for the token floors and the
 * candidate caps. One definition for the scorer and the duplication context: a
 * public class method is public whether or not it sits in a class.
 */
export function isPublicSurface(symbol) {
  return Boolean(symbol?.exported) || symbol?.scope === 'public' || symbol?.scope === 'exported';
}

/** The token floor for a symbol. */
export function minTokensFor(symbol) {
  return isPublicSurface(symbol) ? MIN_TOKENS_EXPORTED : MIN_TOKENS_PRIVATE;
}

/**
 * Where the declaration head of a skeleton ends: just past the `{` or the `=>`
 * that follows the parameter list, at bracket depth 0. 0 when there is no
 * parameter list or nothing follows it — the whole skeleton is then the body.
 *
 * @param {string[]} tokens from `normalizeBody`
 */
export function headEnd(tokens) {
  const open = tokens.indexOf('(');
  if (open === -1) return 0;

  let depth = 0;
  let close = -1;
  for (let i = open; i < tokens.length; i += 1) {
    if (tokens[i] === '(') depth += 1;
    else if (tokens[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return 0;

  depth = 0;
  for (let i = close + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (depth === 0 && token === '{') return i + 1;
    if (depth === 0 && token === '=' && tokens[i + 1] === '>') return i + 2;
    if (token === '(' || token === '[') depth += 1;
    else if (token === ')' || token === ']') depth = Math.max(0, depth - 1);
  }
  return 0;
}

/** The skeleton of a body without its declaration head. */
export function bodyTail(tokens) {
  return tokens.slice(headEnd(tokens));
}

/** A symbol's skeleton, whole and past its head, cached per symbol. */
const skeletonCache = new WeakMap();

function skeletonFor(symbol) {
  const cached = skeletonCache.get(symbol);
  if (cached) return cached;
  const tokens = normalizeBody(symbol?.body ?? '');
  const computed = { tokens, tail: bodyTail(tokens) };
  skeletonCache.set(symbol, computed);
  return computed;
}

/** Skeleton tokens past the declaration head. */
export function tailTokensFor(symbol) {
  return skeletonFor(symbol).tail;
}

/**
 * Whether a symbol's body has enough shape to be compared at all. The one
 * predicate both the scorer and the duplication context apply.
 */
export function hasEnoughBody(symbol) {
  const { tokens, tail } = skeletonFor(symbol);
  return isPublicSurface(symbol) ? tokens.length >= MIN_TOKENS_EXPORTED : tail.length >= MIN_TOKENS_PRIVATE;
}

// Bodies are normalised once per symbol rather than once per pair. With a few
// thousand indexed symbols the difference is the check finishing in seconds
// instead of minutes.
const shingleCache = new WeakMap();

function shinglesFor(symbol) {
  const cached = shingleCache.get(symbol);
  if (cached) return cached;

  const computed = hasEnoughBody(symbol) ? shingles(skeletonFor(symbol).tokens) : new Set();
  shingleCache.set(symbol, computed);
  return computed;
}

// Name tokens, signature shape, vocabulary and shingle weight, like bodies,
// computed once per symbol instead of once per pair. `findDuplicates` walks the
// whole index for every symbol the pull request introduces, so anything
// recomputed inside that loop is paid a number of times equal to the product
// of the two.
const tokenCache = new WeakMap();
const signatureCache = new WeakMap();
const vocabularyCache = new WeakMap();
const weightCache = new WeakMap();

function tokensFor(symbol) {
  const cached = tokenCache.get(symbol);
  if (cached) return cached;
  const computed = new Set(tokenize(symbol.name ?? ''));
  tokenCache.set(symbol, computed);
  return computed;
}

function signatureFor(symbol) {
  const cached = signatureCache.get(symbol);
  if (cached) return cached;
  const computed = normalizeSignature(symbol.signature ?? '');
  signatureCache.set(symbol, computed);
  return computed;
}

function vocabularyFor(symbol) {
  const cached = vocabularyCache.get(symbol);
  if (cached) return cached;
  const computed = vocabulary(symbol.body ?? '', { exclude: [symbol.name] });
  vocabularyCache.set(symbol, computed);
  return computed;
}

/** Total shingle weight under a table, cached per (symbol, table). */
function weightFor(symbol, table) {
  const cached = weightCache.get(symbol);
  if (cached && cached.table === table) return cached.total;
  const total = totalWeight(shinglesFor(symbol), table);
  weightCache.set(symbol, { table, total });
  return total;
}

/**
 * Bodies read to build the document-frequency table. A frequency is a rate, and
 * a rate is as good from an even sample of this size as from the whole index;
 * reading all 120,000 bodies of an index at its ceiling took twice the budget.
 */
export const DF_SAMPLE = 20_000;

/** How many items a bounded loop handles between two looks at the clock. */
const CLOCK_EVERY = 256;

/**
 * The document-frequency table for an index, using the same shingles the
 * scorer compares — short bodies included as empty, so they do not count as
 * documents.
 *
 * Past `DF_SAMPLE` symbols an even stride of the index is read instead of all
 * of it, and with a `deadline` the reading stops when the clock passes it; the
 * table is then built from what was read.
 *
 * @param {Array<object>} index
 * @param {{deadline?: number|null, sample?: number}} [opts]
 */
export function documentFrequencyFor(index = [], { deadline = null, sample = DF_SAMPLE } = {}) {
  const stride = index.length > sample ? index.length / sample : 1;
  const picked = [];
  for (let k = 0; k < index.length && picked.length < sample; k += 1) {
    const at = Math.floor(k * stride);
    if (at >= index.length) break;
    picked.push(index[at]);
  }

  if (deadline === null) return buildDocumentFrequency(picked, shinglesFor);

  let read = 0;
  let stopped = false;
  const bounded = (symbol) => {
    if (stopped) return null;
    read += 1;
    if (read % CLOCK_EVERY === 0 && Date.now() >= deadline) {
      stopped = true;
      return null;
    }
    return shinglesFor(symbol);
  };
  return buildDocumentFrequency(picked, bounded);
}

/**
 * Can this pair be ruled out before it is scored?
 *
 * Not a heuristic — arithmetic. With no shared name token the name signal is
 * 0, and with a differing arity (or none) the signature signal is 0 too. What
 * is left is `body * wBody + vocabulary * wVocabulary`. The vocabulary is
 * bounded by 1. The body, weighted Jaccard, is bounded by the ratio of the two
 * shingle sets' total weights: the shared part weighs at most the lighter set
 * and the union at least the heavier one. If that ceiling cannot reach the
 * body-only floor either, no scoring can save the pair: skipping it changes no
 * result and removes most of the work.
 */
function cannotClear(a, b, threshold, weights, table) {
  if (tokensShare(tokensFor(a), tokensFor(b))) return false;

  const left = signatureFor(a);
  const right = signatureFor(b);
  const arityCouldMatch = left.arity !== null && right.arity !== null && left.arity === right.arity;
  if (arityCouldMatch) return false;

  const weightA = weightFor(a, table);
  const weightB = weightFor(b, table);
  const ceiling = weightA > 0 && weightB > 0 ? Math.min(weightA, weightB) / Math.max(weightA, weightB) : 0;
  if (ceiling >= STRONG_BODY) return false;

  const best = (weights.body ?? 0) * ceiling + (weights.vocabulary ?? 0);
  return best < threshold;
}

function tokensShare(left, right) {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

/**
 * How alike are two symbols?
 *
 * @param {object} a
 * @param {object} b
 * @param {object} [weights]
 * @param {{table?: {documents: number, counts: Map<string, number>}|null}} [opts]
 *   a document-frequency table weights the body signal by shingle rarity
 * @returns {{score: number, name: number, signature: number, body: number, vocabulary: number}}
 */
export function scorePair(a, b, weights = DEFAULT_WEIGHTS, { table = null } = {}) {
  const name = nameSimilarity(a.name, b.name);
  const signature = signatureSimilarity(a.signature, b.signature);
  const body = a.body && b.body ? weightedJaccard(shinglesFor(a), shinglesFor(b), table) : 0;

  const leftVocabulary = vocabularyFor(a);
  const rightVocabulary = vocabularyFor(b);
  const vocab = vocabularySimilarity(leftVocabulary, rightVocabulary);

  const weighted =
    (weights.name ?? 0) * name +
    (weights.signature ?? 0) * signature +
    (weights.body ?? 0) * body +
    (weights.vocabulary ?? 0) * vocab;

  // A body-only floor, because the most valuable finding this check can make is
  // the one the name and the signature miss: someone reimplemented a routine
  // and named everything differently. It needs the vocabulary to agree, or two
  // routines that merely share a control-flow shape would ride it too.
  const vocabularyAgrees =
    vocab >= VOCABULARY_AGREEMENT || (leftVocabulary.size === 0 && rightVocabulary.size === 0);
  const score = body >= STRONG_BODY && vocabularyAgrees ? Math.max(weighted, body) : weighted;

  return { score, name, signature, body, vocabulary: vocab };
}

/**
 * The same declaration seen twice — the index contains the working tree.
 *
 * Identified by path and line. Name and kind are a fallback only for top-level
 * declarations, the one place a name is unique within its file: two inner
 * helpers called `resolveImage` in two composables of the same file are two
 * functions, and a copy of one next to the other is exactly what this check
 * must report.
 */
function isSameSymbol(a, b) {
  if (a.path !== b.path) return false;
  if (a.line === b.line) return true;
  const topLevel = (symbol) =>
    !symbol.container && (symbol.scope === undefined || symbol.scope === 'exported' || symbol.scope === 'module');
  return a.name === b.name && a.kind === b.kind && topLevel(a) && topLevel(b);
}

/**
 * Does one symbol contain the other, in the same file?
 *
 * A composable's window holds the body of every helper declared inside it, and
 * `useLeads` and `getLeads` share their name tokens, so a container scored
 * against its own inner function looks like a copy of it. It is not: it is the
 * same code read twice.
 */
function encloses(a, b) {
  if (a.path !== b.path) return false;
  const spanOf = (symbol) => {
    const start = Number(symbol.line);
    const end = Array.isArray(symbol.span) ? Number(symbol.span[1]) : start;
    return [start, Number.isFinite(end) ? Math.max(start, end) : start];
  };
  const [aStart, aEnd] = spanOf(a);
  const [bStart, bEnd] = spanOf(b);
  return (aStart <= bStart && bEnd <= aEnd) || (bStart <= aStart && aEnd <= bEnd);
}

/**
 * Candidate duplicates for each new symbol.
 *
 * @param {object} opts
 * @param {Array<object>} opts.symbols symbols the pull request introduces
 * @param {Array<object>} opts.index every symbol already in the repository
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxCandidates]
 * @param {boolean} [opts.idf] weight the body signal by shingle rarity across the index
 * @param {Array<unknown>|((a: object, b: object) => boolean)} [opts.allow]
 *   pairs the repository declared acceptable (see `compileAllowPairs`)
 * @returns {Array<{symbol: object, matches: Array<{candidate: object, score: number, signals: object}>}>}
 */
export function findDuplicates({
  symbols = [],
  index = [],
  threshold = DEFAULT_THRESHOLD,
  maxCandidates = MAX_CANDIDATES,
  weights = DEFAULT_WEIGHTS,
  deadline = null,
  idf = true,
  allow = null,
} = {}) {
  const table = idf ? documentFrequencyFor(index, { deadline }) : null;
  const allowed = typeof allow === 'function' ? allow : compileAllowPairs(allow ?? []);
  const out = [];
  let timedOut = false;

  for (const symbol of symbols) {
    if (timedOut || (deadline !== null && Date.now() >= deadline)) break;

    const matches = [];
    let visited = 0;

    for (const candidate of index) {
      // Every few hundred candidates, not every one: reading the clock per pair
      // would itself become part of the cost being bounded. Per symbol alone let
      // one symbol against a large index overshoot the budget by seconds.
      visited += 1;
      if (deadline !== null && visited % CLOCK_EVERY === 0 && Date.now() >= deadline) {
        timedOut = true;
        break;
      }

      if (isSameSymbol(symbol, candidate)) continue;
      if (encloses(symbol, candidate)) continue;
      if (cannotClear(symbol, candidate, threshold, weights, table)) continue;

      const signals = scorePair(symbol, candidate, weights, { table });
      if (signals.score < threshold) continue;
      // Last, so a configured allow-list costs nothing on pairs that would not
      // have been reported anyway.
      if (allowed(symbol, candidate)) continue;

      matches.push({ candidate, score: signals.score, signals });
    }

    if (!matches.length) continue;

    matches.sort((a, b) => b.score - a.score);
    out.push({ symbol, matches: matches.slice(0, maxCandidates) });
  }

  // Strongest first: if the prompt has to be cut, what is cut is the weakest
  // evidence rather than whatever happened to come last.
  out.sort((a, b) => b.matches[0].score - a.matches[0].score);
  return out;
}

// ---------------------------------------------------------------------------
// Homonyms: the same name, different behaviour.
//
// The mirror image of a duplicate, and the more dangerous of the two. Two
// exported `formatDate` helpers that format differently mean every caller
// gets whichever one its import happened to name — or, with auto-imports,
// whichever one the framework picked. Nobody reading a call site can tell.
// ---------------------------------------------------------------------------

/** Below this skeleton overlap, two same-named functions do different things. */
export const HOMONYM_MAX_BODY = 0.5;

/** Per run. Past this the list is a backlog, not a review. */
export const MAX_HOMONYMS = 15;

/**
 * Names frameworks make every file export. Twenty route handlers all called
 * `GET` are the convention, not a collision.
 */
const CONVENTIONAL_NAMES = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'default',
  'handler',
  'middleware',
  'loader',
  'action',
  'meta',
  'setup',
  'main',
  'Main',
  'config',
  'register',
  'configure',
  'Configure',
  'ConfigureServices',
  'generateMetadata',
  'generateStaticParams',
  'getServerSideProps',
  'getStaticProps',
  'getStaticPaths',
  'OnModelCreating',
  'Up',
  'Down',
  'BuildTargetModel',
]);

/** Kinds compared for homonyms: free functions, and static methods (helpers by another name). */
function homonymKind(symbol) {
  if (symbol.kind === 'function') return true;
  return symbol.kind === 'method' && /\bstatic\b/.test(String(symbol.signature ?? ''));
}

/** `export { a, b } from './x'` names a symbol without defining it. */
function isReExport(symbol) {
  const first = String(symbol.body ?? symbol.signature ?? '').split('\n')[0];
  return /^\s*export\s*(\{|\*)/.test(first);
}

function sameText(a, b) {
  const squash = (body) => stripCode(body ?? '').code.replace(/\s+/g, '');
  return squash(a.body) === squash(b.body);
}

const keyOf = (symbol) => `${symbol.path}\u0000${symbol.name}`;

/**
 * Same-named functions in different files that do different things.
 *
 * Eligible: free functions and static methods, top-level (not inner), outside
 * tests and generated code, and exported. A module-private helper is reachable
 * only from its own file, so two of them with one name never meet at a call
 * site; and auto-import (Nuxt `composables/`, `utils/`) only ever shares
 * exports, so it widens nothing beyond this.
 * A pair is a homonym when the two live in different files and their skeleton
 * overlap is under `maxBodySimilarity`. Two bodies that are the same text are
 * not homonyms whatever the overlap says; a short body has no skeleton to
 * compare and is judged on its text alone.
 *
 * @param {Array<object>} index every symbol in the repository, with bodies
 * @param {object} [opts]
 * @param {Array<object>|null} [opts.symbols] only pairs involving one of these
 *   (the symbols a change touched); null compares the whole index
 * @param {number} [opts.maxBodySimilarity]
 * @param {number} [opts.max] cap on pairs returned
 * @param {Array<string>} [opts.ignoreNames] names the repository declares conventional
 * @returns {Array<{kind: 'homonym', name: string, symbol: object, candidate: object, body: number}>}
 */
export function findHomonyms(
  index = [],
  { symbols = null, maxBodySimilarity = HOMONYM_MAX_BODY, max = MAX_HOMONYMS, ignoreNames = [] } = {},
) {
  const ignored = new Set(ignoreNames);
  const focus = symbols ? new Set(symbols.map(keyOf)) : null;

  const eligible = (symbol) =>
    symbol &&
    symbol.name &&
    !isExcludedPath(symbol.path) &&
    homonymKind(symbol) &&
    !symbol.container &&
    !CONVENTIONAL_NAMES.has(symbol.name) &&
    !ignored.has(symbol.name) &&
    symbol.exported !== false &&
    !isReExport(symbol);

  const groups = new Map();
  for (const symbol of index) {
    if (!eligible(symbol)) continue;
    const list = groups.get(symbol.name) ?? [];
    list.push(symbol);
    groups.set(symbol.name, list);
  }

  const out = [];
  const names = [...groups.keys()].sort();

  for (const name of names) {
    const list = groups
      .get(name)
      .slice()
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.line ?? 0) - (b.line ?? 0)));
    if (new Set(list.map((s) => s.path)).size < 2) continue;

    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        let symbol = list[i];
        let candidate = list[j];
        if (symbol.path === candidate.path) continue;
        if (focus && !focus.has(keyOf(symbol)) && !focus.has(keyOf(candidate))) continue;
        if (sameText(symbol, candidate)) continue;

        const body = bodySimilarity(symbol.body, candidate.body);
        if (body >= maxBodySimilarity) continue;

        // The touched one first, so the report reads "yours vs the existing one".
        if (focus && !focus.has(keyOf(symbol))) [symbol, candidate] = [candidate, symbol];

        out.push({ kind: 'homonym', name, symbol, candidate, body });
        if (out.length >= max) return out;
      }
    }
  }

  return out;
}
