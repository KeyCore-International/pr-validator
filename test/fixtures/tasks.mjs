// Task fixtures. Synthetic on purpose — nothing here comes from a real
// customer's task manager.

/** HTML as the task manager stores it, with an acceptance-criteria section. */
export const TASK_HTML_WITH_CRITERIA = `
<p><strong>Contexto</strong></p>
<p>El listado de p&oacute;lizas no permite filtrar por rango de fechas.</p>
<p><strong>Criterios de aceptaci&oacute;n</strong></p>
<ul>
  <li>El endpoint acepta los par&aacute;metros fechaInicio y fechaFin.</li>
  <li>Si fechaFin &lt; fechaInicio responde 422 con error por campo.</li>
  <li>El listado sigue paginado con pageSize m&aacute;ximo de 100.</li>
</ul>
`;

/** A task with scope but no acceptance-criteria section (AC-13). */
export const TASK_HTML_NO_CRITERIA = `
<p><strong>Contexto</strong></p>
<p>Hay que migrar el job nocturno al nuevo planificador.</p>
<p><strong>Alcance</strong></p>
<p>Solo el job de conciliaci&oacute;n. El resto queda fuera.</p>
`;

/** Body of a PR that carries the criteria inline, used when the API is down. */
export const PR_BODY_WITH_CRITERIA = `
Resuelve el filtrado por fechas.

\`\`\`criteria
- El endpoint acepta fechaInicio y fechaFin
- Rango invertido responde 422
\`\`\`

Notas adicionales que no son criterios.
`;

/** Minimal task-manager responses for the fetch seam. */
export function makeTasksApiFetch({ task, failAuth = false, failTask = false } = {}) {
  return async (url) => {
    if (String(url).endsWith('/auth')) {
      if (failAuth) return { ok: false, status: 401, text: async () => 'unauthorized' };
      return { ok: true, status: 200, json: async () => ({ data: { accessToken: 'test-token' } }) };
    }
    if (failTask) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, json: async () => ({ data: task }) };
  };
}
