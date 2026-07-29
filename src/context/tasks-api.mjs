// Task-management API client.
//
// Deliberately generic: the tool is configured with a base URL and a service
// account, and knows nothing about which task manager sits behind it.
//
// Expected protocol:
//   POST {TASKS_API_URL}/auth        -> { data: { accessToken } }
//   GET  {TASKS_API_URL}/tasks/{id}  -> { data: { title, description } }   (Bearer)
//
// The service account is expected to be read-only; this module never issues a
// write of any kind.

export class TasksApiError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'TasksApiError';
    this.status = status;
  }
}

function baseUrl(env) {
  return (env.TASKS_API_URL || '').replace(/\/+$/, '');
}

async function login(env, fetchImpl) {
  const api = baseUrl(env);
  const email = env.TASKS_API_EMAIL;
  const password = env.TASKS_API_PASSWORD;

  if (!api) throw new TasksApiError('TASKS_API_URL is not set');
  if (!email || !password) throw new TasksApiError('TASKS_API_EMAIL / TASKS_API_PASSWORD are not set');

  const res = await fetchImpl(`${api}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    throw new TasksApiError(`auth failed: HTTP ${res.status} ${body}`, { status: res.status });
  }

  const json = await res.json();
  // Tolerant on the envelope: deployments differ in how they wrap the token.
  const token = json?.data?.accessToken || json?.accessToken || json?.token;
  if (!token) throw new TasksApiError('auth succeeded but no accessToken in response');
  return token;
}

/**
 * Flatten an HTML task description into readable plain text, preserving list
 * structure. Acceptance criteria almost always live in `<li>` items, so the
 * bullet must survive or the model loses the criteria boundaries.
 */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|section)\s*>/gi, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Accented entities are the norm in Spanish task descriptions, and leaving
    // them encoded put "Criterios de aceptaci&oacute;n" in front of the model —
    // which then failed to recognise its own heading. Numeric first, then the
    // named ones, and `&amp;` last so a double-encoded entity resolves once.
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([aeiouAEIOU])(acute|grave|circ|uml);/g, (_, letter, accent) => {
      const marks = { acute: '́', grave: '̀', circ: '̂', uml: '̈' };
      return `${letter}${marks[accent]}`.normalize('NFC');
    })
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&Ntilde;/g, 'Ñ')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&Ccedil;/g, 'Ç')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Status names that mean development already handed the task over. A pull
 * request opened against a task sitting in one of these is usually a fix for
 * something found afterwards, filed under an id of its own.
 *
 * Kept as a list rather than wired into the logic so a deployment that names
 * its states differently only has to change this.
 */
export const TERMINAL_STATUS_NAMES = ['enviado qa', 'completadas', 'no aplica'];

/** Whether a status name means the task is no longer open development work. */
export function isTerminalStatus(name) {
  if (!name) return false;
  return TERMINAL_STATUS_NAMES.includes(String(name).trim().toLowerCase());
}

/**
 * Shape one task from whatever the deployment returned. Every field beyond
 * title and description is optional: a task manager that does not expose it
 * keeps working with exactly the functionality it had before.
 */
function shapeTask(raw, id) {
  const status = raw?.taskStatus?.name ?? raw?.status?.name ?? raw?.status ?? null;
  const incidentOrigin = raw?.incidentOrigin ?? null;

  return {
    id: String(id ?? raw?.id ?? ''),
    title: raw?.title ?? '',
    description: htmlToText(raw?.description ?? ''),
    status: typeof status === 'string' ? status : null,
    isTerminal: isTerminalStatus(typeof status === 'string' ? status : null),
    // The manager declaring "this is an incident" beats any heuristic we could
    // run over the status, so it is read first and the status is the fallback.
    isIncident: Boolean(incidentOrigin),
    incidentOrigin: incidentOrigin ?? null,
  };
}

/**
 * Fetch one task, with whatever context the deployment exposes alongside it.
 *
 * The parent task arrives embedded in the same response, so a subtask whose
 * acceptance criteria live on its parent costs no extra request.
 *
 * @param {string|number} id
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {Function} [opts.fetchImpl=fetch]  Injection seam for tests.
 * @returns {Promise<{
 *   id: string, title: string, description: string,
 *   status: string|null, isTerminal: boolean,
 *   isIncident: boolean, incidentOrigin: string|null,
 *   parent: {id: string, title: string, description: string}|null,
 *   subtaskCount: number
 * }>}
 * @throws {TasksApiError}
 */
export async function fetchTask(id, { env = process.env, fetchImpl = fetch } = {}) {
  const api = baseUrl(env);
  const token = await login(env, fetchImpl);

  const res = await fetchImpl(`${api}/tasks/${id}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 160);
    throw new TasksApiError(`get task ${id} failed: HTTP ${res.status} ${body}`, { status: res.status });
  }

  const json = await res.json();
  const task = json?.data ?? json;

  // An empty description is no longer fatal. Plenty of real tasks carry their
  // whole intent in the title, and the criteria check can infer from that —
  // refusing here would deny those pull requests any validation at all.
  const shaped = shapeTask(task, id);
  const rawParent = task?.task ?? task?.parentTask ?? null;

  return {
    ...shaped,
    parent: rawParent ? shapeTask(rawParent, rawParent?.id) : null,
    subtaskCount: Array.isArray(task?.subTasks) ? task.subTasks.length : 0,
  };
}
