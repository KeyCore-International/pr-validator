// Everything the duplication check needs, decided before any model is called.
//
// Assembles the repository index, works out which of its symbols the pull
// request reached, applies the exclusion policy to both sides and runs the
// deterministic scoring. What comes out is a short list of pairs worth a
// model's judgement — usually none, which is the point.
//
// Which symbols count as "introduced" is decided by span, not by declaration
// line: a function the diff added is in, and so is one that already existed and
// had its body rewritten — which is exactly how an existing helper becomes a
// copy of another one. Every scope is compared, private helpers and the inner
// functions of a composable included; a copy is a copy whoever can call it.

import { buildSymbolIndex } from './symbol-index.mjs';
import { changedLinesByFile, spanChange } from '../symbols/index.mjs';
import { applyExclusions, isExcludedPath } from '../similarity/exclusions.mjs';
import { normalizeBody } from '../similarity/body.mjs';
import { isLogicBearing } from '../similarity/metrics.mjs';
import {
  findDuplicates,
  findHomonyms,
  hasEnoughBody,
  isPublicSurface,
  minTokensFor,
  bodyTail,
  DEFAULT_THRESHOLD,
  MAX_CANDIDATES,
  MIN_TOKENS_EXPORTED,
  MIN_TOKENS_PRIVATE,
} from '../similarity/score.mjs';

/**
 * Wall-clock budget for the whole scoring pass.
 *
 * The symbol and file ceilings bound what goes in; this bounds what the loop is
 * allowed to spend, which is the number a consumer is billed for on every push.
 */
const BUDGET_MS = 20_000;

/** Candidates kept per symbol: more for a public one, which more code could have reused. */
export const MAX_CANDIDATES_EXPORTED = 5;
export const MAX_CANDIDATES_PRIVATE = 3;

/** Pairs kept per run. Past this the reader stops reading; what is cut is declared. */
export const MAX_PAIRS = 15;

// The token floors and what counts as public live with the scorer, so the
// floor that decides what is compared and the one that decides whether a body
// signal exists are the same floor. Re-exported here for existing callers.
export { MIN_TOKENS_EXPORTED, MIN_TOKENS_PRIVATE, isPublicSurface, minTokensFor };

/** Keywords that make a body more than one routed call. */
const CONTROL_TOKENS = new Set(['if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'try', 'catch']);

/** Tokens that can end an operand, and keywords that sit between two operands. */
const OPERAND_END = new Set([')', ']', '}', 'X', '"S"', '0', 'this', 'self', 'null', 'true', 'false']);
const INFIX_KEYWORDS = new Set(['as', 'is', 'in', 'of', 'instanceof']);

/**
 * A body that is one statement routing values elsewhere: one call
 * (`emit('retry')`, `router.push({ name: 'sync' })`, `return api.get(url(id))`)
 * or one assignment (`failed.value = true`), with no branch, loop, callback or
 * logic of its own.
 *
 * Every repository has hundreds of these and, with names and strings erased,
 * they are all the same skeleton. The coverage check already exempts them for
 * the same reason: there is nothing in them to have copied. A one-statement
 * body that does carry logic — a currency format, a date, arithmetic — is not
 * delegation and stays compared.
 */
export function isDelegation(symbol) {
  // `void router.push(...)` discards a promise; the skeleton would read `void`
  // as a name standing next to the call, which is two statements. Dropping it
  // can only touch a declaration head otherwise (`void Save()` in C#), and the
  // head is not part of what is read here.
  const body = String(symbol?.body ?? '').replace(/\bvoid\s+(?=[\w$(])/g, '');
  let tokens = bodyTail(normalizeBody(body));
  if (tokens[0] === '{') tokens = tokens.slice(1);

  let depth = 0;
  let statements = 0;
  let previous = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (CONTROL_TOKENS.has(token)) return false;
    // A callback inside the statement is logic handed in, not a value routed on.
    if (token === '=' && tokens[i + 1] === '>') return false;

    if (token === '(' || token === '[' || token === '{') depth += 1;
    else if (token === ')' || token === ']' || token === '}') {
      depth -= 1;
      if (depth < 0) break; // the body's own closing brace
    }

    if (depth === 0) {
      const starts = previous === null || previous === ';';
      // Two operands side by side with no operator between them: in code that
      // writes no semicolons, that is where the next statement begins.
      const juxtaposed =
        previous !== null && OPERAND_END.has(previous) && (token === 'X' || (/^[a-z]+$/.test(token) && !INFIX_KEYWORDS.has(token)));
      if (token !== ';' && (starts || juxtaposed)) statements += 1;
      if (statements > 1) return false;
    }
    previous = token;
  }

  return statements <= 1 && !isLogicBearing(symbol);
}

/**
 * `list.filter(keep)` that stops when the clock passes `deadline`, keeping what
 * it had decided by then. Every symbol's skeleton is computed here, which over
 * a whole index is the expensive part of the filter.
 */
function filterWithin(list, keep, deadline) {
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    if (i % 256 === 0 && Date.now() >= deadline) break;
    if (keep(list[i])) out.push(list[i]);
  }
  return out;
}

/** Whether a symbol is worth comparing: enough body past its head, and not a bare delegation. */
function isComparable(symbol) {
  return hasEnoughBody(symbol) && !isDelegation(symbol);
}

/**
 * The symbols the diff reached, taken from the index so each carries its body.
 *
 * The index is built from the working tree, which in CI is the pull request's
 * head — so whatever the diff added or rewrote is already in there, body and
 * all. Each one comes out tagged with `change: 'added' | 'modified'`.
 *
 * @param {string} diffText
 * @param {Array<object>} index
 * @returns {Array<object>}
 */
export function touchedSymbols(diffText, index) {
  const changes = changedLinesByFile(diffText);
  if (!changes.size) return [];

  const out = [];
  for (const symbol of index) {
    const change = spanChange(symbol, changes.get(symbol.path));
    if (change) out.push({ ...symbol, change });
  }
  return out;
}

/** A stable key for a symbol. */
function symbolKey(symbol) {
  return `${symbol.path}:${symbol.line}:${symbol.name}`;
}

/** A stable key for a pair, so A-duplicates-B and B-duplicates-A report once. */
function pairKey(a, b) {
  const left = symbolKey(a);
  const right = symbolKey(b);
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * Split the touched symbols into those an inline ignore takes out and the rest.
 *
 * Only the touched side is read. An ignore on an EXISTING symbol must not make
 * every future copy of it invisible; it speaks for the code it sits on.
 *
 * And only an ignore the base branch already carried is honoured. One the
 * change under review writes would let a pull request declare its own copy
 * acceptable — a loosening from the head, which the configuration refuses for
 * `duplication.allow` for exactly that reason. Such an ignore is listed in
 * `headIgnores` and the symbol is compared as if it were not there; once the
 * ignore is merged and reviewed, it holds for later changes.
 *
 * An ignore counts as the base's when the line that carries it is not among
 * the lines the diff added.
 */
function partitionIgnored(symbols, changes) {
  const kept = [];
  const suppressed = [];
  const headIgnores = [];
  const invalidSuppressions = [];

  for (const symbol of symbols) {
    const where = { path: symbol.path, line: symbol.line, name: symbol.name };

    if (symbol.ignore?.reason) {
      const ignoreLine = Number(symbol.ignore.line ?? symbol.line);
      const addedHere = Boolean(changes.get(symbol.path)?.added.has(ignoreLine));
      if (!addedHere) {
        suppressed.push({ ...where, reason: symbol.ignore.reason });
        continue;
      }
      headIgnores.push({ ...where, reason: symbol.ignore.reason });
    } else if (symbol.ignore?.invalid) {
      invalidSuppressions.push(where);
    }
    kept.push(symbol);
  }

  return { kept, suppressed, headIgnores, invalidSuppressions };
}

/**
 * The homonym pass `buildDuplicationContext` runs unless told otherwise: the
 * same-name, different-behaviour pairs of `findHomonyms`, limited to pairs that
 * involve a symbol the change touched.
 *
 * @param {{symbols: Array<object>, index: Array<object>}} input
 * @returns {Array<object>}
 */
export function defaultHomonymPass({ symbols = [], index = [] } = {}) {
  return findHomonyms(index, { symbols });
}

/**
 * Deterministic duplication candidates for this pull request.
 *
 * @param {object} opts
 * @param {string} opts.diffText
 * @param {string} [opts.repo]
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxCandidates] candidates per public symbol; a private one keeps at most 3
 * @param {number} [opts.maxPairs]
 * @param {string|null} [opts.cacheDir] passed to the symbol index; null in CI
 * @param {Array<unknown>|null} [opts.allow] pairs the repository declared acceptable
 *   (`duplication.allow`; see `compileAllowPairs`)
 * @param {Function|null} [opts.homonymPass] the homonym pass; `defaultHomonymPass`
 *   unless a caller swaps it, null to skip it
 * @param {number} [opts.budgetMs] wall-clock budget for the whole pass, index included
 * @returns {{
 *   indexed: number,
 *   indexTruncated: boolean,
 *   comparisonTruncated: boolean,
 *   introduced: number,
 *   findings: Array<{symbol: object, matches: Array<object>}>,
 *   truncation: {candidates: number, pairs: number},
 *   pairsTruncated: boolean,
 *   suppressed: Array<object>,
 *   headIgnores: Array<object>,
 *   invalidSuppressions: Array<object>,
 *   homonyms: Array<object>
 * }}
 */
export function buildDuplicationContext({
  diffText = '',
  repo = '.',
  threshold = DEFAULT_THRESHOLD,
  maxCandidates = MAX_CANDIDATES,
  maxPairs = MAX_PAIRS,
  cacheDir = null,
  allow = null,
  homonymPass = defaultHomonymPass,
  budgetMs = BUDGET_MS,
} = {}) {
  // A wall-clock budget on top of the ceilings, because the ceilings bound the
  // inputs and this bounds the work. It starts before the repository is read:
  // near the symbol ceiling, reading the index and weighing its shingles took
  // longer than the whole budget, and a deadline set after them bounded nothing.
  // Reached, every stage stops with what it has and says so — a partial
  // comparison declared is honest; one that quietly ran out of candidates would
  // read as "nothing duplicates anything here".
  const deadline = Date.now() + budgetMs;
  const index = buildSymbolIndex({ repo, exclude: isExcludedPath, cacheDir, deadline });

  const touched = applyExclusions(touchedSymbols(diffText, index.symbols));
  const { kept, suppressed, headIgnores, invalidSuppressions } = partitionIgnored(
    touched,
    changedLinesByFile(diffText),
  );

  const introduced = kept.filter(isComparable);
  const eligible = applyExclusions(index.symbols);
  const comparable = filterWithin(eligible, isComparable, deadline);

  const raw = findDuplicates({
    symbols: introduced,
    index: comparable,
    threshold,
    // One past the widest cap, so a symbol that had more candidates than it may
    // keep is known to have had them, and the cut below is declared.
    maxCandidates: Math.max(maxCandidates, MAX_CANDIDATES_PRIVATE) + 1,
    deadline,
    allow,
  });
  const timedOut = index.timedOut || Date.now() >= deadline;

  // Homonyms: same name, different behaviour. Two `formatDate` helpers that
  // disagree are a defect the score above cannot see, because it looks for
  // alike bodies. The pass gets the touched symbols before the body floor (a
  // short helper can be a homonym too) and the whole eligible index; it only
  // reports pairs that involve something this change touched.
  const homonyms =
    typeof homonymPass === 'function' ? (homonymPass({ symbols: kept, index: eligible, threshold }) ?? []) : [];

  // Two symbols the SAME pull request adds can duplicate each other, and the
  // index already contains both — so that case falls out for free. What does
  // not fall out is reporting it once instead of twice, and telling the
  // developer which of the two situations they are in: "you added two copies"
  // reads differently from "this already existed".
  const introducedKeys = new Set(introduced.map(symbolKey));
  const seen = new Set();
  const findings = [];
  let droppedCandidates = 0;
  let droppedPairs = 0;
  let pairs = 0;

  // `raw` is strongest first, so a cut drops the weakest evidence.
  for (const finding of raw) {
    const cap = isPublicSurface(finding.symbol)
      ? maxCandidates
      : Math.min(MAX_CANDIDATES_PRIVATE, maxCandidates);
    const matches = [];

    for (const match of finding.matches) {
      const key = pairKey(finding.symbol, match.candidate);
      if (seen.has(key)) continue;

      if (matches.length >= cap) {
        droppedCandidates += 1;
        continue;
      }
      if (pairs >= maxPairs) {
        droppedPairs += 1;
        continue;
      }

      seen.add(key);
      pairs += 1;
      matches.push({
        ...match,
        introducedHere: introducedKeys.has(symbolKey(match.candidate)),
      });
    }

    if (matches.length) findings.push({ symbol: finding.symbol, matches });
  }

  return {
    indexed: index.symbols.length,
    indexTruncated: index.truncated,
    // The comparison stopped on its budget rather than on running out of pairs.
    comparisonTruncated: timedOut,
    introduced: introduced.length,
    findings,
    // Declared, never silent: what the caps left out. `candidates` is a lower
    // bound — the scorer stops looking one past the widest cap.
    truncation: { candidates: droppedCandidates, pairs: droppedPairs },
    pairsTruncated: droppedPairs > 0,
    suppressed,
    headIgnores,
    invalidSuppressions,
    homonyms,
  };
}
