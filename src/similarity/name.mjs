// Do two symbols have names that mean the same thing?
//
// `CalculateOrderTotal` and `computeOrderTotals` are the same idea written by
// two people. Comparing the strings says they share almost nothing; comparing
// their tokens says they share everything that matters.
//
// The signal is deliberately blunt. It ranks candidates for a model to look at,
// so a near miss costs one extra candidate — cheap — while missing an obvious
// pair costs the whole finding.

/** Words that carry no meaning about WHAT a symbol does. */
const STOP_TOKENS = new Set([
  'get',
  'set',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'by',
  'with',
  'from',
  'and',
  'or',
  'is',
  'do',
  'my',
  'new',
  'obj',
  'data',
  'value',
  'item',
  'result',
]);

/** Verbs different people pick for the same act. */
const SYNONYMS = new Map(
  Object.entries({
    calculate: 'compute',
    calc: 'compute',
    fetch: 'load',
    retrieve: 'load',
    read: 'load',
    build: 'create',
    make: 'create',
    generate: 'create',
    remove: 'delete',
    destroy: 'delete',
    check: 'validate',
    verify: 'validate',
    ensure: 'validate',
    convert: 'map',
    transform: 'map',
    parse: 'map',
    find: 'search',
    lookup: 'search',
    send: 'dispatch',
    total: 'sum',
    amount: 'sum',
  }),
);

/**
 * Hard bound on the text this file will look at.
 *
 * The extractors already cap what they store (`src/symbols/limits.mjs`), and
 * this repeats the ceiling at the sink so the guarantee holds whoever calls:
 * a name is scored against every indexed symbol, so its length must never be
 * the caller's to choose. Well past any identifier, so nothing real is cut.
 */
const MAX_NAME_CHARS = 200;

/** Split an identifier into meaningful lowercase tokens. */
export function tokenize(name) {
  return String(name || '')
    .slice(0, MAX_NAME_CHARS)
    // camelCase and PascalCase boundaries, including acronym runs such as
    // `HTTPClient` -> `HTTP` + `Client`.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // One capital before a capitalised word, rather than the whole run of
    // capitals: `([A-Z]+)([A-Z][a-z])` splits at exactly the same places, but
    // gives its match back one character at a time at every start offset, so a
    // long run of capitals costs O(n^2). This form never backtracks.
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean)
    .map((token) => singular(token))
    .map((token) => SYNONYMS.get(token) ?? token)
    .filter((token) => !STOP_TOKENS.has(token));
}

/** Crude plural stripping: `totals` and `total` are the same word here. */
function singular(token) {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/**
 * Token overlap between two names, 0..1.
 *
 * Overlap coefficient rather than Jaccard: `SendInvoiceEmail` against
 * `SendEmail` should score high, and Jaccard punishes it for the extra word
 * even though one name plainly contains the other's meaning.
 */
export function nameSimilarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));

  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  return shared / Math.min(left.size, right.size);
}
