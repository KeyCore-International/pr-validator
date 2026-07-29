// Everything the duplication check needs, decided before any model is called.
//
// Assembles the repository index, works out which of its symbols the pull
// request introduced, applies the exclusion policy to both sides and runs the
// deterministic scoring. What comes out is a short list of pairs worth a
// model's judgement — usually none, which is the point.

import { buildSymbolIndex } from './symbol-index.mjs';
import { symbolsFromDiff } from '../symbols/index.mjs';
import { applyExclusions, isExcludedPath } from '../similarity/exclusions.mjs';
import { findDuplicates, DEFAULT_THRESHOLD, MAX_CANDIDATES } from '../similarity/score.mjs';

/**
 * The introduced symbols, taken from the index so each carries its body.
 *
 * The index is built from the working tree, which in CI is the pull request's
 * head — so a symbol the diff adds is already in there, body and all. Matching
 * the two is cheaper and more accurate than re-reading the files.
 */
function introducedSymbols(diffText, index) {
  const added = symbolsFromDiff(diffText);
  const byPath = new Map();

  for (const symbol of index) {
    const list = byPath.get(symbol.path) ?? [];
    list.push(symbol);
    byPath.set(symbol.path, list);
  }

  const out = [];

  for (const ref of added) {
    const candidates = byPath.get(ref.path) ?? [];
    const exact = candidates.find((s) => s.line === ref.line && s.name === ref.name);
    const byName = exact ?? candidates.find((s) => s.name === ref.name);
    if (byName) out.push(byName);
  }

  return out;
}

/** A stable key for a pair, so A-duplicates-B and B-duplicates-A report once. */
function pairKey(a, b) {
  const left = `${a.path}:${a.line}:${a.name}`;
  const right = `${b.path}:${b.line}:${b.name}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Deterministic duplication candidates for this pull request.
 *
 * @param {object} opts
 * @param {string} opts.diffText
 * @param {string} [opts.repo]
 * @param {number} [opts.threshold]
 * @returns {{
 *   indexed: number,
 *   indexTruncated: boolean,
 *   introduced: number,
 *   findings: Array<{symbol: object, matches: Array<object>}>
 * }}
 */
export function buildDuplicationContext({
  diffText = '',
  repo = '.',
  threshold = DEFAULT_THRESHOLD,
  maxCandidates = MAX_CANDIDATES,
} = {}) {
  const index = buildSymbolIndex({ repo, exclude: isExcludedPath });
  const introduced = applyExclusions(introducedSymbols(diffText, index.symbols));
  const comparable = applyExclusions(index.symbols);

  const raw = findDuplicates({
    symbols: introduced,
    index: comparable,
    threshold,
    maxCandidates,
  });

  // Two symbols the SAME pull request adds can duplicate each other, and the
  // index already contains both — so that case falls out for free. What does
  // not fall out is reporting it once instead of twice, and telling the
  // developer which of the two situations they are in: "you added two copies"
  // reads differently from "this already existed".
  const introducedKeys = new Set(introduced.map((s) => `${s.path}:${s.line}:${s.name}`));
  const seen = new Set();
  const findings = [];

  for (const finding of raw) {
    const matches = [];

    for (const match of finding.matches) {
      const key = pairKey(finding.symbol, match.candidate);
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({
        ...match,
        introducedHere: introducedKeys.has(
          `${match.candidate.path}:${match.candidate.line}:${match.candidate.name}`,
        ),
      });
    }

    if (matches.length) findings.push({ symbol: finding.symbol, matches });
  }

  return {
    indexed: index.symbols.length,
    indexTruncated: index.truncated,
    introduced: introduced.length,
    findings,
  };
}
