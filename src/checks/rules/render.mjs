// Rules check: does the diff follow the conventions this repository wrote down?
//
// Judges only against rules the repo authored. A repository with no rules is
// not a repository that "complies" — it is one with nothing to enforce, and
// the check says exactly that rather than passing silently.

import promptTemplate from './prompt.md?raw';
import config from './config.json';
import { cell, diffSection, header, label, outputFormat, text } from '../shared.mjs';

export const meta = {
  name: 'rules',
  title: 'Reglas del proyecto',
  contextNeeds: ['diff', 'rules'],
};

export { config };

const JSON_SHAPE =
  '{"overall":"PASS"|"FAIL","summary":"...","rules":[{"rule":"short name + file","status":"ok"|"violated"|"na","evidence":"path:line or quote","reasoning":"..."}]}';

const INSTRUCTION =
  'One entry per relevant rule. Set overall "FAIL" if any rule is "violated", else "PASS".';

export function buildPrompt(ctx) {
  const { diff, rules, base, head, repo, taskId } = ctx;

  if (!rules || rules.empty) {
    throw new Error('rules check needs a non-empty rules corpus');
  }

  const prompt = [
    header({ taskId, head, base, repo }),
    '',
    `## Project rules\n${rules.text}`,
    '',
    diffSection(diff, { base, head }),
    '',
    outputFormat(JSON_SHAPE, INSTRUCTION),
  ].join('\n');

  return { system: promptTemplate, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.rules);
}

export function render(parsed) {
  if (!accept(parsed)) return null;

  const items = parsed.rules;
  // Rules the model judged irrelevant are noise in the table; keep them out
  // unless that would leave the table empty.
  const relevant = items.filter((i) => i.status !== 'na');
  const shown = relevant.length ? relevant : items;

  const rows = shown.map((item, index) => ({
    id: `R${index + 1}`,
    label: cell(item.rule, 70),
    verdict: label(item.status),
    evidence: cell(item.evidence, 110),
  }));

  const violations = items.filter((i) => i.status === 'violated');
  const details = violations.map((violation, index) => ({
    id: `R${index + 1}`,
    heading: cell(violation.rule, 70),
    body: text(violation.reasoning, 400),
  }));

  return {
    rows,
    details,
    overall: parsed.overall === 'FAIL' || violations.length > 0 ? 'FAIL' : 'PASS',
    counts: { total: items.length, relevant: relevant.length, violations: violations.length },
    emptyMessage: 'Ninguna regla del proyecto aplica a estos cambios.',
  };
}

/**
 * Verdict emitted without calling the model when the repository defines no
 * rules at all (AC-24).
 */
export function noRulesVerdict(rulesCtx) {
  return {
    rows: [],
    details: [],
    overall: 'PASS',
    counts: { total: 0, relevant: 0, violations: 0 },
    emptyMessage: `Sin reglas declaradas en el repositorio (${rulesCtx?.dir ?? '.claude/rules'}). No hay convenciones que exigir.`,
  };
}
