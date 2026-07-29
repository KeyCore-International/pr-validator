// Where repetition is the pattern, not the defect (AC-74).
//
// A migration looks like every other migration. A DTO is a list of fields and
// so is the next one. A mapper is the same three lines with different property
// names, and that IS the job. A generated file repeats by construction and
// nobody is going to refactor it.
//
// Reporting those is how a duplication check teaches a team to ignore it, so
// they are out by default — on both sides: a new symbol in one of these places
// is not judged, and an existing one is never offered as the thing that was
// duplicated.

/** Paths whose contents repeat by design or by machine. */
const EXCLUDED_PATHS = [
  /(^|\/)migrations?\//i,
  /(^|\/)__generated__\//i,
  /(^|\/)generated\//i,
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)(dist|build|out|bin|obj)\//i,
  /(^|\/)wwwroot\//i,
  /\.generated\.[a-z]+$/i,
  /\.g\.[a-z]+$/i,
  /\.designer\.[a-z]+$/i,
  /\.min\.[a-z]+$/i,
  /\.d\.ts$/i,
  /(^|\/)migrations?[^/]*\.(cs|php|ts|js)$/i,
];

/** Symbol names that declare shape rather than behaviour. */
const EXCLUDED_NAMES = [
  /(Dto|DTO)s?$/,
  /(Request|Response|Payload|ViewModel|Model)$/,
  /Mapper$/i,
  /Profile$/, // AutoMapper profiles
  /Migration$/i,
  /(Entity|Enum|Constants?|Options|Settings|Config(uration)?)$/,
];

/**
 * Only what carries behaviour is compared.
 *
 * Interfaces and enums have no logic to duplicate. Classes and Vue components
 * do, but not at a size this can judge: a class is compared through a bounded
 * window of its first lines, so two service classes that each declare a field
 * and a constructor look alike no matter what they do. When a class genuinely
 * duplicates another, its METHODS say so — with a body each, and a location the
 * developer can act on.
 */
const COMPARABLE_KINDS = new Set(['method', 'function']);

/** Should this path stay out of the duplication comparison? */
export function isExcludedPath(path) {
  const value = String(path || '');
  return EXCLUDED_PATHS.some((pattern) => pattern.test(value));
}

/** Should this symbol stay out of the duplication comparison? */
export function isExcludedSymbol(symbol) {
  if (!symbol) return true;
  if (isExcludedPath(symbol.path)) return true;
  if (!COMPARABLE_KINDS.has(symbol.kind)) return true;
  return EXCLUDED_NAMES.some((pattern) => pattern.test(String(symbol.name || '')));
}

/** Drop everything the policy excludes, from either side of the comparison. */
export function applyExclusions(symbols = []) {
  return symbols.filter((symbol) => !isExcludedSymbol(symbol));
}
