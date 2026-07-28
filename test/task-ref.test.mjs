import { describe, expect, it } from 'vitest';
import { extractCriteriaBlock, resolveTaskRef } from '../src/context/task-ref.mjs';
import { fetchTask, htmlToText, TasksApiError } from '../src/context/tasks-api.mjs';
import {
  makeTasksApiFetch,
  PR_BODY_WITH_CRITERIA,
  TASK_HTML_NO_CRITERIA,
  TASK_HTML_WITH_CRITERIA,
} from './fixtures/tasks.mjs';

describe('resolveTaskRef', () => {
  it('reads the id from a feature branch', () => {
    const ref = resolveTaskRef({ headRef: 'feature/2803-request-variants' });

    expect(ref).toMatchObject({ mode: 'task', taskId: '2803', source: 'branch' });
  });

  it.each([
    'chore/pr-validation',
    'hotfix/urgent',
    'release/1.4.0',
    'dependabot/npm_and_yarn/foo',
    'renovate/bar',
    'develop',
    'master',
    'main',
    'qa',
  ])('treats %s as exempt', (headRef) => {
    expect(resolveTaskRef({ headRef }).mode).toBe('exempt');
  });

  it('fails a branch that is neither task-shaped nor exempt', () => {
    expect(resolveTaskRef({ headRef: 'mejoras-portal' }).mode).toBe('invalid');
  });

  it('falls back to a criteria block in the PR body', () => {
    const ref = resolveTaskRef({ headRef: 'mejoras-portal', prBody: PR_BODY_WITH_CRITERIA });

    expect(ref).toMatchObject({ mode: 'task', taskId: null, source: 'body' });
    expect(ref.criteriaBlock).toContain('fechaInicio');
  });

  it('prefers the branch id over the body block', () => {
    const ref = resolveTaskRef({ headRef: 'feature/77-x', prBody: PR_BODY_WITH_CRITERIA });

    expect(ref.source).toBe('branch');
    expect(ref.taskId).toBe('77');
  });

  it('does not treat a feature branch without a numeric id as a task', () => {
    expect(resolveTaskRef({ headRef: 'feature/no-id-here' }).mode).toBe('invalid');
  });
});

describe('extractCriteriaBlock', () => {
  it('extracts only the fenced block', () => {
    const block = extractCriteriaBlock(PR_BODY_WITH_CRITERIA);

    expect(block).toContain('Rango invertido responde 422');
    expect(block).not.toContain('Notas adicionales');
  });

  it('returns empty string when there is no block', () => {
    expect(extractCriteriaBlock('sin bloque')).toBe('');
    expect(extractCriteriaBlock(undefined)).toBe('');
  });
});

describe('htmlToText', () => {
  it('keeps list items as bullets so criteria boundaries survive', () => {
    const text = htmlToText(TASK_HTML_WITH_CRITERIA);
    const bullets = text.split('\n').filter((l) => l.startsWith('- '));

    expect(bullets).toHaveLength(3);
    expect(bullets[1]).toContain('422');
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>a &lt; b &amp; c &quot;d&quot;</p>')).toBe('a < b & c "d"');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
  });
});

describe('fetchTask', () => {
  const env = {
    TASKS_API_URL: 'https://tasks.example.invalid/api/',
    TASKS_API_EMAIL: 'ci@example.invalid',
    TASKS_API_PASSWORD: 'secret',
  };

  it('returns the task with a flattened description', async () => {
    const fetchImpl = makeTasksApiFetch({
      task: { title: 'Filtrado por fechas', description: TASK_HTML_WITH_CRITERIA },
    });

    const task = await fetchTask(2803, { env, fetchImpl });

    expect(task.title).toBe('Filtrado por fechas');
    expect(task.description).toContain('- El endpoint acepta');
  });

  it('accepts a task with no acceptance-criteria section', async () => {
    const fetchImpl = makeTasksApiFetch({
      task: { title: 'Migrar job', description: TASK_HTML_NO_CRITERIA },
    });

    const task = await fetchTask(1, { env, fetchImpl });

    expect(task.description).toContain('Alcance');
  });

  it('fails when the base URL is missing', async () => {
    await expect(fetchTask(1, { env: {}, fetchImpl: makeTasksApiFetch({}) })).rejects.toBeInstanceOf(
      TasksApiError,
    );
  });

  it('fails when authentication is rejected', async () => {
    const fetchImpl = makeTasksApiFetch({ failAuth: true });

    await expect(fetchTask(1, { env, fetchImpl })).rejects.toThrow(/auth failed: HTTP 401/);
  });

  it('fails when the task does not exist', async () => {
    const fetchImpl = makeTasksApiFetch({ failTask: true });

    await expect(fetchTask(999, { env, fetchImpl })).rejects.toThrow(/HTTP 404/);
  });

  it('fails when the task has an empty description', async () => {
    const fetchImpl = makeTasksApiFetch({ task: { title: 'x', description: '' } });

    await expect(fetchTask(1, { env, fetchImpl })).rejects.toThrow(/no description/);
  });
});
