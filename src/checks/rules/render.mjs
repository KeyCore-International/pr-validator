// Rules check: does the diff follow the conventions this repository wrote down?
//
// Judges only against rules the repo authored. A repository with no rules is
// not a repository that "complies" — it is one with nothing to enforce, and
// the check says exactly that rather than passing silently.

import promptTemplate from './prompt.md?raw';
import config from './config.json';
import { cell, diffSection, header, label, outputFormat, text, untrustedBlock } from '../shared.mjs';

export const meta = {
  name: 'rules',
  title: 'Reglas del proyecto',
  contextNeeds: ['diff', 'rules'],
};

export { config };

const JSON_SHAPE =
  '{"overall":"PASS"|"FAIL","summary":"...","rules":[{"rule":"short name + file","status":"ok"|"violated"|"na","evidence":"path:line or quote","reasoning":"..."}]}';

const INSTRUCTION =
  'One entry per relevant rule. Set overall "FAIL" if any rule is "violated", else "PASS".';

export function buildPrompt(ctx) {
  const { diff, rules, base, head, repo, taskId } = ctx;

  if (!rules || rules.empty || !rules.text) {
    throw new Error('rules check needs a non-empty rules corpus');
  }

  // Order matters for cost, not just for reading.
  //
  // Prompt caching matches a prefix from the very first token, and the corpus is
  // the only block in this prompt that repeats between runs — the same rule files,
  // unchanged, on every push. It therefore goes FIRST, ahead of the header (which
  // carries the head SHA and so changes every push) and ahead of the diff.
  //
  // With the header first, the prefix diverged at token zero and no run could ever
  // reuse another's. This is also the only one of the six checks where the stable
  // block is large enough to matter: the others have nothing above the provider's
  // minimum cacheable prefix, so their order is left alone rather than churned for
  // a saving that cannot happen.
  //
  // The corpus is file content read from the pull request's own checkout, so every
  // byte of it is written by the author of the change being judged. Under a bare
  // `## Project rules` heading the model read it as the validator's own
  // instructions, which is an invitation to write a "rule" saying every diff
  // conforms. It is evidence about the repository, not direction to the model —
  // which is why it stays in the user message and fenced, rather than being moved
  // into the system prompt where it would cache just as well but carry authority.
  const prompt = [
    untrustedBlock('Project rules (declared by the repository)', rules.text, {
      maxChars: rules.text.length,
    }),
    '',
    header({ taskId, head, base, repo }),
    '',
    diffSection(diff, { base, head }),
    '',
    outputFormat(JSON_SHAPE, INSTRUCTION, { detail: { field: 'reasoning', when: '"status" is "violated"' } }),
  ].join('\n');

  return { system: promptTemplate, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.rules);
}

export function render(parsed) {
  if (!accept(parsed)) return null;

  const items = parsed.rules;
  // Rules the model judged irrelevant are noise in the table; keep them out
  // unless that would leave the table empty.
  const relevant = items.filter((i) => i.status !== 'na');
  const shown = relevant.length ? relevant : items;

  const rows = shown.map((item, index) => ({
    id: `R${index + 1}`,
    label: cell(item.rule, 70),
    verdict: label(item.status),
    evidence: cell(item.evidence, 110),
  }));

  const violations = items.filter((i) => i.status === 'violated');
  const details = violations.map((violation, index) => ({
    id: `R${index + 1}`,
    heading: cell(violation.rule, 70),
    body: text(violation.reasoning, 400),
  }));

  return {
    rows,
    details,
    overall: parsed.overall === 'FAIL' || violations.length > 0 ? 'FAIL' : 'PASS',
    counts: { total: items.length, relevant: relevant.length, violations: violations.length },
    emptyMessage: 'Ninguna regla del proyecto aplica a estos cambios.',
  };
}

/** How many refused files to name before the message stops being readable. */
const MAX_UNREADABLE_LISTED = 10;

/**
 * Verdict emitted without calling the model when there is no corpus to judge
 * against (AC-24).
 *
 * "The repository wrote nothing down" and "the repository wrote rules this gate
 * refused to read" are opposite pieces of news, and only the first means there
 * is nothing to enforce. Reporting the second as the first is how a corpus
 * disappears behind a file reorganisation with the gate still green.
 */
export function noRulesVerdict(rulesCtx) {
  const unreadable = rulesCtx?.unreadable ?? [];
  const listed = unreadable.slice(0, MAX_UNREADABLE_LISTED).join(', ');
  const rest = unreadable.length - MAX_UNREADABLE_LISTED;

  // The budget dropped everything. Saying "sin reglas declaradas" here would be
  // factually false with the rule files sitting in the tree, and the budget is
  // settable from the branch being judged, so this outcome must not be green.
  if (rulesCtx?.budgetExhausted) {
    const dropped = (rulesCtx.omittedSources ?? []).filter((s) => s.reason === 'presupuesto');
    const names = dropped.slice(0, MAX_UNREADABLE_LISTED).map((s) => s.path).join(', ');
    const more = dropped.length - MAX_UNREADABLE_LISTED;
    return {
      rows: [],
      details: [],
      overall: 'FAIL',
      counts: { total: 0, relevant: 0, violations: 0 },
      emptyMessage:
        `El presupuesto de reglas (${rulesCtx.maxChars ?? 'configurado'} caracteres) no alcanzó para ` +
        `ningún archivo: se descartaron ${dropped.length} (${names}${more > 0 ? ` y ${more} más` : ''}). ` +
        'El repositorio sí declara reglas, así que este check no juzgó nada. Sube `maxRulesChars` ' +
        'o reduce el corpus.',
    };
  }

  return {
    rows: [],
    details: [],
    overall: 'PASS',
    counts: { total: 0, relevant: 0, violations: 0 },
    emptyMessage: unreadable.length
      ? `El repositorio declara ${unreadable.length} archivo(s) de reglas que no se leyeron ` +
        `(${listed}${rest > 0 ? ` y ${rest} más` : ''}): solo se leen archivos regulares dentro ` +
        'del repositorio, nunca enlaces simbólicos ni rutas fuera del checkout. No quedó ninguna ' +
        'regla que evaluar, así que este check no juzgó nada. No bloquea.'
      : `Sin reglas declaradas en el repositorio (${rulesCtx?.dir ?? '.claude/rules'}). No hay convenciones que exigir.`,
  };
}
