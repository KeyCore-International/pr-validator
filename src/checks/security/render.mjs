// Security check: does the diff introduce a vulnerability?
//
// Scope is the diff and nothing else. A reviewer that speculates about code it
// cannot see produces findings nobody can act on, and trains the team to
// ignore the check.

import promptTemplate from './prompt.md?raw';
import config from './config.json';
import { cell, diffSection, header, label, outputFormat, text } from '../shared.mjs';

export const meta = {
  name: 'security',
  title: 'Seguridad del código',
  contextNeeds: ['diff'],
  // Nothing to review in a change that only edits prose. Note that YAML, JSON
  // and Dockerfiles DO count as code — see `src/context/files.mjs`.
  requiresCode: true,
};

export { config };

const JSON_SHAPE =
  '{"overall":"PASS"|"FAIL","summary":"...","findings":[{"severity":"high"|"medium"|"low","issue":"...","location":"path:line","recommendation":"..."}]}';

const INSTRUCTION =
  'List one entry per real finding (empty array if none). Set overall "FAIL" if there is any high-severity finding, else "PASS".';

export function buildPrompt(ctx) {
  const { diff, base, head, repo, taskId } = ctx;

  const prompt = [
    header({ taskId, head, base, repo }),
    '',
    diffSection(diff, { base, head }),
    '',
    outputFormat(JSON_SHAPE, INSTRUCTION, { detail: { field: 'recommendation' } }),
  ].join('\n');

  return { system: promptTemplate, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.findings);
}

export function render(parsed, ctx = {}) {
  if (!accept(parsed)) return null;

  const items = parsed.findings;
  const rows = items.map((item, index) => ({
    id: `S${index + 1}`,
    label: cell(item.issue, 90),
    verdict: label(item.severity),
    evidence: cell(item.location, 60),
  }));

  // Every finding is actionable, so every finding gets its remediation — but
  // the table stays scannable and the prose lives in the collapsed block.
  const details = items.map((item, index) => ({
    id: `S${index + 1}`,
    heading: `S${index + 1} — ${cell(item.issue, 90)} (${label(item.severity)}, ${cell(item.location, 60)})`,
    body: text(item.recommendation, 400),
  }));

  const failOn = ctx.config?.failOn ?? config.failOn;
  const blockingFindings = items.filter((i) => failOn.includes(i.severity));

  return {
    rows,
    details,
    overall: parsed.overall === 'FAIL' || blockingFindings.length > 0 ? 'FAIL' : 'PASS',
    counts: { total: items.length, blocking: blockingFindings.length },
    emptyMessage: 'Sin hallazgos de seguridad en el diff.',
  };
}
