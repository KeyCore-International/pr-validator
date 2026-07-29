import { describe, expect, it } from 'vitest';
import {
  extractCriteriaBlock,
  MAX_CONTEXT_TASKS,
  resolveTaskRef,
} from '../src/context/task-ref.mjs';
import { fetchTask, htmlToText, TasksApiError } from '../src/context/tasks-api.mjs';
import {
  makeTasksApiFetch,
  PR_BODY_WITH_CRITERIA,
  TASK_HTML_NO_CRITERIA,
  TASK_HTML_WITH_CRITERIA,
} from './fixtures/tasks.mjs';

describe('resolveTaskRef', () => {
  it.each([
    ['feature/2803-request-variants', '2803'],
    ['fix/3002-error-texto', '3002'],
    ['hotfix/91-urgent', '91'],
    ['3002-slug', '3002'],
    ['team/anthony/4100-algo', '4100'],
  ])('reads the id from %s regardless of prefix', (headRef, expected) => {
    expect(resolveTaskRef({ headRef })).toMatchObject({
      mode: 'task',
      subjectId: expected,
      source: 'branch',
    });
  });

  it.each([
    ['fix: corrige el buscador (#3002)', '3002'],
    ['feat: algo #3002', '3002'],
    ['[3002] ajusta el filtro', '3002'],
  ])('reads the id from the PR title: %s', (prTitle, expected) => {
    expect(resolveTaskRef({ headRef: 'pepito', prTitle })).toMatchObject({
      mode: 'task',
      subjectId: expected,
      source: 'title',
    });
  });

  // The branch is the primary source: it is the one place the id appears
  // without anybody having to remember to type it.
  it('prefers the branch over the title', () => {
    const ref = resolveTaskRef({ headRef: 'fix/3002-x', prTitle: 'fix: algo (#9999)' });

    expect(ref).toMatchObject({ subjectId: '3002', source: 'branch' });
    expect(ref.contextIds).toContain('9999');
  });

  it('carries the other referenced ids as context', () => {
    const ref = resolveTaskRef({
      headRef: 'pepito',
      prBody: 'Corrección de la incidencia #3002 de la tarea #3001',
    });

    expect(ref).toMatchObject({ subjectId: '3002', source: 'body' });
    expect(ref.contextIds).toEqual(['3001']);
  });

  // Positional on purpose: two runs over the same pull request have to pick the
  // same subject, and "the first one" is the only rule that guarantees it.
  it('takes the first id of a source as the subject and the rest as context', () => {
    const ref = resolveTaskRef({ headRef: 'pepito', prTitle: 'fix: unifica #3002 y #3003' });

    expect(ref.subjectId).toBe('3002');
    expect(ref.contextIds).toEqual(['3003']);
  });

  it('bounds how many context tasks it will pull in', () => {
    const ref = resolveTaskRef({
      headRef: 'pepito',
      prTitle: 'x #1 #2 #3 #4 #5 #6',
    });

    expect(ref.contextIds).toHaveLength(MAX_CONTEXT_TASKS);
  });

  // Nomenclature stopped being a gate: a branch with no id has nothing to
  // validate against, which is not the same thing as a violation.
  it.each(['pepito', 'mejoras-portal', 'develop', 'main', 'feature/no-id-here'])(
    'reports no reference for %s instead of failing',
    (headRef) => {
      expect(resolveTaskRef({ headRef })).toMatchObject({ mode: 'none', subjectId: null });
    },
  );

  it('falls back to a criteria block in the PR body', () => {
    const ref = resolveTaskRef({ headRef: 'mejoras-portal', prBody: PR_BODY_WITH_CRITERIA });

    expect(ref).toMatchObject({ mode: 'task', subjectId: null, source: 'body' });
    expect(ref.criteriaBlock).toContain('fechaInicio');
  });

  it('prefers the branch id over the body block', () => {
    const ref = resolveTaskRef({ headRef: 'feature/77-x', prBody: PR_BODY_WITH_CRITERIA });

    expect(ref).toMatchObject({ source: 'branch', subjectId: '77' });
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

  // Plenty of real tasks carry their whole intent in the title. Refusing them
  // would deny those pull requests any criteria validation at all, so the
  // check infers instead.
  it('accepts a task whose description is empty', async () => {
    const fetchImpl = makeTasksApiFetch({ task: { title: 'Servicio de correo dedicado' } });

    const task = await fetchTask(1, { env, fetchImpl });

    expect(task.title).toBe('Servicio de correo dedicado');
    expect(task.description).toBe('');
  });

  it('reads the status and flags the terminal ones', async () => {
    const fetchImpl = makeTasksApiFetch({
      task: { title: 'x', description: 'y', taskStatus: { name: 'Enviado QA' } },
    });

    const task = await fetchTask(1, { env, fetchImpl });

    expect(task.status).toBe('Enviado QA');
    expect(task.isTerminal).toBe(true);
  });

  it('does not flag an open status as terminal', async () => {
    const fetchImpl = makeTasksApiFetch({
      task: { title: 'x', description: 'y', taskStatus: { name: 'En Progreso' } },
    });

    expect((await fetchTask(1, { env, fetchImpl })).isTerminal).toBe(false);
  });

  // The manager declaring "this is an incident" beats any heuristic over the
  // status, so it is read directly rather than inferred.
  it('reads the incident marker', async () => {
    const fetchImpl = makeTasksApiFetch({
      task: { title: 'x', description: 'y', incidentOrigin: 'PRODUCTION' },
    });

    const task = await fetchTask(1, { env, fetchImpl });

    expect(task.isIncident).toBe(true);
    expect(task.incidentOrigin).toBe('PRODUCTION');
  });

  it('flattens the embedded parent task', async () => {
    const fetchImpl = makeTasksApiFetch({
      task: {
        title: 'Subtarea técnica',
        description: 'y',
        task: { id: 3906, title: 'HU-21', description: TASK_HTML_WITH_CRITERIA },
        subTasks: [{ id: 1 }, { id: 2 }],
      },
    });

    const task = await fetchTask(4084, { env, fetchImpl });

    expect(task.parent).toMatchObject({ id: '3906', title: 'HU-21' });
    expect(task.parent.description).toContain('- El endpoint acepta');
    expect(task.subtaskCount).toBe(2);
  });

  // A deployment that exposes none of the optional fields keeps working with
  // exactly the functionality it had before.
  it('tolerates a response with none of the optional fields', async () => {
    const fetchImpl = makeTasksApiFetch({ task: { title: 'x', description: 'y' } });

    expect(await fetchTask(1, { env, fetchImpl })).toMatchObject({
      status: null,
      isTerminal: false,
      isIncident: false,
      incidentOrigin: null,
      parent: null,
      subtaskCount: 0,
    });
  });
});
