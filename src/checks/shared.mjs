// Helpers shared by every check's render step.

/** Verdict/severity token -> label shown in the PR comment. */
export const LABELS = {
  met: 'OK',
  partial: 'PARCIAL',
  not_met: 'FALTA',
  manual: 'MANUAL',
  ok: 'OK',
  violated: 'INCUMPLE',
  na: 'N/A',
  high: 'ALTA',
  medium: 'MEDIA',
  low: 'BAJA',
};

export const label = (token) => LABELS[token] ?? token ?? '?';

/**
 * Make a value safe for a Markdown table cell: no pipe breaks, no line breaks,
 * bounded length. Long prose belongs in `details`, not in the table.
 */
export function cell(value, max = 110) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .slice(0, max);
}

/** Bounded plain text for the `details` blocks. */
export function text(value, max = 400) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * Shared prompt tail: the JSON contract every check appends to its user prompt.
 * Kept in one place so no check can drift into a different output convention.
 */
export function outputFormat(jsonShape, instruction) {
  return `## Output format
Return ONLY a single JSON object — no markdown fences, no prose before or after — with this exact shape:
${jsonShape}
${instruction}
Be concise: at most 10 entries, each string under 300 characters, summary under 500. Do not quote the diff back.`;
}

/** Standard header block for the user prompt. */
export function header({ taskId, head, base, repo }) {
  return `Task: ${taskId ? `#${taskId}` : '(unspecified)'}
Branch: ${head} -> base: ${base}   Repo: ${repo}`;
}

/** Standard diff section for the user prompt. */
export function diffSection(diffCtx, { base, head }) {
  return `## Diff stat
${diffCtx.stat || '(no changes)'}

## Diff (${base}...${head})${diffCtx.truncated ? ' [TRUNCATED]' : ''}
${diffCtx.block}`;
}
