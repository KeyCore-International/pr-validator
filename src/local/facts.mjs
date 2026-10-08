// `facts`: everything about a branch that can be decided without a model.
//
// The output is the input to every later step, and it is hashed: two runs over
// the same commit must write the same bytes. So nothing time-dependent goes in
// (no timestamps, no durations, no absolute output paths), every list has a
// defined order, and the JSON is written with sorted keys.
//
// The working tree must match HEAD. The duplication index and the coverage
// cross read files from disk, and a facts file that describes a commit while
// reading uncommitted edits describes neither.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG_PATH, loadRepoConfig, perCheckSettings } from '../context/repo-config.mjs';
import { crossWithTests, findTestFiles, logicTouchedSymbols, suiteFamilies, testFamily } from '../context/coverage.mjs';
import { buildDuplicationContext } from '../context/duplication.mjs';
import { isRegularFileWithin } from '../context/files.mjs';
import { bodyLines } from '../context/symbol-index.mjs';
import { logicProfile } from '../similarity/metrics.mjs';
import { symbolsFromDiff } from '../symbols/index.mjs';
import { classifyRange } from './classify.mjs';
import { checkConfig, configAtRef } from './config.mjs';
import { DirtyTreeError, HeadMovedError, NotAncestorError, UsageError } from './errors.mjs';
import {
  dirtyTrackedFiles,
  git,
  gitRun,
  isAncestor,
  repoName,
  resolveBranch,
  resolveSha,
  topLevel,
} from './git.mjs';
import { attributionHits, DEFAULT_ATTRIBUTION_PATTERNS, foreignMerges, listCommits } from './history.mjs';
import { compact, stableStringify } from './json.mjs';
import { computeTier } from './tier.mjs';
import { compilePattern, evaluateTriggers, mergeTriggerSpecs, TriggerSpecError } from './triggers.mjs';
import { ENGINE_VERSION } from './version.mjs';

/** Bump when a field changes meaning or disappears. Adding a field does not. */
export const FACTS_SCHEMA = 1;

/** Coverage orphans listed in full; the rest are counted. */
const MAX_ORPHANS = 200;

/** Logic-bearing touched functions listed in full; the rest are counted. */
const MAX_LOGIC_TOUCHED = 200;

function readJsonFile(path, what) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${what} ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`${what} ${path} is not valid JSON: ${err.message}`);
  }
}

function diffText(repo, from, to) {
  return gitRun(repo, ['diff', '--no-color', '--no-ext-diff', from, to]).stdout;
}

/** The repository's own trigger additions, from `local.triggers` in its config. */
function repoTriggers(repoConfig) {
  const value = repoConfig.config?.local?.triggers;
  return value && typeof value === 'object' ? [value] : [];
}

/** Exempt symbols listed in full; the rest are counted. */
const MAX_EXEMPT = 100;

/** Homonym pairs listed; the pass caps itself, this only bounds the file. */
const MAX_HOMONYMS = 15;

/**
 * Kinds whose body is markup rather than code. The comparison here is of code
 * only — template duplication needs a markup scanner, not a function scorer —
 * so a pair that involves one of these never reaches the facts.
 */
const MARKUP_KINDS = new Set(['component', 'template']);

const isCode = (symbol) => Boolean(symbol) && !MARKUP_KINDS.has(symbol.kind) && !symbol.templateSkeleton;

/** The fields a reader needs to find a symbol, and nothing that holds its source. */
function locate(symbol) {
  return compact({
    name: symbol.name,
    path: symbol.path,
    line: symbol.line,
    span: symbol.span ?? null,
    kind: symbol.kind,
    scope: symbol.scope ?? null,
    container: symbol.container ?? null,
    exported: symbol.exported ?? null,
    change: symbol.change ?? null,
  });
}

/**
 * `duplication.allow` as the BASE branch declares it.
 *
 * An allow-pair silences a finding, so it loosens the gate: a branch must not
 * be able to declare its own copy acceptable. It is read from the base ref
 * only, like every other loosening key.
 */
function trustedAllowPairs(repo, baseSha, configPath = DEFAULT_CONFIG_PATH) {
  const atBase = configAtRef(repo, baseSha, configPath);
  if (!atBase.present || atBase.error) return [];
  const allow = perCheckSettings(atBase.config)?.duplication?.allow;
  return Array.isArray(allow) ? allow : [];
}

function duplicationFacts(repo, repoConfig, text, { allow = [] } = {}) {
  const config = checkConfig(repoConfig, 'duplication');
  try {
    const dup = buildDuplicationContext({
      diffText: text,
      repo,
      threshold: config.threshold,
      maxCandidates: config.maxCandidates,
      allow,
    });

    const findings = dup.findings
      .filter((finding) => isCode(finding.symbol))
      .map((finding) => ({
        symbol: locate(finding.symbol),
        matches: finding.matches
          .filter((match) => isCode(match.candidate))
          .map((match) =>
            compact({
              candidate: locate(match.candidate),
              score: match.score,
              signals: match.signals,
              introducedHere: Boolean(match.introducedHere),
            }),
          ),
      }))
      .filter((finding) => finding.matches.length);

    const homonyms = (dup.homonyms ?? []).slice(0, MAX_HOMONYMS).map((pair) =>
      compact({
        kind: 'homonym',
        name: pair.name,
        symbol: locate(pair.symbol),
        candidate: locate(pair.candidate),
        body: pair.body,
      }),
    );

    return compact({
      indexed: dup.indexed,
      indexTruncated: dup.indexTruncated,
      comparisonTruncated: dup.comparisonTruncated,
      introduced: dup.introduced,
      allowPairs: allow.length,
      findings,
      homonyms,
      truncation: dup.truncation,
      pairsTruncated: dup.pairsTruncated,
      suppressed: dup.suppressed,
      headIgnores: dup.headIgnores,
      invalidSuppressions: dup.invalidSuppressions,
    });
  } catch (err) {
    return { error: err.message };
  }
}

/** The removed lines of each file in a unified diff, as text. */
function removedTextByFile(text) {
  const out = new Map();
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/\r$/, '').replace(/^b\//, '');
      current = path === '/dev/null' ? null : path;
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (current && line.startsWith('-')) out.get(current).push(line.slice(1));
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Did this symbol exist before the change?
 *
 * Its declaration line is among the diff's added lines — that is how
 * `symbolsFromDiff` found it. When a removed line of the same file names it as
 * well, the declaration was rewritten (a signature change) and the function is
 * `modified`; otherwise it is `added`. The blocking policy for untested logic
 * keys on `added`: a new function, not one a change happened to reach.
 */
function declarationChange(symbol, removed) {
  const lines = removed.get(symbol.path);
  if (!lines?.length) return 'added';
  const named = new RegExp(`(?<![\\w$])${escapeRegExp(symbol.name)}(?![\\w$])`);
  return lines.some((line) => named.test(line)) ? 'modified' : 'added';
}

/** Source files read once per run, for a symbol's body and last line. */
function sourceLines(repo) {
  const cache = new Map();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    let lines = null;
    const full = join(repo, String(path ?? ''));
    try {
      if (path && isRegularFileWithin(full, repo)) lines = readFileSync(full, 'utf8').split('\n');
    } catch {
      lines = null;
    }
    cache.set(path, lines);
    return lines;
  };
}

/**
 * A logic-bearing symbol no test covers: where it is, the line range a finding
 * can be matched against, and what makes it logic-bearing.
 */
function untestedEntry(symbol, readLines, removed) {
  const lines = readLines(symbol.path);
  let endLine = symbol.span?.[1] ?? symbol.line;
  let reasons = [];
  if (lines && symbol.line) {
    const body = bodyLines(lines, symbol.line - 1);
    endLine = Math.max(symbol.line, symbol.line + body.length - 1);
    reasons = logicProfile({ ...symbol, body: body.join('\n') }).reasons;
  }
  return compact({
    name: symbol.name,
    path: symbol.path,
    line: symbol.line,
    endLine,
    kind: symbol.kind,
    change: declarationChange(symbol, removed),
    reasons,
  });
}

/**
 * A logic-bearing function the diff added or changed, and whether its language
 * has a test suite in the repository at all.
 *
 * `change` follows the orphans' meaning: `added` is a new function, `modified`
 * one that existed before (its signature rewritten, or a line inside it added
 * or removed).
 */
function logicTouchedEntry(symbol, removed, families) {
  const change = symbol.change === 'added' ? declarationChange(symbol, removed) : 'modified';
  return compact({
    name: symbol.name,
    path: symbol.path,
    line: symbol.line,
    endLine: symbol.endLine,
    kind: symbol.kind,
    scope: symbol.scope ?? null,
    container: symbol.container ?? null,
    change,
    reasons: symbol.reasons,
    suite: families.has(testFamily(symbol.path)) ? 'present' : 'none',
  });
}

/**
 * The logic-bearing functions of the change, computed whether or not the repo
 * has tests: with no suite, nothing else says that the change touched logic
 * nobody can verify. Only production files are read (`classify.mjs`).
 */
function logicTouchedFacts(repo, text, files, removed, testFiles) {
  const production = new Set(files.filter((file) => file.category === 'prod').map((file) => file.path));
  const families = suiteFamilies(testFiles);
  const touched = logicTouchedSymbols({ diffText: text, repo, include: (path) => production.has(path) });
  return {
    count: touched.length,
    entries: touched.slice(0, MAX_LOGIC_TOUCHED).map((symbol) => logicTouchedEntry(symbol, removed, families)),
  };
}

function coverageFacts(repo, text, files = []) {
  try {
    // Listed once: the cross and the per-language suite answer read the same list.
    const testFiles = findTestFiles(repo);
    const cov = crossWithTests({ symbols: symbolsFromDiff(text), repo, testFiles });
    const readLines = sourceLines(repo);
    const removed = removedTextByFile(text);
    const untested = cov.orphans
      .slice(0, MAX_ORPHANS)
      .map((symbol) => untestedEntry(symbol, readLines, removed));
    const logic = logicTouchedFacts(repo, text, files, removed, testFiles);
    return {
      // `suite` is the repo-wide answer; each `logicTouched` entry carries the
      // answer for its own language, which is what a two-stack repo needs.
      suite: cov.hasTestSuite ? 'present' : 'none',
      logicTouchedCount: logic.count,
      logicTouched: logic.entries,
      hasTestSuite: cov.hasTestSuite,
      testFileCount: cov.testFileCount,
      refusedTestFiles: cov.refusedTestFiles,
      coveredCount: cov.covered.length,
      // Orphans are exported, logic-bearing symbols no test covers. DTOs,
      // getters, flat mappers and pure delegation are left out as `exempt`.
      orphanCount: cov.orphans.length,
      orphans: untested,
      // The same list, under the name the review policy reads.
      untestedLogic: untested,
      exemptCount: cov.exempt.length,
      exempt: cov.exempt
        .slice(0, MAX_EXEMPT)
        .map((symbol) =>
          compact({ name: symbol.name, path: symbol.path, line: symbol.line, kind: symbol.kind, reason: symbol.exemptReason }),
        ),
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Compute the facts of the branch checked out in `repo`.
 *
 * @param {object} opts
 * @param {string} opts.repo
 * @param {string} opts.base
 * @param {string|null} [opts.since]
 * @param {string[]} [opts.triggerFiles]
 * @param {string|null} [opts.attributionFile]
 * @param {boolean} [opts.fix]          Raise FIX (an incident), whatever the branch is called.
 * @param {string|null} [opts.branch]   Name of the branch under review. Defaults to the
 *   checked-out branch; on a detached checkout (a worktree on a SHA), to the one
 *   branch whose ref points at HEAD. With none or several, the caller passes it to
 *   keep FIX's `fix/`/`hotfix/` rule and the history readable. `branchSource` in
 *   the facts says which of the three named it.
 * @param {'quick'|'full'|null} [opts.force]
 * @param {{sMax?: number, mMax?: number}} [opts.thresholds]
 * @param {string|null} [opts.expectHead]
 * @param {boolean} [opts.allowBehind]  Record, rather than refuse, a base that is not an ancestor.
 * @param {string} [opts.configPath]
 * @returns {{facts: object, diff: string, sinceDiff: string|null}}
 */
export function computeFacts({
  repo: repoArg,
  base,
  since = null,
  triggerFiles = [],
  attributionFile = null,
  fix = false,
  branch: branchArg = null,
  force = null,
  thresholds = {},
  expectHead = null,
  allowBehind = false,
  configPath,
}) {
  const repo = topLevel(repoArg);
  const headSha = resolveSha(repo, 'HEAD');
  if (expectHead && !headSha.startsWith(String(expectHead).toLowerCase())) {
    throw new HeadMovedError(expectHead, headSha);
  }

  const dirty = dirtyTrackedFiles(repo);
  if (dirty.length) throw new DirtyTreeError(dirty);

  const baseSha = resolveSha(repo, base);
  const baseIsAncestor = isAncestor(repo, baseSha, headSha);
  if (!baseIsAncestor && !allowBehind) throw new NotAncestorError(base, 'HEAD');
  const mergeBase = git(repo, ['merge-base', baseSha, headSha]);

  let sinceSha = null;
  if (since) {
    sinceSha = resolveSha(repo, since);
    if (!isAncestor(repo, sinceSha, headSha)) throw new NotAncestorError(since, 'HEAD');
  }

  // Patterns are validated before any expensive work, so a typo in a triggers
  // file fails in a second rather than after the index is built.
  const repoConfig = loadRepoConfig({ repo, configPath });
  const specs = mergeTriggerSpecs([
    ...triggerFiles.map((file) => readJsonFile(file, 'triggers file')),
    ...repoTriggers(repoConfig),
  ]);
  const extraAttribution = attributionFile ? readJsonFile(attributionFile, 'attribution file') : [];
  if (!Array.isArray(extraAttribution)) {
    throw new UsageError('the attribution file must hold a JSON array of patterns');
  }
  const attributionPatterns = [...DEFAULT_ATTRIBUTION_PATTERNS, ...extraAttribution.map(String)];
  const compiledAttribution = attributionPatterns.map(compilePattern);

  // From the repository, never from the folder: a detached worktree on the
  // branch's tip is named by the ref pointing at it.
  const { branch, source: branchSource } = resolveBranch(repo, { explicit: branchArg, base });

  // Everything that decides the tier comes from merge-base..HEAD, never from
  // the `--since` range: a re-run must not shrink a migration out of view by
  // starting after the commit that added it.
  const range = classifyRange(repo, mergeBase, headSha);
  const fullDiff = diffText(repo, mergeBase, headSha);
  const commits = listCommits(repo, mergeBase, headSha);

  const triggers = evaluateTriggers({
    specs,
    files: range.files,
    diffText: fullDiff,
    commits,
    branch,
    flags: fix ? ['FIX'] : [],
  });
  const tier = computeTier({ prodLines: range.prodLines, triggers: triggers.ids, thresholds, force });

  let sinceFacts = null;
  let sinceDiff = null;
  if (sinceSha) {
    const delta = classifyRange(repo, sinceSha, headSha);
    sinceDiff = diffText(repo, sinceSha, headSha);
    sinceFacts = {
      sha: sinceSha,
      files: delta.files.map((file) => file.path),
      prodLines: delta.prodLines,
      counts: delta.counts,
    };
  }

  const facts = {
    schema: FACTS_SCHEMA,
    engine: ENGINE_VERSION,
    repo: repoName(repo),
    branch,
    branchSource,
    base: { ref: base, sha: baseSha },
    head: { sha: headSha },
    mergeBase,
    preconditions: { cleanTree: true, baseIsAncestor, allowBehind: Boolean(allowBehind) },
    since: sinceFacts,
    commits: commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject.slice(0, 200),
      merge: commit.parents.length > 1,
    })),
    foreignMerges: foreignMerges(repo, commits, { baseSha, branch }),
    attribution: { patterns: attributionPatterns, hits: attributionHits(commits, compiledAttribution) },
    files: range.files,
    counts: range.counts,
    prodLines: range.prodLines,
    triggers,
    tier,
    duplication: duplicationFacts(repo, repoConfig, fullDiff, {
      allow: trustedAllowPairs(repo, baseSha, configPath),
    }),
    coverage: coverageFacts(repo, fullDiff, range.files),
    configNotes: repoConfig.notes,
    diff: { chars: fullDiff.length, file: 'diff.patch', sinceFile: sinceSha ? 'diff-since.patch' : null },
  };

  // Checked last: a HEAD that moved while the index was being built produced
  // facts about two commits at once.
  const after = resolveSha(repo, 'HEAD');
  if (after !== headSha) throw new HeadMovedError(headSha, after);

  return { facts, diff: fullDiff, sinceDiff };
}

/** A short human summary of the facts, in the language of the reports. */
export function factsMarkdown(facts) {
  const lines = [];
  const short = (sha) => String(sha ?? '').slice(0, 12);

  lines.push(`# Hechos de la rama \`${facts.branch || '(detached)'}\``);
  lines.push('');
  lines.push(`- Repositorio: ${facts.repo}`);
  lines.push(`- HEAD: ${short(facts.head.sha)} · base: ${facts.base.ref} (${short(facts.base.sha)}) · merge-base: ${short(facts.mergeBase)}`);
  lines.push(`- Motor: ${facts.engine}`);
  if (!facts.preconditions.baseIsAncestor) {
    lines.push('- **La rama no contiene la base** (se continuó con `--allow-behind`).');
  }
  if (facts.since) {
    lines.push(`- Re-ejecución desde ${short(facts.since.sha)}: ${facts.since.files.length} archivo(s), ${facts.since.prodLines} línea(s) de producción.`);
  }
  lines.push('');

  const tier = facts.tier;
  lines.push(`## Escalón: ${tier.value}`);
  lines.push('');
  lines.push(`- Líneas de producción: ${facts.prodLines}`);
  lines.push(`- Calculado: ${tier.computed} (${tier.reasons.join('; ')})`);
  if (tier.forced) lines.push(`- Forzado: ${tier.forced}`);
  if (tier.refused) lines.push(`- Rechazado: ${tier.refused}`);
  lines.push(`- Disparadores: ${facts.triggers.ids.length ? facts.triggers.ids.join(', ') : 'ninguno'}`);
  for (const id of facts.triggers.ids) {
    const entry = facts.triggers.hits[id];
    const sample = entry.hits
      .slice(0, 3)
      .map((hit) => (hit.line ? `${hit.path}:${hit.line}` : hit.path || hit.kind))
      .join(', ');
    lines.push(`  - ${id} (${entry.count}): ${sample}`);
  }
  lines.push('');

  lines.push('## Archivos');
  lines.push('');
  const byCategory = facts.counts.byCategory;
  lines.push(
    `- ${facts.counts.files} archivo(s): ` +
      Object.keys(byCategory)
        .sort()
        .map((key) => `${key} ${byCategory[key]}`)
        .join(', '),
  );
  lines.push('');

  lines.push('## Historial');
  lines.push('');
  lines.push(`- Commits: ${facts.commits.length}`);
  lines.push(`- Merges ajenos: ${facts.foreignMerges.length ? facts.foreignMerges.map((m) => `${short(m.sha)} (${m.subject})`).join('; ') : 'ninguno'}`);
  lines.push(`- Atribución a herramientas: ${facts.attribution.hits.length ? facts.attribution.hits.map((h) => `${short(h.sha)}: ${h.line}`).join('; ') : 'ninguna'}`);
  lines.push('');

  lines.push('## Duplicación');
  lines.push('');
  if (facts.duplication.error) {
    lines.push(`- No se pudo calcular: ${facts.duplication.error}`);
  } else {
    const findings = facts.duplication.findings ?? [];
    lines.push(`- Símbolos indexados: ${facts.duplication.indexed ?? 0}; introducidos: ${facts.duplication.introduced ?? 0}; candidatos: ${findings.length}`);
    for (const finding of findings.slice(0, 15)) {
      const top = finding.matches?.[0];
      if (!top) continue;
      lines.push(
        `  - ${finding.symbol?.name} (${finding.symbol?.path}:${finding.symbol?.line}) ~ ` +
          `${top.candidate?.name} (${top.candidate?.path}:${top.candidate?.line}) score ${top.score}`,
      );
    }
    const homonyms = facts.duplication.homonyms ?? [];
    lines.push(`- Homónimos (mismo nombre, otro comportamiento): ${homonyms.length || 'ninguno'}`);
    for (const pair of homonyms) {
      lines.push(
        `  - ${pair.name}: ${pair.symbol?.path}:${pair.symbol?.line} vs ${pair.candidate?.path}:${pair.candidate?.line} ` +
          `(cuerpo ${pair.body})`,
      );
    }
  }
  lines.push('');

  lines.push('## Símbolos sin test');
  lines.push('');
  if (facts.coverage.error) {
    lines.push(`- No se pudo calcular: ${facts.coverage.error}`);
  } else if (!facts.coverage.hasTestSuite) {
    lines.push('- El repositorio no tiene archivos de test.');
  } else {
    lines.push(
      `- ${facts.coverage.orphanCount} de ${facts.coverage.orphanCount + facts.coverage.coveredCount} ` +
        `con lógica sin mención en la suite; ${facts.coverage.exemptCount ?? 0} exento(s) por no tener lógica.`,
    );
    for (const orphan of facts.coverage.orphans.slice(0, 20)) {
      const why = orphan.reasons?.length ? ` [${orphan.reasons.join(', ')}]` : '';
      lines.push(`  - ${orphan.name} (${orphan.path}:${orphan.line}, ${orphan.change ?? 'added'})${why}`);
    }
  }
  lines.push('');

  if (!facts.coverage.error) {
    const touched = facts.coverage.logicTouched ?? [];
    const withoutSuite = touched.filter((entry) => entry.suite === 'none');
    lines.push('## Funciones con lógica tocadas');
    lines.push('');
    lines.push(
      `- Suite de pruebas: ${facts.coverage.suite === 'none' ? 'ninguna' : 'presente'}; ` +
        `funciones con lógica que el diff agrega o cambia: ${facts.coverage.logicTouchedCount ?? touched.length}; ` +
        `sin suite de su lenguaje: ${withoutSuite.length}.`,
    );
    for (const entry of withoutSuite.slice(0, 20)) {
      const why = entry.reasons?.length ? ` [${entry.reasons.join(', ')}]` : '';
      lines.push(`  - ${entry.name} (${entry.path}:${entry.line}, ${entry.change})${why}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Run `facts` and write its three files into `out`. */
export function writeFacts({ out, ...opts }) {
  let result;
  try {
    result = computeFacts(opts);
  } catch (err) {
    if (err instanceof TriggerSpecError) throw new UsageError(err.message);
    throw err;
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'facts.json'), stableStringify(result.facts), 'utf8');
  writeFileSync(join(out, 'facts.md'), factsMarkdown(result.facts), 'utf8');
  writeFileSync(join(out, 'diff.patch'), result.diff, 'utf8');
  if (result.sinceDiff !== null) {
    writeFileSync(join(out, 'diff-since.patch'), result.sinceDiff, 'utf8');
  }
  return result.facts;
}
