// Consolidated PR comment: render + upsert.
//
// One comment per PR, updated in place. Six checks posting six sticky comments
// meant six more on every push; the thread became unreadable and people
// stopped reading the one that mattered.
//
// Rendering rules:
//   - summary table first, one row per requested check, always in the same
//     order regardless of which job finished first
//   - detail collapsed, and only where there is something to act on
//   - a check with no artifact is "sin resultado", never a pass (AC-4)

import { STATUS, isValidVerdict } from './verdict.mjs';
import { sortChecks } from '../checks/registry.mjs';

export const MARKER = '<!-- pr-validator -->';

const ICON = {
  [STATUS.PASS]: '✅',
  [STATUS.FAIL]: '❌',
  [STATUS.TOOL_ERROR]: '⚠️',
  [STATUS.SKIPPED]: '➖',
  missing: '⏳',
};

function statusLabel(verdict) {
  if (!verdict) return `${ICON.missing} sin resultado`;

  switch (verdict.status) {
    case STATUS.PASS: {
      const counts = verdict.meta?.counts;
      const detail = counts?.total ? ` (${counts.total})` : '';
      return `${ICON[STATUS.PASS]} PASS${detail}`;
    }
    case STATUS.FAIL: {
      const counts = verdict.meta?.counts;
      const n = counts?.gaps ?? counts?.violations ?? counts?.blocking ?? counts?.total;
      const detail = n ? ` (${n})` : '';
      const suffix = verdict.blocking ? '' : ' — no bloquea';
      return `${ICON[STATUS.FAIL]} FAIL${detail}${suffix}`;
    }
    case STATUS.TOOL_ERROR:
      return `${ICON[STATUS.TOOL_ERROR]} error de herramienta — no bloquea`;
    case STATUS.SKIPPED:
      return `${ICON[STATUS.SKIPPED]} omitido`;
    default:
      return verdict.status;
  }
}

function rowsTable(rows) {
  if (!rows.length) return null;
  const lines = ['| # | Detalle | Veredicto | Evidencia |', '|---|---------|-----------|-----------|'];
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.label} | ${row.verdict} | ${row.evidence} |`);
  }
  return lines.join('\n');
}

function checkSection(verdict) {
  const parts = [];

  if (verdict.summary) parts.push(verdict.summary, '');

  const table = rowsTable(verdict.rows);
  if (table) parts.push(table, '');
  else if (verdict.emptyMessage) parts.push(verdict.emptyMessage, '');

  if (verdict.details.length) {
    parts.push('#### Qué corregir', '');
    for (const detail of verdict.details) {
      parts.push(`**${detail.heading}**`, '', detail.body, '');
    }
  }

  if (verdict.notes.length) {
    for (const note of verdict.notes) parts.push(`> ${note}`, '');
  }

  if (verdict.meta?.model) {
    const tokens = verdict.meta.tokens ? `, ${verdict.meta.tokens} tokens` : '';
    parts.push(`<sub>Modelo: ${verdict.meta.model}${tokens}</sub>`, '');
  }

  return parts.join('\n').trimEnd();
}

/**
 * @param {object} input
 * @param {Array<object>} input.verdicts   Verdicts read from artifacts.
 * @param {string[]} input.expected        Checks the workflow was asked to run.
 * @param {string} [input.taskId]
 * @param {string} [input.headRef]
 * @returns {string} Markdown comment body, marker included.
 */
export function renderComment({ verdicts, expected, taskId = null, headRef = '' }) {
  const byCheck = new Map();
  for (const verdict of verdicts) {
    if (isValidVerdict(verdict)) byCheck.set(verdict.check, verdict);
  }

  const order = sortChecks(expected?.length ? expected : [...byCheck.keys()]);

  const heading = taskId ? `Validación de PR — tarea #${taskId}` : 'Validación de PR';
  const out = [MARKER, `## ${heading}`, ''];

  out.push('| Check | Veredicto |', '|-------|-----------|');
  for (const name of order) {
    const verdict = byCheck.get(name);
    out.push(`| ${verdict?.title ?? name} | ${statusLabel(verdict)} |`);
  }
  out.push('');

  // Blocking failures first: that is what stops the merge.
  const withContent = order
    .map((name) => byCheck.get(name))
    .filter(Boolean)
    .sort((a, b) => Number(b.status === STATUS.FAIL) - Number(a.status === STATUS.FAIL));

  for (const verdict of withContent) {
    const body = checkSection(verdict);
    if (!body) continue;
    const open = verdict.status === STATUS.FAIL ? ' open' : '';
    out.push(
      `<details${open}><summary><strong>${verdict.title}</strong> — ${statusLabel(verdict)}</summary>`,
      '',
      body,
      '',
      '</details>',
      '',
    );
  }

  const missing = order.filter((name) => !byCheck.has(name));
  if (missing.length) {
    out.push(
      `> Sin resultado de: ${missing.join(', ')}. El job pudo haberse cancelado, ` +
        'agotado su tiempo, o no haber podido subir su veredicto — revisa si la ' +
        'organización agotó su cuota de almacenamiento de Actions.',
      '',
    );
  }

  if (headRef) out.push(`<sub>Rama: \`${headRef}\`</sub>`);

  return out.join('\n').trimEnd() + '\n';
}

// --- GitHub API ------------------------------------------------------------
// Plain fetch instead of a client library: two endpoints do not justify a
// dependency inside a bundled action.

async function gh(path, { token, method = 'GET', body, apiUrl, fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`GitHub API ${method} ${path} failed: HTTP ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Create the comment, or update the existing one carrying the marker.
 *
 * @returns {Promise<{action: 'created'|'updated', id: number}>}
 */
export async function upsertComment({
  token,
  owner,
  repo,
  issueNumber,
  body,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
}) {
  const base = `/repos/${owner}/${repo}/issues/${issueNumber}`;
  const comments = await gh(`${base}/comments?per_page=100`, { token, apiUrl, fetchImpl });
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));

  if (existing) {
    await gh(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      token,
      apiUrl,
      fetchImpl,
      method: 'PATCH',
      body: { body },
    });
    return { action: 'updated', id: existing.id };
  }

  const created = await gh(`${base}/comments`, {
    token,
    apiUrl,
    fetchImpl,
    method: 'POST',
    body: { body },
  });
  return { action: 'created', id: created.id };
}
