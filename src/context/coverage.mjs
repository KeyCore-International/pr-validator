// Which of the new public symbols does no test even mention?
//
// The cross is deterministic and cheap: list the repository's test files, read
// them, and look for each symbol's name. Only the symbols nobody mentions go on
// to cost a model call — which is what keeps this check affordable enough to
// run on every pull request.
//
// A mention is a weak signal on purpose. It proves nothing about the quality of
// the test, but its ABSENCE is solid: a symbol whose name appears nowhere in
// any test file is not covered by any of them. Reporting only that keeps the
// check honest, and the model is what turns "not mentioned" into "worth
// mentioning to the developer".
//
// "Mentioned" is read per language, so a common name cannot cover a symbol
// from a test about something else:
//
// - TypeScript, JavaScript and Vue: a test file covers a symbol when it imports
//   the symbol's module (relative path, `@/` or `~/` alias, or a barrel folder
//   above it) and mentions its name. Auto-imported folders (`composables/`,
//   `utils/`) need no import, so there a mention anywhere is enough.
// - C#: a test file covers a method when it mentions the method and is about
//   its class — named `<Class>Tests`, or mentioning the class by name.
// - Anything else, or a symbol whose module or class cannot be worked out:
//   a mention anywhere, as before.
//
// Only symbols that carry logic are crossed at all. A DTO, a getter, a flat
// mapper or a call handed straight to another service needs no test of its
// own; those are listed as `exempt` with the reason, never as orphans.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isRegularFileWithin } from './files.mjs';
import { bodyLines } from './symbol-index.mjs';
import { logicProfile } from '../similarity/metrics.mjs';
import { changedLinesByFile, extractorFor, spanChange, symbolsFromSource } from '../symbols/index.mjs';

/** Filenames and directories that mean "this file is a test". */
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|Tests?\.(cs|php|java|kt)$|(^|\/)(tests?|__tests__|spec)\//i;

/** How much of a test file to read. Enough for any real one, bounded for the pathological. */
const MAX_TEST_FILE_CHARS = 200_000;

/** How much of a source file to read to find a symbol's body or class. */
const MAX_SOURCE_FILE_CHARS = 400_000;

const SCRIPT_MODULE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/i;

/** Folders whose exports a framework imports for you: no import line to look for. */
const AUTO_IMPORT_SCOPE = /(^|\/)(composables|utils)\//;

/** Module specifier aliases that point at the project root or its `src/`. */
const ROOT_ALIASES = /^(?:@\/|~~\/|~\/|@@\/|#\/|~)/;

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Every tracked file that looks like a test. */
export function findTestFiles(repo = '.') {
  let listing;
  try {
    // `--others --exclude-standard` picks up test files that exist but are not
    // committed yet. Without them a pull request that adds a symbol and its
    // test in the same change would report the symbol as uncovered.
    listing = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard']);
  } catch {
    return [];
  }

  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => TEST_FILE.test(path));
}

/**
 * Read the test corpus once; every symbol is then a lookup against it.
 *
 * @returns {{files: Array<{path: string, text: string, modules: Set<string>|null}>, refused: number}}
 */
function readTestCorpus(repo, files) {
  const corpus = [];
  let refused = 0;

  for (const path of files) {
    const full = join(repo, path);

    // Same guard as the rules corpus and the symbol index: only a regular file
    // that really lives inside the checkout is read. Leaving one out can only
    // make a symbol look LESS covered, which costs a developer a question and
    // never hides one.
    if (!isRegularFileWithin(full, repo)) {
      refused += 1;
      continue;
    }

    try {
      corpus.push({ path, text: readFileSync(full, 'utf8').slice(0, MAX_TEST_FILE_CHARS), modules: null });
    } catch {
      // A file listed by git but unreadable here — submodule, permissions,
      // already deleted in the working tree — is simply not part of the corpus.
    }
  }

  return { files: corpus, refused };
}

/** Import, dynamic import, require and mock specifiers of a test file. */
export function importSpecifiers(text) {
  const out = [];
  const patterns = [
    // `[^'"]{0,4000}?` rather than `[^'"]*?`: a file of `import` words with no
    // quote after them would otherwise rescan to the end from each one.
    /\bimport\s+(?:[^'"]{0,4000}?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|importActual|requireActual)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"\n]+)['"]/g,
    /\bexport\s+(?:\*|\{[^}]{0,4000}\})\s+from\s+['"]([^'"\n]+)['"]/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) out.push(match[1]);
  return out;
}

function stripModuleExtension(path) {
  return path.replace(/\?.*$/, '').replace(SCRIPT_MODULE, '');
}

/**
 * The module keys a specifier can stand for, seen from a test file.
 *
 * A relative specifier resolves exactly. An aliased or bare one cannot be
 * resolved without the project's alias table, so it is kept as a tail: it
 * covers a module whose path ends with it (`@/helpers/date` → `…/helpers/date`).
 */
function resolveSpecifier(specifier, fromPath) {
  const clean = stripModuleExtension(specifier).replace(/\/index$/, '');

  if (clean.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromPath), clean));
    return { exact: resolved.replace(/^\.\//, ''), tail: null };
  }

  const rest = clean.replace(ROOT_ALIASES, '').replace(/^@[\w.-]+\//, '');
  return { exact: null, tail: rest || null };
}

/** Does any import of this test file point at the module (or a barrel above it)? */
function importsModule(file, modulePath) {
  if (!file.modules) {
    file.modules = importSpecifiers(file.text).map((specifier) => resolveSpecifier(specifier, file.path));
  }

  const module = stripModuleExtension(modulePath).replace(/\/index$/, '');
  return file.modules.some(({ exact, tail }) => {
    if (exact !== null) return module === exact || module.startsWith(`${exact}/`);
    if (!tail) return false;
    return module === tail || module.endsWith(`/${tail}`) || module.includes(`/${tail}/`) || module.startsWith(`${tail}/`);
  });
}

/** Source files read once per run, for bodies and enclosing classes. */
function sourceReader(repo) {
  const cache = new Map();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    let lines = null;
    const full = join(repo, String(path ?? ''));
    try {
      if (path && isRegularFileWithin(full, repo)) {
        lines = readFileSync(full, 'utf8').slice(0, MAX_SOURCE_FILE_CHARS).split('\n');
      }
    } catch {
      lines = null;
    }
    cache.set(path, lines);
    return lines;
  };
}

/** The class a C# member sits in: the nearest type declaration above its line. */
function enclosingClass(lines, line) {
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/\b(?:class|record|struct)\s+([A-Za-z_]\w*)/);
    if (match && !/^\s*(\/\/|\*)/.test(lines[i])) return match[1];
  }
  return null;
}

/** How many lines a C# base list may span after its `class` keyword. */
const MAX_BASE_LIST_LINES = 6;

/**
 * The interfaces a C# class declares it implements: the `I`-prefixed names of
 * its base list (`class OrderService : BaseService, IOrderService, IDisposable`),
 * generic arguments dropped. Always includes `I<Class>`, the convention the
 * container registers it under, even when the base list cannot be read.
 */
export function csharpInterfaces(lines, owner) {
  const out = new Set([`I${owner}`]);
  if (!lines) return [...out];
  const declaration = new RegExp(`\\b(?:class|record|struct)\\s+${escapeRegExp(owner)}\\b`);
  const start = lines.findIndex((line) => declaration.test(line) && !/^\s*(\/\/|\*)/.test(line));
  if (start === -1) return [...out];

  let text = lines.slice(start, start + MAX_BASE_LIST_LINES).join(' ');
  text = text.slice(text.search(declaration));
  const body = text.indexOf('{');
  if (body !== -1) text = text.slice(0, body);
  const colon = text.indexOf(':');
  if (colon === -1) return [...out];
  const baseList = text.slice(colon + 1).split(/\bwhere\b/)[0];

  // Generic arguments go first, innermost out, so `IRepo<Dictionary<K, V>>`
  // splits on its top-level commas only.
  let flat = baseList;
  while (/<[^<>]*>/.test(flat)) flat = flat.replace(/<[^<>]*>/g, '');
  for (const part of flat.split(',')) {
    const name = part.trim().split('.').pop()?.trim() ?? '';
    if (/^I[A-Z]\w*$/.test(name)) out.add(name);
  }
  return [...out];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary mention, so `Score` does not match `ScoreCalculator`. */
function mentionPattern(name) {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`);
}

/**
 * A C# mention: also accepts `Method_Scenario_Result`, the usual test name,
 * which `\b` would refuse because `_` is a word character.
 */
function csharpMentionPattern(name) {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9])`);
}

/**
 * Split new symbols into those some test mentions and those none does.
 *
 * @param {object} opts
 * @param {Array<{name: string, path: string, line: number, kind: string, exported?: boolean, body?: string, container?: string}>} opts.symbols
 * @param {string} [opts.repo]
 * @param {boolean} [opts.logicOnly] cross only exported, logic-bearing symbols (default)
 * @param {string[]} [opts.testFiles] the test files, when the caller already listed them
 * @returns {{
 *   hasTestSuite: boolean,
 *   testFileCount: number,
 *   refusedTestFiles: number,
 *   covered: Array<object>,
 *   orphans: Array<object>,
 *   exempt: Array<object>
 * }}
 */
export function crossWithTests({ symbols = [], repo = '.', logicOnly = true, testFiles: listed = null } = {}) {
  const testFiles = Array.isArray(listed) ? listed : findTestFiles(repo);

  // A repository with no test suite does not "fail" coverage — it has nothing
  // to cross against, and the check says exactly that instead of reporting
  // every symbol as uncovered.
  if (!testFiles.length) {
    return {
      hasTestSuite: false,
      testFileCount: 0,
      refusedTestFiles: 0,
      covered: [],
      orphans: [],
      exempt: [],
    };
  }

  const { files, refused } = readTestCorpus(repo, testFiles);
  const corpus = files.map((file) => file.text).join('\n');
  const readSource = sourceReader(repo);
  const covered = [];
  const orphans = [];
  const exempt = [];

  for (const symbol of symbols) {
    const reason = logicOnly ? exemptReason(symbol, readSource) : null;
    if (reason) {
      exempt.push({ ...symbol, exemptReason: reason });
      continue;
    }

    (isCovered(symbol, files, corpus, readSource) ? covered : orphans).push(symbol);
  }

  // `testFileCount` stays the number of test files FOUND; `refusedTestFiles`
  // says how many of them the read guard would not open, so the difference is
  // visible rather than folded into one number.
  return {
    hasTestSuite: true,
    testFileCount: testFiles.length,
    refusedTestFiles: refused,
    covered,
    orphans,
    exempt,
  };
}

/**
 * Why a symbol needs no test of its own, or null when it does.
 *
 * A body that cannot be read is assumed to carry logic: leaving the symbol in
 * costs a question, leaving it out could hide one.
 */
function exemptReason(symbol, readSource) {
  if (symbol.exported === false) return 'not-exported';

  let body = symbol.body;
  if (body === undefined || body === null) {
    const lines = readSource(symbol.path);
    if (!lines || !symbol.line) return null;
    body = bodyLines(lines, symbol.line - 1).join('\n');
  }
  if (!String(body).trim()) return null;

  const profile = logicProfile({ ...symbol, body });
  if (profile.logicBearing) return null;
  return profile.exempt ?? 'no-logic';
}

function isCovered(symbol, files, corpus, readSource) {
  const path = String(symbol.path ?? '');

  if (SCRIPT_MODULE.test(path) && !AUTO_IMPORT_SCOPE.test(path)) {
    const mention = mentionPattern(symbol.name);
    return files.some((file) => mention.test(file.text) && importsModule(file, path));
  }

  if (/\.cs$/i.test(path) && symbol.kind !== 'class') {
    const lines = readSource(path);
    const owner = symbol.container ?? (lines ? enclosingClass(lines, symbol.line ?? 0) : null);
    if (owner && owner !== symbol.name) {
      const method = csharpMentionPattern(symbol.name);
      // A test reaches a service through its interface far more often than
      // through the class: `GetRequiredService<IOrderService>().PlaceAsync(…)`.
      // `\bOrderService\b` never matches inside `IOrderService`, so the
      // interfaces the class implements count as mentions of it.
      const names = [owner, ...csharpInterfaces(lines, owner)];
      const ownerMention = new RegExp(`\\b(?:${names.map(escapeRegExp).join('|')})\\b`);
      const ownerTests = new RegExp(`(^|/)${escapeRegExp(owner)}_?Tests?\\.cs$`, 'i');
      return files.some(
        (file) => method.test(file.text) && (ownerTests.test(file.path) || ownerMention.test(file.text)),
      );
    }
    return csharpMentionPattern(symbol.name).test(corpus);
  }

  // Word boundaries so `Score` does not match `ScoreCalculator`, which would
  // hide a genuinely untested symbol behind a similarly named one.
  return mentionPattern(symbol.name).test(corpus);
}

/**
 * The language a file's tests would be written in: `csharp`, `script` (TS, JS
 * and Vue) or `php`. null for a file no test suite is split on.
 *
 * The suite question is asked per language because a repository can hold two
 * stacks: an API with its test project next to a front end with none. One
 * `.cs` test file says nothing about whether the Vue code has a suite.
 */
export function testFamily(path) {
  const value = String(path ?? '');
  if (/\.cs$/i.test(value)) return 'csharp';
  if (SCRIPT_MODULE.test(value)) return 'script';
  if (/\.php$/i.test(value)) return 'php';
  return null;
}

/** The languages that have at least one test file. */
export function suiteFamilies(testFiles = []) {
  return new Set(testFiles.map(testFamily).filter(Boolean));
}

function compareTouched(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The logic-bearing functions a diff adds or changes, of any scope, whether or
 * not the repository has a test suite.
 *
 * `crossWithTests` answers "which new public symbol has no test"; it has
 * nothing to say in a repository with no tests at all. This answers the
 * question that comes first: did the change touch logic? A function counts
 * when the diff reaches its span (its declaration, or a line added or removed
 * inside it) and its body is logic-bearing by the same profile the coverage
 * cross uses. Private helpers, class methods and functions inside composables
 * count too: logic that changes is logic to verify, whoever can call it.
 *
 * Each changed file is read from the working tree, which must be the head the
 * diff describes.
 *
 * @param {object} opts
 * @param {string} opts.diffText
 * @param {string} [opts.repo]
 * @param {(path: string) => boolean} [opts.include] which changed files to read
 * @returns {Array<object>} symbols with `change: 'added'|'modified'`, `endLine`
 *   and the `reasons` that make them logic-bearing, sorted by path, line and name
 */
export function logicTouchedSymbols({ diffText = '', repo = '.', include = () => true } = {}) {
  const changes = changedLinesByFile(diffText);
  const readSource = sourceReader(repo);
  const out = [];

  for (const [path, lineChanges] of changes) {
    if (!extractorFor(path) || !include(path)) continue;
    const lines = readSource(path);
    if (!lines) continue;

    for (const symbol of symbolsFromSource(path, lines.join('\n'))) {
      const change = spanChange(symbol, lineChanges);
      if (!change || !symbol.line) continue;
      const body = bodyLines(lines, symbol.line - 1);
      const profile = logicProfile({ ...symbol, body: body.join('\n') });
      if (!profile.logicBearing) continue;
      out.push({
        ...symbol,
        change,
        endLine: Math.max(symbol.line, symbol.line + body.length - 1),
        reasons: profile.reasons,
      });
    }
  }

  return out.sort(compareTouched);
}
