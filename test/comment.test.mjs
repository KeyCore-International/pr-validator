import { describe, expect, it, vi } from 'vitest';
import { MARKER, renderComment, upsertComment } from '../src/report/comment.mjs';
import {
  makeVerdict,
  skippedVerdict,
  STATUS,
  toolErrorVerdict,
} from '../src/report/verdict.mjs';

const passing = makeVerdict({
  check: 'security',
  title: 'Seguridad del código',
  status: STATUS.PASS,
  blocking: true,
  summary: 'Sin hallazgos.',
  emptyMessage: 'Sin hallazgos de seguridad en el diff.',
  meta: { model: 'test/model', tokens: 900, counts: { total: 0 } },
});

const failing = makeVerdict({
  check: 'criteria',
  title: 'Criterios de aceptación',
  status: STATUS.FAIL,
  blocking: true,
  summary: 'Falta la validación de rango.',
  rows: [
    { id: 'C1', label: 'Acepta fechaInicio y fechaFin', verdict: 'OK', evidence: 'a.cs:88' },
    { id: 'C2', label: 'Validación de rango', verdict: 'FALTA', evidence: 'sin evidencia' },
  ],
  details: [
    { id: 'C2', heading: 'C2 — Validación de rango (FALTA)', body: 'El diff no valida el orden de las fechas.' },
  ],
  notes: ['Diff truncado en 28264 de 642690 caracteres: 55 de 61 archivos quedaron fuera. La revisión es parcial.'],
  meta: { model: 'test/model', taskId: '2803', counts: { total: 2, gaps: 1 } },
});

const skipped = skippedVerdict({
  check: 'rules',
  title: 'Reglas del proyecto',
  reason: 'Sin reglas declaradas en el repositorio.',
});

describe('renderComment', () => {
  const expected = ['criteria', 'security', 'rules'];

  it('carries the marker so the comment can be updated in place', () => {
    const body = renderComment({ verdicts: [passing], expected });

    expect(body.startsWith(MARKER)).toBe(true);
  });

  it('lists every requested check in a stable order', () => {
    // Verdicts arrive in whatever order the jobs finished; the summary table
    // must not reflect that. Only the first three rows are the summary — the
    // rest belong to the per-check detail tables.
    const shuffled = renderComment({ verdicts: [skipped, passing, failing], expected });
    const rows = shuffled.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Check'));

    expect(rows[0]).toContain('Criterios de aceptación');
    expect(rows[1]).toContain('Seguridad');
    expect(rows[2]).toContain('Reglas');
  });

  it('shows a check with no artifact as pending, never as passing', () => {
    const body = renderComment({ verdicts: [passing], expected });

    expect(body).toContain('sin resultado');
    expect(body).toContain('Sin resultado de: criteria, rules');
  });

  it('expands the failing check and collapses the rest', () => {
    const body = renderComment({ verdicts: [failing, passing], expected });

    expect(body).toContain('<details open>');
    expect(body.match(/<details>/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('surfaces truncation as a visible note', () => {
    const body = renderComment({ verdicts: [failing], expected });

    expect(body).toContain('> Diff truncado');
    expect(body).toContain('La revisión es parcial');
  });

  it('names the task in the heading when one was resolved', () => {
    const body = renderComment({ verdicts: [failing], expected, taskId: '2803' });

    expect(body).toContain('Validación de PR — tarea #2803');
  });

  it('marks a tool error as non-blocking', () => {
    const error = toolErrorVerdict({
      check: 'rules',
      title: 'Reglas del proyecto',
      error: 'gateway caído',
    });

    const body = renderComment({ verdicts: [error], expected: ['rules'] });

    expect(body).toContain('error de herramienta — no bloquea');
  });

  it('marks a non-blocking failure as such', () => {
    const soft = makeVerdict({
      check: 'quality',
      title: 'Calidad',
      status: STATUS.FAIL,
      blocking: false,
      rows: [{ id: 'Q1', label: 'x', verdict: 'MEDIA', evidence: 'a.cs:1' }],
    });

    const body = renderComment({ verdicts: [soft], expected: ['quality'] });

    expect(body).toContain('FAIL');
    expect(body).toContain('no bloquea');
  });

  it('ignores malformed verdicts instead of failing the report', () => {
    const body = renderComment({ verdicts: [{ nonsense: true }, passing], expected });

    expect(body).toContain('Seguridad del código');
  });

  it('renders a stable snapshot', () => {
    expect(renderComment({ verdicts: [failing, passing, skipped], expected, headRef: 'feature/2803-x' }))
      .toMatchInlineSnapshot(`
        "<!-- pr-validator -->
        ## Validación de PR

        | Check | Veredicto |
        |-------|-----------|
        | Criterios de aceptación | ❌ FAIL (1) |
        | Seguridad del código | ✅ PASS |
        | Reglas del proyecto | ➖ omitido |

        <details open><summary><strong>Criterios de aceptación</strong> — ❌ FAIL (1)</summary>

        Falta la validación de rango.

        | # | Detalle | Veredicto | Evidencia |
        |---|---------|-----------|-----------|
        | C1 | Acepta fechaInicio y fechaFin | OK | a.cs:88 |
        | C2 | Validación de rango | FALTA | sin evidencia |

        #### Qué corregir

        **C2 — Validación de rango (FALTA)**

        El diff no valida el orden de las fechas.

        > Diff truncado en 28264 de 642690 caracteres: 55 de 61 archivos quedaron fuera. La revisión es parcial.

        <sub>Modelo: test/model</sub>

        </details>

        <details><summary><strong>Seguridad del código</strong> — ✅ PASS</summary>

        Sin hallazgos.

        Sin hallazgos de seguridad en el diff.

        <sub>Modelo: test/model, 900 tokens</sub>

        </details>

        <details><summary><strong>Reglas del proyecto</strong> — ➖ omitido</summary>

        Sin reglas declaradas en el repositorio.

        > Sin reglas declaradas en el repositorio.

        </details>

        <sub>Rama: \`feature/2803-x\`</sub>
        "
      `);
  });
});

describe('upsertComment', () => {
  const args = { token: 't', owner: 'o', repo: 'r', issueNumber: 7, body: `${MARKER}\nhola` };

  it('creates the comment when none carries the marker', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (init?.method === 'POST') return json({ id: 1 });
      return json([{ id: 99, body: 'un comentario cualquiera' }]);
    });

    const result = await upsertComment({ ...args, fetchImpl });

    expect(result.action).toBe('created');
  });

  it('updates the existing comment instead of adding another', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (init?.method === 'PATCH') return json({ id: 42 });
      return json([{ id: 42, body: `${MARKER}\nviejo` }]);
    });

    const result = await upsertComment({ ...args, fetchImpl });

    expect(result).toEqual({ action: 'updated', id: 42 });
    expect(fetchImpl.mock.calls[1][0]).toContain('/issues/comments/42');
  });

  it('throws with the status when the API rejects the call', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });

    await expect(upsertComment({ ...args, fetchImpl })).rejects.toThrow(/HTTP 403/);
  });
});

function json(body) {
  return { ok: true, status: 200, json: async () => body };
}
