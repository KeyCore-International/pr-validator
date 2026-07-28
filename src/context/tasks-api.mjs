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
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch one task's title and plain-text description.
 *
 * @param {string|number} id
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {Function} [opts.fetchImpl=fetch]  Injection seam for tests.
 * @returns {Promise<{id: string, title: string, description: string}>}
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
  const description = htmlToText(task?.description ?? '');
  if (!description) throw new TasksApiError(`task ${id} has no description`);

  return { id: String(id), title: task?.title ?? '', description };
}
