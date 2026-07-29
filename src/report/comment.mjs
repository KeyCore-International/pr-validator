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
      const suffix = verdict.blocking ? '' : ' — no bloquea';

      // A diff that belongs to different work is not a failed check, it is a
      // misdirected one. Labelling it FAIL sends the developer looking for
      // criteria to satisfy when what they have to fix is the reference.
      if (counts?.mismatch) return `${ICON[STATUS.FAIL]} NO CORRESPONDE${suffix}`;

      const n = counts?.gaps ?? counts?.violations ?? counts?.blocking ?? counts?.total;
      const detail = n ? ` (${n})` : '';
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

/**
 * Longest prose block this comment will emit for any single field.
 *
 * `summary` is model-supplied and was the only field with no bound at all: the
 * 500-character limit existed as a sentence *inside the prompt*, an instruction
 * to the model that no code enforced.
 */
const MAX_PROSE = 700;

/**
 * Make a block of prose safe to publish under the validator's own identity.
 *
 * Everything here is either model-supplied or copied from the pull request, in a
 * comment posted by the bot and read by reviewers as the gate's own word. The
 * escaping is structural, not cosmetic: without it a summary could close the
 * collapsed block it sits in, open an HTML comment that swallows the real rows,
 * or repeat the marker and confuse the next run's upsert.
 */
function prose(value, max = MAX_PROSE) {
  return (
    String(value ?? '')
      // Control characters, keeping tab and newline: those are legitimate prose.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      // Any HTML that can hide or restructure what follows. Rendered inert by
      // breaking the tag, so the text stays legible and the structure cannot move.
      .replace(/<(\/?)(details|summary|!--|script|style|iframe)/gi, '&lt;$1$2')
      .replace(/-->/g, '--&gt;')
      .trim()
      .slice(0, max)
  );
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

  // Every field below is model-supplied or copied from the pull request, and this
  // comment carries the validator's identity to reviewers. `cell()` and `text()`
  // bound the fields on the way in but escape no structure, and `summary` was
  // bounded by nothing at all.
  const summary = prose(verdict.summary);
  if (summary) parts.push(summary, '');

  const table = rowsTable(verdict.rows);
  if (table) parts.push(table, '');
  else if (verdict.emptyMessage) parts.push(prose(verdict.emptyMessage), '');

  if (verdict.details.length) {
    parts.push('#### Qué corregir', '');
    for (const detail of verdict.details) {
      parts.push(`**${prose(detail.heading, 200)}**`, '', prose(detail.body), '');
    }
  }

  if (verdict.notes.length) {
    // One `>` per line, or a note containing a newline would leave the blockquote
    // and read as the comment's own prose.
    for (const note of verdict.notes) {
      const quoted = prose(note)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      parts.push(quoted, '');
    }
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
 * The login the token posts as, or null when it cannot be resolved.
 *
 * `GITHUB_TOKEN` in Actions authenticates as an app installation, which `/user`
 * rejects; the login of the comments it creates is `github-actions[bot]`. Both
 * paths are tried, and neither being available is not an error — it only means
 * no existing comment can be claimed as ours.
 */
async function ownIdentity({ token, apiUrl, fetchImpl }) {
  try {
    const me = await gh('/user', { token, apiUrl, fetchImpl });
    if (me?.login) return me.login;
  } catch {
    // An installation token cannot read /user. Fall through to the known login.
  }
  return 'github-actions[bot]';
}

/**
 * Every comment on the issue, following pagination.
 *
 * A single page of 100 was a silent cap: past it the gate stopped finding its own
 * comment and posted a new one on every run.
 */
async function allComments({ base, token, apiUrl, fetchImpl, maxPages = 10 }) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await gh(`${base}/comments?per_page=100&page=${page}`, {
      token,
      apiUrl,
      fetchImpl,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
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

  // Whose comment are we allowed to overwrite? The marker alone is not an answer:
  // it is a public constant in a public repository, inlined verbatim in the
  // committed bundle, so the pull request author can post a comment carrying it.
  // Comments come back oldest first, so theirs won permanently — the gate then
  // spent every run updating a comment its author could edit afterwards, and no
  // genuine report was ever created.
  const self = await ownIdentity({ token, apiUrl, fetchImpl });
  const comments = await allComments({ base, token, apiUrl, fetchImpl });

  const existing = comments.find(
    (c) =>
      typeof c.body === 'string' &&
      c.body.includes(MARKER) &&
      // No identity resolved means no comment is claimed as ours, so a fresh one
      // is created. Failing towards a duplicate comment beats overwriting a
      // stranger's, and beats leaving a forged one standing as the only report.
      self != null &&
      c.user?.login === self,
  );

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
