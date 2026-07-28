// Criteria check: does the diff actually deliver what the task asked for?
//
// Two input modes. Preferred is the task description straight from the task
// manager (source of truth, robust even when the author skipped the workflow
// that copies criteria into the PR). Fallback is a fenced ```criteria block in
// the PR body, used when the task API is unreachable.

import promptTemplate from './prompt.md?raw';
import config from './config.json';
import { cell, diffSection, header, label, outputFormat, text } from '../shared.mjs';

export const meta = {
  name: 'criteria',
  title: 'Criterios de aceptación',
  contextNeeds: ['diff', 'task'],
};

export { config };

const JSON_SHAPE =
  '{"overall":"PASS"|"FAIL","summary":"...","criteria":[{"id":"C1","criterion":"...","verdict":"met"|"partial"|"not_met"|"manual","evidence":"path:line or \'no evidence in diff\'","reasoning":"..."}]}';

const MODE_DESCRIPTION =
  'a task DESCRIPTION (context, scope, and an acceptance-criteria section). First identify each acceptance criterion, then judge EACH against the diff.';
const MODE_LIST = 'a list of acceptance criteria and the diff. Judge EACH criterion against the diff.';

/**
 * Split a criteria block into individual bullets.
 * @returns {string[]}
 */
export function parseCriteriaList(raw) {
  const list = [];
  for (const line of String(raw || '').split('\n')) {
    const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
    if (match) list.push(match[1].trim());
  }
  return list;
}

export function buildPrompt(ctx) {
  const { task, diff, base, head, repo, taskId } = ctx;
  const descriptionMode = Boolean(task?.description);

  if (!descriptionMode && !task?.criteriaBlock) {
    throw new Error('criteria check needs either a task description or a criteria block');
  }

  let criteriaSection;
  let instruction;

  if (descriptionMode) {
    criteriaSection = `## Task description (identify the acceptance criteria from here)\n${task.description}`;
    instruction = 'One entry per acceptance criterion you identify, numbered C1, C2, … in order.';
  } else {
    const list = parseCriteriaList(task.criteriaBlock);
    if (!list.length) throw new Error('the criteria block contains no bullets');
    criteriaSection = `## Acceptance criteria\n${list.map((c, i) => `C${i + 1}. ${c}`).join('\n')}`;
    instruction = `One entry per criterion above, reusing ids C1..C${list.length}.`;
  }

  const system = promptTemplate.replace(
    '{{INPUT_MODE}}',
    descriptionMode ? MODE_DESCRIPTION : MODE_LIST,
  );

  const prompt = [
    header({ taskId, head, base, repo }),
    '',
    criteriaSection,
    '',
    diffSection(diff, { base, head }),
    '',
    outputFormat(JSON_SHAPE, instruction),
  ].join('\n');

  return { system, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.criteria);
}

export function render(parsed) {
  if (!accept(parsed)) return null;

  const items = parsed.criteria;
  const rows = items.map((item) => ({
    id: item.id ?? '?',
    label: cell(item.criterion, 90),
    verdict: label(item.verdict),
    evidence: cell(item.evidence, 120),
  }));

  // Only unmet criteria get prose. The task description itself is never echoed
  // into the comment (BR-18): the developer gets what is missing, not a copy
  // of the task.
  const gaps = items.filter((i) => i.verdict === 'not_met' || i.verdict === 'partial');
  const details = gaps.map((gap) => ({
    id: gap.id ?? '?',
    heading: `${gap.id ?? '?'} — ${cell(gap.criterion, 90)} (${label(gap.verdict)})`,
    body: text(gap.reasoning, 400),
  }));

  return {
    rows,
    details,
    overall: parsed.overall === 'FAIL' || gaps.length > 0 ? 'FAIL' : 'PASS',
    counts: { total: items.length, gaps: gaps.length },
  };
}
