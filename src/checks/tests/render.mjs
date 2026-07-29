// Tests check: what did this change add that nothing exercises?
//
// Two passes, and the order is what makes the check affordable. A deterministic
// cross lists the public symbols the diff introduces and drops every one whose
// name appears in the repository's test files. Only the remainder reaches the
// model, which decides which of them actually warrant a test.
//
// Without that first pass every pull request would ship its whole diff to a
// model to answer a question a string search answers for free.

import promptTemplate from './prompt.md?raw';
import config from './config.json';
import { cell, header, label, outputFormat, text, untrustedBlock } from '../shared.mjs';

export const meta = {
  name: 'tests',
  title: 'Cobertura de tests',
  contextNeeds: ['diff', 'coverage'],
  requiresCode: true,
};

export { config };

const JSON_SHAPE =
  '{"overall":"PASS"|"FAIL","summary":"...","symbols":[{"symbol":"...","location":"path:line","verdict":"needs_test"|"not_needed","suggestion":"..."}]}';

const INSTRUCTION =
  'One entry per candidate symbol given below, keeping its name and location. Set overall "FAIL" ' +
  'if any symbol is "needs_test", else "PASS".';

/** The candidates, with just enough of each to judge it. */
function candidateSection(orphans) {
  const lines = orphans.map(
    (symbol) => `- ${symbol.name} (${symbol.kind}) — ${symbol.path}:${symbol.line}\n  ${symbol.signature}`,
  );

  return `## Untested public symbols introduced by this pull request\n${lines.join('\n')}`;
}

export function buildPrompt(ctx) {
  const { diff, base, head, repo, taskId, coverage, task, taskRef } = ctx;

  if (!coverage?.orphans?.length) {
    throw new Error('tests check needs at least one untested symbol to judge');
  }

  const prompt = [
    header({ taskId, head, base, repo, task, source: taskRef?.source }),
    '',
    candidateSection(coverage.orphans),
    '',
    untrustedBlock(
      'Pull request title and description',
      [ctx.prTitle, ctx.prBody].filter(Boolean).join('\n\n'),
    ),
    '',
    `## Diff (${base}...${head})${diff.truncated ? ' [TRUNCATED]' : ''}\n${diff.block}`,
    '',
    outputFormat(JSON_SHAPE, INSTRUCTION),
  ]
    .filter((part) => part !== '')
    .join('\n');

  return { system: promptTemplate, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.symbols);
}

export function render(parsed, ctx = {}) {
  if (!accept(parsed)) return null;

  const items = parsed.symbols;
  const failOn = ctx.config?.failOn ?? config.failOn;
  const needing = items.filter((item) => failOn.includes(item.verdict));

  const rows = items.map((item, index) => ({
    id: `T${index + 1}`,
    label: cell(item.symbol, 60),
    verdict: label(item.verdict),
    evidence: cell(item.location, 80),
  }));

  // Only the symbols that need a test get prose. Explaining why the others do
  // not is noise the developer has no action for.
  const details = needing.map((item, index) => ({
    id: `T${index + 1}`,
    heading: `${cell(item.symbol, 60)} (${cell(item.location, 80)})`,
    body: text(item.suggestion, 400),
  }));

  return {
    rows,
    details,
    overall: parsed.overall === 'FAIL' || needing.length > 0 ? 'FAIL' : 'PASS',
    counts: { total: items.length, gaps: needing.length },
    emptyMessage: 'Todo lo público que introduce el PR está cubierto o no necesita test.',
  };
}
