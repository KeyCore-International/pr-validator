// Gateway response fixtures.
//
// The model itself is never under test. What IS under test is everything
// around it: does a fenced answer parse, does a truncated answer retry, does a
// wrong-shaped answer count as a failed attempt.

export const RAW_PLAIN_JSON = JSON.stringify({
  overall: 'PASS',
  summary: 'Todo cubierto.',
  criteria: [
    { id: 'C1', criterion: 'Acepta fechaInicio y fechaFin', verdict: 'met', evidence: 'PolicyController.cs:88', reasoning: '' },
  ],
});

export const RAW_FENCED = '```json\n' + RAW_PLAIN_JSON + '\n```';

export const RAW_WITH_PROSE = `Here is my verdict:\n\n${RAW_PLAIN_JSON}\n\nHope that helps!`;

export const RAW_TRUNCATED = RAW_PLAIN_JSON.slice(0, RAW_PLAIN_JSON.length - 30);

export const RAW_NO_JSON = 'I was unable to review this diff.';

export const RAW_WRONG_SHAPE = JSON.stringify({ overall: 'PASS', summary: 'ok', items: [] });

export const CRITERIA_WITH_GAPS = JSON.stringify({
  overall: 'FAIL',
  summary: 'Falta la validación de rango.',
  criteria: [
    { id: 'C1', criterion: 'Acepta fechaInicio y fechaFin', verdict: 'met', evidence: 'PolicyController.cs:88', reasoning: '' },
    {
      id: 'C2',
      criterion: 'Validación de rango de fechas',
      verdict: 'not_met',
      evidence: 'sin evidencia en el diff',
      reasoning: 'La tarea pide rechazar rangos donde fechaFin < fechaInicio con 422. El diff no valida el orden.',
    },
    { id: 'C3', criterion: 'Paginación con tope de 100', verdict: 'manual', evidence: 'requiere ejecutar la API', reasoning: '' },
  ],
});

export const SECURITY_WITH_HIGH = JSON.stringify({
  overall: 'FAIL',
  summary: 'Una inyección SQL introducida por el diff.',
  findings: [
    {
      severity: 'high',
      issue: 'Consulta SQL construida por interpolación',
      location: 'PolicyRepository.cs:142',
      recommendation: 'Usar parámetros en vez de interpolar el filtro en el string de la consulta.',
    },
    {
      severity: 'low',
      issue: 'Log incluye el identificador del cliente',
      location: 'PolicyService.cs:57',
      recommendation: 'Registrar solo el id interno, no el documento del cliente.',
    },
  ],
});

export const SECURITY_CLEAN = JSON.stringify({ overall: 'PASS', summary: 'Sin hallazgos.', findings: [] });

export const RULES_WITH_VIOLATION = JSON.stringify({
  overall: 'FAIL',
  summary: 'Un incumplimiento de convención.',
  rules: [
    { rule: 'Controllers use the unit of work (api/controllers.md)', status: 'violated', evidence: 'PolicyController.cs:31', reasoning: 'El controlador inyecta el repositorio directamente en vez del unit of work.' },
    { rule: 'Async methods end with Async (code-style/naming.md)', status: 'ok', evidence: 'PolicyService.cs:20', reasoning: '' },
    { rule: 'Migrations are reviewed (efcore/migrations.md)', status: 'na', evidence: '', reasoning: '' },
  ],
});

/**
 * Build a `generate` seam that returns the given texts in order, one per call.
 * Lets a test drive the retry loop deterministically.
 */
export function scriptedGenerate(texts, { usage = { totalTokens: 1234 } } = {}) {
  let call = 0;
  const fn = async () => {
    const text = texts[Math.min(call, texts.length - 1)];
    call += 1;
    if (text instanceof Error) throw text;
    return { text, usage };
  };
  fn.calls = () => call;
  return fn;
}
