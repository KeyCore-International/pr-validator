// Deterministic JSON for the files the local mode writes.
//
// Two runs over the same commit must produce the same bytes: the hash of
// `facts.json` is how a later audit proves a verdict was computed from what it
// says it was. Object key order in JS follows insertion, which follows code
// paths, so keys are sorted here rather than trusted.

/** Keys that hold source text or derived fingerprints: large, and not facts. */
const BULKY_KEYS = new Set([
  'body',
  'skeleton',
  'templateSkeleton',
  'tokens',
  'shingles',
  'vocabulary',
  'normalized',
]);

/** Longest string kept verbatim in a compacted value. */
const MAX_STRING = 400;

/**
 * A plain, bounded copy of a value: no source bodies, no functions, Sets and
 * Maps turned into arrays and objects, floats rounded to four decimals.
 *
 * Used on the output of modules this mode does not own (duplication, coverage),
 * so a field they add later reaches the facts without this file changing — and a
 * field that holds a whole function body does not.
 */
export function compact(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Set) return [...value].map(compact).sort(compareValues);
  if (value instanceof Map) return compact(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map(compact).filter((item) => item !== undefined);

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (BULKY_KEYS.has(key)) continue;
    const next = compact(item);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

function compareValues(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Recursively rebuild objects with their keys sorted. Arrays keep their order. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** JSON with sorted keys, two-space indent and a trailing newline. */
export function stableStringify(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
