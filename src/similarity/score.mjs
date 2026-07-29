// Which existing symbols is a new one worth comparing against?
//
// Three deterministic signals combined into one number, a threshold, and a cap
// of five candidates per symbol. Only what clears the threshold reaches the
// model — which is the whole reason this check is affordable on every pull
// request instead of a nightly job.
//
// The weights say what we actually believe: what a routine DOES matters more
// than what it is called, and what it is called matters more than the types it
// happens to take.

import { nameSimilarity, tokenize } from './name.mjs';
import { normalizeSignature, signatureSimilarity } from './signature.mjs';
import { bodySimilarity, normalizeBody, shingles } from './body.mjs';

export const DEFAULT_WEIGHTS = { name: 0.3, signature: 0.2, body: 0.5 };

/** Below this a pair is not worth a model's attention. */
export const DEFAULT_THRESHOLD = 0.55;

/** Bodies this alike are duplicates whatever the name and the signature say. */
const STRONG_BODY = 0.8;

/** Per symbol. More than five candidates is a prompt nobody reads. */
export const MAX_CANDIDATES = 5;

// Bodies are normalised once per symbol rather than once per pair. With a few
// thousand indexed symbols the difference is the check finishing in seconds
// instead of minutes.
const shingleCache = new WeakMap();

function shinglesFor(symbol) {
  const cached = shingleCache.get(symbol);
  if (cached) return cached;

  const computed = shingles(normalizeBody(symbol.body ?? ''));
  shingleCache.set(symbol, computed);
  return computed;
}

// Name tokens and signature shape, like bodies, computed once per symbol instead
// of once per pair. `findDuplicates` walks the whole index for every symbol the
// pull request introduces, so anything recomputed inside that loop is paid a
// number of times equal to the product of the two.
const tokenCache = new WeakMap();
const signatureCache = new WeakMap();

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

/**
 * Can this pair be ruled out before it is scored?
 *
 * Not a heuristic — arithmetic. Jaccard is bounded above by the ratio of the two
 * shingle-set sizes, so when the sets are lopsided the body signal has a ceiling.
 * With no shared name token the name signal is 0, and with a differing arity the
 * signature signal is 0 too, which leaves `0.5 * body` as the whole weighted
 * score. Clearing 0.55 would need a body over 1, and clearing the body-only floor
 * needs 0.8 — so if the size ratio cannot reach 0.8 either, no scoring can save
 * this pair. Skipping it changes no result and removes most of the work.
 */
function cannotClear(a, b, threshold, weights = DEFAULT_WEIGHTS) {
  if (tokensShare(tokensFor(a), tokensFor(b))) return false;

  const left = signatureFor(a);
  const right = signatureFor(b);
  const arityCouldMatch =
    left.arity !== null && right.arity !== null && left.arity === right.arity;
  if (arityCouldMatch) return false;

  const sizeA = shinglesFor(a).size;
  const sizeB = shinglesFor(b).size;
  if (!sizeA || !sizeB) return true;

  const ceiling = Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB);
  return ceiling < STRONG_BODY && weights.body * ceiling < threshold;
}

function tokensShare(left, right) {
  for (const token of left) if (right.has(token)) return true;
  return false;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;

  return shared / (left.size + right.size - shared);
}

/**
 * How alike are two symbols?
 *
 * @returns {{score: number, name: number, signature: number, body: number}}
 */
export function scorePair(a, b, weights = DEFAULT_WEIGHTS) {
  const name = nameSimilarity(a.name, b.name);
  const signature = signatureSimilarity(a.signature, b.signature);
  const body = a.body && b.body ? jaccard(shinglesFor(a), shinglesFor(b)) : bodySimilarity(a.body, b.body);

  const weighted = weights.name * name + weights.signature * signature + weights.body * body;

  // A body-only floor, because the most valuable finding this check can make is
  // the one the other two signals miss: someone reimplemented a routine and
  // named everything differently. The weighted sum alone would rank that pair
  // below an unrelated one that merely shares a verb.
  const score = body >= STRONG_BODY ? Math.max(weighted, body) : weighted;

  return { score, name, signature, body };
}

/** The same declaration seen twice — the index contains the working tree. */
function isSameSymbol(a, b) {
  if (a.path !== b.path) return false;
  return a.line === b.line || (a.name === b.name && a.kind === b.kind);
}

/**
 * Candidate duplicates for each new symbol.
 *
 * @param {object} opts
 * @param {Array<object>} opts.symbols symbols the pull request introduces
 * @param {Array<object>} opts.index every public symbol already in the repository
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxCandidates]
 * @returns {Array<{symbol: object, matches: Array<{candidate: object, score: number, signals: object}>}>}
 */
export function findDuplicates({
  symbols = [],
  index = [],
  threshold = DEFAULT_THRESHOLD,
  maxCandidates = MAX_CANDIDATES,
  weights = DEFAULT_WEIGHTS,
  deadline = null,
} = {}) {
  const out = [];

  for (const symbol of symbols) {
    // Checked per symbol rather than per pair: reading the clock once per
    // candidate would itself become part of the cost being bounded.
    if (deadline !== null && Date.now() >= deadline) break;

    const matches = [];

    for (const candidate of index) {
      if (isSameSymbol(symbol, candidate)) continue;
      if (cannotClear(symbol, candidate, threshold, weights)) continue;

      const signals = scorePair(symbol, candidate, weights);
      if (signals.score < threshold) continue;

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
