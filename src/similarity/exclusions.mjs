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
  // Tests, for the same reason as migrations: repetition there is the pattern,
  // not a defect. Arrange/act/assert makes any two test methods look alike, and
  // a real run bore that out — eight candidate pairs surfaced on a single pull
  // request and the model judged all eight unrelated, one model call each. The
  // check exists to find reimplemented production logic; two tests that set up
  // the same fixture are doing their job.
  /(^|\/)(tests?|__tests__|spec)\//i,
  /\.(test|spec)\.[a-z]+$/i,
  // `[^/]+`, no `[^/]*`: la convencion es `OrderServiceTests.cs` / `OrderTest.php`.
  // Con `*`, un controlador de produccion llamado `Test.php` quedaba excluido.
  /(^|\/)[^/]+Tests?\.(cs|php)$/,
  // Stories, mocks and fixtures restate production shapes on purpose: a story
  // renders a component with sample props, a mock mirrors the service it stands
  // in for, a fixture is data. None of it is reimplemented logic.
  /\.stories\.[a-z]+$/i,
  /(^|\/)(__stories__|stories)\//i,
  /(^|\/)(__mocks__|mocks?)\//i,
  /\.mocks?\.[a-z]+$/i,
  /(^|\/)(__fixtures__|fixtures?)\//i,
  // Translation files: the same key in every language is the point.
  /(^|\/)locales?\//i,
  // The EF Core model snapshot is generated, and some layouts keep it outside
  // the migrations folder.
  /ModelSnapshot\.cs$/i,
  // Tooling folders. Agent skills keep reference templates there
  // (`.claude/skills/*/references/*.ts`), and every module generated from one
  // matches its template at 1.00: offering the template as "the existing symbol
  // to reuse" sends the developer to code that never runs.
  /(^|\/)\.(claude|agents|github|cursor)\//,
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

// ---------------------------------------------------------------------------
// Allow-pairs: duplication a repository has looked at and decided to keep.
//
// Some pairs are alike on purpose — a server and a client copy of the same
// validator, two adapters that must stay independent. Declaring the pair in
// the repository configuration (`duplication.allow`) keeps it from being
// raised on every pull request, without switching anything else off.
//
// Each entry names two sides; a side is a path glob, a symbol name, or both:
//
//   ["src/server/validate.ts#isEmail", "src/client/validate.ts#isEmail"]
//   { "a": "src/legacy/**", "b": "src/v2/**", "reason": "…" }
//   { "pair": ["#formatDate", "#formatDate"], "reason": "…" }
//   "src/a.ts#total <-> src/b.ts#sum"
//
// `path#name`, `path` alone, `#name` or a bare identifier. Globs take `*`
// (within one folder), `**` (across folders) and `?`. A pair is symmetric.
// ---------------------------------------------------------------------------

/** One side of an allow-pair as written, split into a path matcher and a name. */
function parseSide(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const hash = text.lastIndexOf('#');
  if (hash !== -1) {
    const path = text.slice(0, hash).trim();
    const name = text.slice(hash + 1).trim();
    return { path: path ? globToRegExp(path) : null, name: name && name !== '*' ? name : null };
  }

  // No `#`: a bare identifier is a name, anything path-shaped is a path.
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return { path: null, name: text };
  return { path: globToRegExp(text), name: null };
}

/** Both sides of one configuration entry, or null when it is not one. */
function parseEntry(entry) {
  let sides = null;

  if (Array.isArray(entry)) sides = entry;
  else if (typeof entry === 'string') sides = entry.split(/\s*(?:<->|\|)\s*/);
  else if (entry && typeof entry === 'object') {
    sides = Array.isArray(entry.pair) ? entry.pair : [entry.a, entry.b];
  }

  if (!sides || sides.length !== 2) return null;
  const [left, right] = sides.map(parseSide);
  return left && right ? [left, right] : null;
}

function sideMatches(side, symbol) {
  if (!symbol) return false;
  if (side.name !== null && side.name !== symbol.name) return false;
  if (side.path !== null && !side.path.test(String(symbol.path ?? ''))) return false;
  return true;
}

/**
 * A predicate saying whether a pair was declared acceptable.
 *
 * Entries that cannot be read are ignored rather than thrown on: a typo in the
 * configuration must make the check report a pair it should have kept quiet
 * about, never stop it from reporting anything.
 *
 * @param {Array<unknown>} [entries]
 * @returns {(a: object, b: object) => boolean}
 */
export function compileAllowPairs(entries = []) {
  const pairs = (Array.isArray(entries) ? entries : []).map(parseEntry).filter(Boolean);
  if (!pairs.length) return () => false;

  return (a, b) =>
    pairs.some(
      ([left, right]) =>
        (sideMatches(left, a) && sideMatches(right, b)) || (sideMatches(left, b) && sideMatches(right, a)),
    );
}

/** One-off form of `compileAllowPairs`. Compile once when checking many pairs. */
export function isAllowedPair(a, b, entries = []) {
  return compileAllowPairs(entries)(a, b);
}

/** A repository-relative glob as an anchored pattern. */
function globToRegExp(glob) {
  const source = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        // `**/` matches zero or more whole folders; a trailing `**` anything.
        if (source[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${out}$`);
}
