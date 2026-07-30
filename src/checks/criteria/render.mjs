// Criteria check: does the diff actually deliver what the task asked for?
//
// The check answers two questions, and keeping them apart is the whole point.
// First: is this diff even about the referenced task? Second: does it satisfy
// the criteria? A diff belonging to different work used to come back with every
// criterion "not_met", telling the developer they had failed to implement
// things that were never theirs — a red verdict reached for the wrong reason,
// and advice they could not act on.
//
// Two criteria modes. When the task enumerates its acceptance criteria, they
// are a contract a person wrote and the change is held to them. When it does
// not — a one-line description is common — the criteria are inferred by the
// model, so an incomplete match is reported as an observation rather than
// blocking a merge on the model's own guesswork.

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
  name: 'criteria',
  title: 'Criterios de aceptación',
  contextNeeds: ['diff', 'task'],
};

export { config };

const JSON_SHAPE =
  '{"correspondence":"matches"|"mismatch","correspondenceReason":"...","overall":"PASS"|"FAIL","summary":"...",' +
  '"criteria":[{"id":"C1","criterion":"...","verdict":"met"|"partial"|"not_met"|"manual","evidence":"path:line or \'no evidence in diff\'","reasoning":"..."}]}';

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

/**
 * Does this task state its acceptance criteria, or must they be inferred?
 *
 * The heading is what tells them apart, not the length: a description that
 * merely repeats the title carries no criteria, and there are plenty of those.
 */
export function criteriaModeFor(task) {
  if (task?.criteriaBlock) return 'explicit';

  const description = String(task?.description || '');
  if (!description.trim()) return 'inferred';

  return /criterios?\s+de\s+aceptaci[oó]n|acceptance\s+criteria/i.test(description)
    ? 'explicit'
    : 'inferred';
}

/** Background tasks the model may consult but is never allowed to enforce. */
function contextSection(ctx) {
  const parts = [];
  const parent = ctx.task?.parent;

  if (parent?.description || parent?.title) {
    parts.push(
      `### Task #${parent.id} — the task this one derives from\n${parent.title}\n${parent.description || ''}`.trim(),
    );
  }

  for (const task of ctx.contextTasks ?? []) {
    parts.push(
      `### Task #${task.id} — also referenced\n${task.title}\n${task.description || ''}`.trim(),
    );
  }

  if (!parts.length) return '';

  return (
    '## Context tasks (background only)\n' +
    'These are NOT what the pull request has to satisfy. Use them to understand why the ' +
    'subject task exists. Never judge a criterion of theirs.\n\n' +
    parts.join('\n\n')
  );
}

export function buildPrompt(ctx) {
  const { task, diff, base, head, repo, taskId, taskRef } = ctx;

  if (!task?.description && !task?.criteriaBlock && !task?.title) {
    throw new Error('criteria check needs a task description, a title or a criteria block');
  }

  const mode = criteriaModeFor(task);
  let criteriaSection;
  let instruction;

  if (task?.criteriaBlock) {
    const list = parseCriteriaList(task.criteriaBlock);
    if (!list.length) throw new Error('the criteria block contains no bullets');
    criteriaSection = `## Acceptance criteria\n${list.map((c, i) => `C${i + 1}. ${c}`).join('\n')}`;
    instruction = `Input mode: explicit. One entry per criterion above, reusing ids C1..C${list.length}.`;
  } else if (mode === 'explicit') {
    criteriaSection = `## Task\n${task.title}\n\n${task.description}`;
    instruction =
      'Input mode: explicit. Identify each acceptance criterion in the task and return one entry ' +
      'per criterion, numbered C1, C2, … in order.';
  } else {
    criteriaSection = `## Task\n${task.title}\n\n${task.description || '(no description beyond the title)'}`;
    instruction =
      'Input mode: inferred. The task states no acceptance criteria. Infer what it asks for and ' +
      'return one entry per inferred requirement, numbered C1, C2, … in order.';
  }

  const prompt = [
    header({ taskId, head, base, repo, task, source: taskRef?.source }),
    '',
    criteriaSection,
    contextSection(ctx),
    untrustedBlock(
      'Pull request title and description',
      [ctx.prTitle, ctx.prBody].filter(Boolean).join('\n\n'),
    ),
    '',
    diffSection(diff, { base, head }),
    '',
    outputFormat(JSON_SHAPE, instruction, { detail: { field: 'reasoning', when: '"verdict" is "not_met" or "partial"' } }),
  ]
    .filter((part) => part !== '')
    .join('\n');

  return { system: promptTemplate, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.criteria) || parsed?.correspondence === 'mismatch';
}

export function render(parsed, ctx = {}) {
  if (!accept(parsed)) return null;

  // A diff about different work is reported as exactly that. Listing criteria
  // it was never meant to satisfy buries the real problem under noise the
  // developer cannot act on.
  if (parsed.correspondence === 'mismatch') {
    const taskId = ctx.taskId ? `#${ctx.taskId}` : 'la tarea referenciada';
    return {
      rows: [
        {
          id: 'REF',
          label: cell(`Los cambios no corresponden a ${taskId}`, 90),
          verdict: 'NO CORRESPONDE',
          evidence: cell(ctx.taskRef?.source ? `id tomado de: ${ctx.taskRef.source}` : '', 120),
        },
      ],
      details: [
        {
          id: 'REF',
          heading: `Los cambios no corresponden a ${taskId}`,
          body:
            `${text(parsed.correspondenceReason, 400)}\n\n` +
            'Si este PR corrige una incidencia derivada de esa tarea, referencia el id de la ' +
            'incidencia y no el de la tarea original. Los criterios no se evaluaron.',
        },
      ],
      overall: 'FAIL',
      counts: { total: 0, gaps: 0, mismatch: 1 },
    };
  }

  // No task in context is an unknown state, not an inferred-criteria one, so it
  // falls to the stricter mode. Defaulting the other way would let a missing
  // context quietly turn the blocking check into an advisory one.
  const mode = ctx.task ? criteriaModeFor(ctx.task) : 'explicit';
  const items = parsed.criteria ?? [];
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

  // Inferred criteria never fail the check. The contract came from the model
  // rather than from whoever defined the task, and blocking a merge on that is
  // blocking on guesswork. What is missing is still reported — it just does not
  // turn red, because a red that stops nothing teaches people to ignore the
  // colour.
  const overall =
    mode === 'inferred' ? 'PASS' : parsed.overall === 'FAIL' || gaps.length > 0 ? 'FAIL' : 'PASS';

  return {
    rows,
    details,
    overall,
    emptyMessage:
      mode === 'inferred' && gaps.length
        ? 'La tarea no enumera criterios de aceptación; los de arriba se infirieron de su descripción. Lo que falta se reporta como observación y no bloquea.'
        : '',
    counts: { total: items.length, gaps: gaps.length, mode },
  };
}
