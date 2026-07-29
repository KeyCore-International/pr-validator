// Quality check: how is this change built?
//
// The one check that has something to say about every pull request, including
// the many that carry no task reference at all. Before it existed, those got a
// skipped criteria check and nothing else of substance.
//
// Scope is design: responsibility, complexity, naming, dead code, error
// handling, magic values and idempotency. Vulnerabilities belong to `security`
// and are deliberately excluded — a finding belongs to exactly one check, or
// the developer has to decide which of two reports about the same line is the
// real one.
//
// Only high-severity findings block. Blocking on every naming preference from
// day one is how a gate teaches people to ignore it.

import promptTemplate from './prompt.md?raw';
import config from './config.json';
import {
  cell,
  diffSection,
  header,
  label,
  outputFormat,
  text,
  untrustedBlock,
} from '../shared.mjs';

export const meta = {
  name: 'quality',
  title: 'Calidad del código',
  contextNeeds: ['diff'],
  requiresCode: true,
};

export { config };

const JSON_SHAPE =
  '{"overall":"PASS"|"FAIL","summary":"...","findings":[{"severity":"high"|"medium"|"low","issue":"...","location":"path:line","recommendation":"..."}]}';

const INSTRUCTION =
  'List one entry per real finding (empty array if none). Set overall "FAIL" if there is any ' +
  'high-severity finding, else "PASS".';

export function buildPrompt(ctx) {
  const { diff, base, head, repo, taskId, task, taskRef } = ctx;

  const prompt = [
    header({ taskId, head, base, repo, task, source: taskRef?.source }),
    '',
    untrustedBlock(
      'Pull request title and description',
      [ctx.prTitle, ctx.prBody].filter(Boolean).join('\n\n'),
    ),
    '',
    diffSection(diff, { base, head }),
    '',
    outputFormat(JSON_SHAPE, INSTRUCTION),
  ]
    .filter((part) => part !== '')
    .join('\n');

  return { system: promptTemplate, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.findings);
}

export function render(parsed, ctx = {}) {
  if (!accept(parsed)) return null;

  const items = parsed.findings;
  const rows = items.map((item, index) => ({
    id: `Q${index + 1}`,
    label: cell(item.issue, 90),
    verdict: label(item.severity),
    evidence: cell(item.location, 60),
  }));

  const details = items.map((item, index) => ({
    id: `Q${index + 1}`,
    heading: `Q${index + 1} — ${cell(item.issue, 90)} (${label(item.severity)}, ${cell(item.location, 60)})`,
    body: text(item.recommendation, 400),
  }));

  const failOn = ctx.config?.failOn ?? config.failOn;
  const blockingFindings = items.filter((i) => failOn.includes(i.severity));

  return {
    rows,
    details,
    overall: parsed.overall === 'FAIL' || blockingFindings.length > 0 ? 'FAIL' : 'PASS',
    counts: { total: items.length, blocking: blockingFindings.length },
    emptyMessage: 'Sin observaciones de calidad en el diff.',
  };
}
