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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Filenames and directories that mean "this file is a test". */
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|Tests?\.(cs|php|java|kt)$|(^|\/)(tests?|__tests__|spec)\//i;

/** How much of a test file to read. Enough for any real one, bounded for the pathological. */
const MAX_TEST_FILE_CHARS = 200_000;

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

/** Read the test corpus once; every symbol is then a lookup against it. */
function readTestCorpus(repo, files) {
  const corpus = [];

  for (const path of files) {
    try {
      corpus.push(readFileSync(join(repo, path), 'utf8').slice(0, MAX_TEST_FILE_CHARS));
    } catch {
      // A file listed by git but unreadable here — submodule, permissions,
      // already deleted in the working tree — is simply not part of the corpus.
    }
  }

  return corpus.join('\n');
}

/**
 * Split new symbols into those some test mentions and those none does.
 *
 * @param {object} opts
 * @param {Array<{name: string, path: string, line: number, kind: string}>} opts.symbols
 * @param {string} [opts.repo]
 * @returns {{
 *   hasTestSuite: boolean,
 *   testFileCount: number,
 *   covered: Array<object>,
 *   orphans: Array<object>
 * }}
 */
export function crossWithTests({ symbols = [], repo = '.' } = {}) {
  const testFiles = findTestFiles(repo);

  // A repository with no test suite does not "fail" coverage — it has nothing
  // to cross against, and the check says exactly that instead of reporting
  // every symbol as uncovered.
  if (!testFiles.length) {
    return { hasTestSuite: false, testFileCount: 0, covered: [], orphans: [] };
  }

  const corpus = readTestCorpus(repo, testFiles);
  const covered = [];
  const orphans = [];

  for (const symbol of symbols) {
    // Word boundaries so `Score` does not match `ScoreCalculator`, which would
    // hide a genuinely untested symbol behind a similarly named one.
    const mentioned = new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`).test(corpus);
    (mentioned ? covered : orphans).push(symbol);
  }

  return { hasTestSuite: true, testFileCount: testFiles.length, covered, orphans };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
