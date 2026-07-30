import { describe, expect, it } from 'vitest';
import * as criteria from '../src/checks/criteria/render.mjs';
import * as security from '../src/checks/security/render.mjs';
import * as rules from '../src/checks/rules/render.mjs';
import * as quality from '../src/checks/quality/render.mjs';
import * as duplication from '../src/checks/duplication/render.mjs';
import * as tests from '../src/checks/tests/render.mjs';
import { getCheck, listChecks, sortChecks, UnknownCheckError } from '../src/checks/registry.mjs';
import { evidence, outputFormat, resolveOverall } from '../src/checks/shared.mjs';
import {
  CRITERIA_WITH_GAPS,
  RULES_WITH_VIOLATION,
  SECURITY_CLEAN,
  SECURITY_WITH_HIGH,
} from './fixtures/gateway.mjs';
import { htmlToText } from '../src/context/tasks-api.mjs';
import { TASK_HTML_WITH_CRITERIA } from './fixtures/tasks.mjs';

const DIFF_CTX = {
  stat: ' src/a.cs | 4 ++--\n 1 file changed',
  block: '```diff\n--- a\n+++ b\n```',
  truncated: false,
  empty: false,
};

const BASE_CTX = { base: 'origin/develop', head: 'HEAD', repo: '.', taskId: '2803', diff: DIFF_CTX };

const DUPLICATION_CTX = {
  indexed: 42,
  indexTruncated: false,
  introduced: 1,
  findings: [
    {
      symbol: {
        name: 'CalculateTotal',
        kind: 'method',
        path: 'src/New.cs',
        line: 10,
        signature: 'public decimal CalculateTotal(Order o)',
        body: 'public decimal CalculateTotal(Order o)\n{\n  return o.Lines.Sum();\n}',
      },
      matches: [
        {
          candidate: {
            name: 'ComputeSum',
            kind: 'method',
            path: 'src/Old.cs',
            line: 5,
            signature: 'public decimal ComputeSum(Invoice i)',
            body: 'public decimal ComputeSum(Invoice i)\n{\n  return i.Items.Sum();\n}',
          },
          score: 0.82,
          signals: { name: 0.66, signature: 1, body: 0.79 },
          introducedHere: false,
        },
      ],
    },
  ],
};

describe('registry', () => {
  it('exposes the implemented checks in display order', () => {
    expect(listChecks()).toEqual([
      'criteria',
      'security',
      'rules',
      'quality',
      'duplication',
      'tests',
    ]);
  });

  it('rejects an unknown check by name', () => {
    expect(() => getCheck('nope')).toThrow(UnknownCheckError);
  });

  it('sorts checks into a stable display order regardless of arrival', () => {
    expect(sortChecks(['rules', 'criteria', 'security'])).toEqual(['criteria', 'security', 'rules']);
  });

  it('validates the shape of every registered check', () => {
    for (const name of listChecks()) {
      const check = getCheck(name);
      expect(check.meta.title).toBeTruthy();
      expect(Array.isArray(check.meta.contextNeeds)).toBe(true);
    }
  });
});

describe('criteria render', () => {
  const parsed = JSON.parse(CRITERIA_WITH_GAPS);

  it('puts one row per criterion in the table', () => {
    const out = criteria.render(parsed);

    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toMatchObject({ id: 'C1', verdict: 'OK' });
    expect(out.rows[1].verdict).toBe('FALTA');
  });

  it('fails when any criterion is unmet', () => {
    expect(criteria.render(parsed).overall).toBe('FAIL');
  });

  it('writes prose ONLY for criteria that need fixing', () => {
    const out = criteria.render(parsed);

    expect(out.details).toHaveLength(1);
    expect(out.details[0].id).toBe('C2');
    expect(out.details[0].body).toContain('422');
  });

  it('emits no prose at all when everything passes', () => {
    const clean = {
      overall: 'PASS',
      criteria: [{ id: 'C1', criterion: 'x', verdict: 'met', evidence: 'a.cs:1' }],
    };

    const out = criteria.render(clean);

    expect(out.overall).toBe('PASS');
    expect(out.details).toEqual([]);
  });

  it('never echoes the task description into the verdict', () => {
    const out = criteria.render(parsed);
    const serialized = JSON.stringify(out);

    expect(serialized).not.toContain('El listado de pólizas');
  });

  it('rejects a verdict without a criteria array', () => {
    expect(criteria.render({ overall: 'PASS' })).toBeNull();
  });

  it('builds a prompt from the task description', () => {
    const built = criteria.buildPrompt({
      ...BASE_CTX,
      task: { title: 'Filtrado', description: htmlToText(TASK_HTML_WITH_CRITERIA) },
    });

    expect(built.prompt).toContain('Input mode: explicit');
    expect(built.prompt).toContain('Output format');
  });

  it('builds a prompt from a criteria block, numbering the bullets', () => {
    const built = criteria.buildPrompt({
      ...BASE_CTX,
      task: { criteriaBlock: '- primero\n- segundo\n' },
    });

    expect(built.prompt).toContain('Input mode: explicit');
    expect(built.prompt).toContain('C1. primero');
    expect(built.prompt).toContain('C2. segundo');
  });

  // A task whose description is just its title states no criteria; the check
  // has to infer them, and say so.
  it('switches to inferred mode when the task states no criteria', () => {
    const task = { title: 'Servicio de correo dedicado', description: 'Servicio de correo dedicado' };

    expect(criteria.criteriaModeFor(task)).toBe('inferred');
    expect(criteria.buildPrompt({ ...BASE_CTX, task }).prompt).toContain('Input mode: inferred');
  });

  it('builds a prompt from the title alone', () => {
    const built = criteria.buildPrompt({ ...BASE_CTX, task: { title: 'Solo título' } });

    expect(built.prompt).toContain('Solo título');
    expect(built.prompt).toContain('Input mode: inferred');
  });

  it('sends the PR title and body as untrusted evidence', () => {
    const built = criteria.buildPrompt({
      ...BASE_CTX,
      task: { title: 'x', description: htmlToText(TASK_HTML_WITH_CRITERIA) },
      prTitle: 'fix: corrige el filtro',
      prBody: 'Cambié el validador de rango.',
    });

    expect(built.prompt).toContain('UNTRUSTED INPUT');
    expect(built.prompt).toContain('Cambié el validador de rango.');
  });

  it('offers the parent task as context and never as a requirement', () => {
    const built = criteria.buildPrompt({
      ...BASE_CTX,
      task: {
        title: 'Subtarea',
        description: 'algo',
        parent: { id: '3906', title: 'HU-21', description: 'criterios del padre' },
      },
    });

    expect(built.prompt).toContain('Context tasks (background only)');
    expect(built.prompt).toContain('Never judge a criterion of theirs');
    expect(built.prompt).toContain('HU-21');
  });

  // A diff belonging to different work is a misdirected check, not a failed
  // one: listing criteria it was never meant to satisfy buries the real problem.
  it('reports non-correspondence instead of listing unmet criteria', () => {
    const out = criteria.render(
      {
        correspondence: 'mismatch',
        correspondenceReason: 'El diff toca CI y la tarea pide un endpoint.',
        criteria: [],
      },
      { ...BASE_CTX, task: { title: 'x', description: 'y' }, taskRef: { source: 'branch' } },
    );

    expect(out.overall).toBe('FAIL');
    expect(out.counts.mismatch).toBe(1);
    expect(out.rows[0].verdict).toBe('NO CORRESPONDE');
    expect(out.details[0].body).toContain('referencia el id de la');
  });

  it('does not block on incomplete inferred criteria', () => {
    const out = criteria.render(parsed, {
      ...BASE_CTX,
      task: { title: 'Servicio de correo', description: 'Servicio de correo' },
    });

    expect(out.overall).toBe('PASS');
    expect(out.details.length).toBeGreaterThan(0);
    expect(out.emptyMessage).toContain('no enumera criterios');
  });

  it('still blocks on incomplete explicit criteria', () => {
    const out = criteria.render(parsed, {
      ...BASE_CTX,
      task: { title: 'x', description: htmlToText(TASK_HTML_WITH_CRITERIA) },
    });

    expect(out.overall).toBe('FAIL');
  });

  it('refuses to build a prompt with neither source', () => {
    expect(() => criteria.buildPrompt({ ...BASE_CTX, task: {} })).toThrow();
  });

  it('parses bullets in every common list syntax', () => {
    const list = criteria.parseCriteriaList('- uno\n* dos\n1. tres\n2) cuatro\ntexto suelto');

    expect(list).toEqual(['uno', 'dos', 'tres', 'cuatro']);
  });
});

describe('security render', () => {
  it('fails on a high-severity finding', () => {
    const out = security.render(JSON.parse(SECURITY_WITH_HIGH), {});

    expect(out.overall).toBe('FAIL');
    expect(out.counts.blocking).toBe(1);
    expect(out.rows[0].verdict).toBe('ALTA');
  });

  it('passes with no findings and says so', () => {
    const out = security.render(JSON.parse(SECURITY_CLEAN), {});

    expect(out.overall).toBe('PASS');
    expect(out.rows).toEqual([]);
    expect(out.emptyMessage).toContain('Sin hallazgos');
  });

  it('gives every finding its remediation', () => {
    const out = security.render(JSON.parse(SECURITY_WITH_HIGH), {});

    expect(out.details).toHaveLength(2);
    expect(out.details[0].body).toContain('parámetros');
  });

  it('honours a repo-level failOn override', () => {
    const parsed = JSON.parse(SECURITY_WITH_HIGH);
    parsed.overall = 'PASS';

    const out = security.render(parsed, { config: { failOn: [] } });

    expect(out.overall).toBe('PASS');
  });
});

describe('rules render', () => {
  const parsed = JSON.parse(RULES_WITH_VIOLATION);

  it('fails on a violated rule', () => {
    expect(rules.render(parsed).overall).toBe('FAIL');
  });

  it('hides rules the model judged irrelevant', () => {
    const out = rules.render(parsed);

    expect(out.rows).toHaveLength(2);
    expect(out.counts.total).toBe(3);
  });

  it('explains only the violations', () => {
    const out = rules.render(parsed);

    expect(out.details).toHaveLength(1);
    expect(out.details[0].body).toContain('unit of work');
  });

  it('refuses to build a prompt with no rules corpus', () => {
    expect(() => rules.buildPrompt({ ...BASE_CTX, rules: { empty: true } })).toThrow();
  });

  it('passes with an explicit reason when the repo declares no rules', () => {
    const out = rules.noRulesVerdict({ dir: '.claude/rules' });

    expect(out.overall).toBe('PASS');
    expect(out.emptyMessage).toContain('Sin reglas declaradas');
  });
});

describe('prompt hygiene', () => {
  it.each(listChecks())('%s asks for JSON and warns against quoting the diff', (name) => {
    const check = getCheck(name);
    const ctx = {
      ...BASE_CTX,
      task: { criteriaBlock: '- uno\n' },
      rules: { empty: false, text: '### a.md\nregla' },
      coverage: {
        orphans: [
          { name: 'Nuevo', kind: 'method', path: 'src/a.cs', line: 3, signature: 'public void Nuevo()' },
        ],
      },
      duplication: DUPLICATION_CTX,
    };

    const built = check.buildPrompt(ctx);

    expect(built.prompt).toContain('Return ONLY a single JSON object');
    expect(built.prompt).toContain('Never quote the diff back');
    expect(built.system.length).toBeGreaterThan(80);
  });
});

describe('quality render', () => {
  const withHigh = {
    overall: 'FAIL',
    summary: 'Un método hace tres cosas.',
    findings: [
      {
        severity: 'high',
        issue: 'Reintento no idempotente',
        location: 'src/Pagos.cs:88',
        recommendation: 'Usa una clave de idempotencia por operación.',
      },
      {
        severity: 'low',
        issue: 'Número mágico sin nombre',
        location: 'src/Pagos.cs:12',
        recommendation: 'Extrae 3600 a una constante.',
      },
    ],
  };

  it('puts one row per finding and prose for all of them', () => {
    const out = quality.render(withHigh);

    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({ id: 'Q1', verdict: 'ALTA' });
    expect(out.details).toHaveLength(2);
  });

  // Blocking on every naming preference from day one is how a gate teaches
  // people to ignore it, so only high severity turns it red.
  it('blocks only on high severity', () => {
    expect(quality.render(withHigh).overall).toBe('FAIL');

    const lowOnly = { overall: 'PASS', findings: [withHigh.findings[1]] };
    expect(quality.render(lowOnly).overall).toBe('PASS');
  });

  it('accepts an empty result as a normal outcome', () => {
    const out = quality.render({ overall: 'PASS', findings: [] });

    expect(out.overall).toBe('PASS');
    expect(out.emptyMessage).toContain('Sin observaciones');
  });

  it('rejects a verdict without a findings array', () => {
    expect(quality.render({ overall: 'PASS' })).toBeNull();
  });

  it('declares that vulnerabilities belong to the security check', () => {
    const built = quality.buildPrompt({ ...BASE_CTX, prBody: 'x' });

    expect(built.system).toMatch(/do not report vulnerabilities/i);
    expect(built.system).toMatch(/idempotency/i);
    expect(built.prompt).toContain('UNTRUSTED INPUT');
  });

  it('skips a diff that touches no code', () => {
    expect(quality.meta.requiresCode).toBe(true);
  });
});

describe('duplication render', () => {
  const parsed = {
    overall: 'FAIL',
    summary: 'Un método replica uno existente.',
    findings: [
      {
        symbol: 'CalculateTotal',
        location: 'src/New.cs:10',
        existing: 'ComputeSum',
        existingLocation: 'src/Old.cs:5',
        verdict: 'duplicate',
        recommendation: 'Usa ComputeSum y borra CalculateTotal: sólo cambia el nombre del agregado.',
      },
      {
        symbol: 'Slugify',
        location: 'src/Text.cs:3',
        existing: 'Normalize',
        existingLocation: 'src/Str.cs:8',
        verdict: 'similar',
        recommendation: 'Comparten forma pero no dominio; unirlos acoplaría dos cosas que cambian aparte.',
      },
    ],
  };

  it('names both ends of every pair in the table', () => {
    const out = duplication.render(parsed);

    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].verdict).toBe('DUPLICA');
    expect(out.rows[0].evidence).toContain('src/New.cs:10');
    expect(out.rows[0].evidence).toContain('src/Old.cs:5');
  });

  // A pair the model cleared is information the developer has no action for,
  // and printing it invites arguing with the ones it did flag.
  it('writes prose only for actual duplicates', () => {
    const out = duplication.render(parsed);

    expect(out.details).toHaveLength(1);
    expect(out.details[0].body).toContain('borra CalculateTotal');
  });

  it('passes when nothing is a duplicate', () => {
    const out = duplication.render({ overall: 'PASS', findings: [parsed.findings[1]] });

    expect(out.overall).toBe('PASS');
    expect(out.counts.duplicates).toBe(0);
  });

  it('refuses to build a prompt with no candidate pairs', () => {
    expect(() =>
      duplication.buildPrompt({ ...BASE_CTX, duplication: { findings: [] } }),
    ).toThrow();
  });

  // The existing half of a pair is by definition NOT in the diff, so the prompt
  // has to carry both bodies or the model cannot answer the question at all.
  it('carries both bodies and both locations', () => {
    const built = duplication.buildPrompt({ ...BASE_CTX, duplication: DUPLICATION_CTX });

    expect(built.prompt).toContain('src/New.cs:10');
    expect(built.prompt).toContain('src/Old.cs:5');
    expect(built.prompt).toContain('o.Lines.Sum()');
    expect(built.prompt).toContain('i.Items.Sum()');
  });

  it('says when both halves come from this same pull request', () => {
    const built = duplication.buildPrompt({
      ...BASE_CTX,
      duplication: {
        ...DUPLICATION_CTX,
        findings: [
          {
            ...DUPLICATION_CTX.findings[0],
            matches: [{ ...DUPLICATION_CTX.findings[0].matches[0], introducedHere: true }],
          },
        ],
      },
    });

    expect(built.prompt).toContain('THIS pull request');
  });
});

describe('tests render', () => {
  const parsed = {
    overall: 'FAIL',
    summary: 'Un servicio sin cobertura.',
    symbols: [
      {
        symbol: 'EvaluateAsync',
        location: 'src/Svc.cs:12',
        verdict: 'needs_test',
        suggestion: 'Cubre el caso de vacante sin requisitos, que hoy devuelve 0 sin explicarlo.',
      },
      {
        symbol: 'ScoreDto',
        location: 'src/ScoreDto.cs:1',
        verdict: 'not_needed',
        suggestion: 'Es un contenedor de datos sin lógica.',
      },
    ],
  };

  it('puts every candidate in the table', () => {
    const out = tests.render(parsed);

    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].verdict).toBe('SIN TEST');
    expect(out.rows[1].verdict).toBe('NO APLICA');
  });

  // Explaining why a symbol does NOT need a test is noise the developer has no
  // action for, so only the ones that need one get prose.
  it('writes prose only for the symbols that need a test', () => {
    const out = tests.render(parsed);

    expect(out.details).toHaveLength(1);
    expect(out.details[0].body).toContain('vacante sin requisitos');
  });

  it('passes when nothing needs a test', () => {
    const out = tests.render({ overall: 'PASS', symbols: [parsed.symbols[1]] });

    expect(out.overall).toBe('PASS');
  });

  it('refuses to build a prompt with no candidates', () => {
    expect(() => tests.buildPrompt({ ...BASE_CTX, coverage: { orphans: [] } })).toThrow();
  });

  it('lists the candidates it was given', () => {
    const built = tests.buildPrompt({
      ...BASE_CTX,
      coverage: {
        orphans: [
          { name: 'EvaluateAsync', kind: 'method', path: 'src/Svc.cs', line: 12, signature: 'public async Task Evaluate()' },
        ],
      },
    });

    expect(built.prompt).toContain('EvaluateAsync');
    expect(built.prompt).toContain('src/Svc.cs:12');
  });
});

// Output tokens are 12% of what we send and 46% of what we pay. Four of the six
// checks were paying for prose that `render()` then discarded: an explanation is
// only ever published for entries that need fixing.
describe('outputFormat asks for prose only where it will be published', () => {
  it('names the actionable field and when it is owed', () => {
    const out = outputFormat('{}', 'inst', {
      detail: { field: 'reasoning', when: '"status" is "violated"' },
    });

    expect(out).toContain('"reasoning" is the only text the developer reads');
    expect(out).toContain('ONLY for entries where "status" is "violated"');
    expect(out).toContain('Omit "reasoning" entirely on every other entry');
  });

  // On `security` and `quality` a finding only exists when something is wrong, so
  // every one of them owes its remediation. Telling the model to omit it "on other
  // entries" there would be a instruction with no referent.
  it('asks for it on every entry when every entry is actionable', () => {
    const out = outputFormat('{}', 'inst', { detail: { field: 'recommendation' } });

    expect(out).toContain('for every entry you report');
    expect(out).not.toContain('Omit "recommendation"');
  });

  // The saving must never come out of the failure description — that is the one
  // thing a developer reads to fix the problem.
  it('still asks for a specific, actionable explanation', () => {
    const out = outputFormat('{}', 'inst', { detail: { field: 'recommendation' } });

    expect(out).toContain('the concrete change that resolves it');
    expect(out).toContain('under 300 characters');
  });

  it('drops the summary on a pass', () => {
    expect(outputFormat('{}', 'inst')).toContain(
      'only when "overall" is "FAIL"',
    );
  });

  it('works without a detail spec', () => {
    const out = outputFormat('{}', 'inst');

    expect(out).toContain('## Output format');
    expect(out).not.toContain('the only text the developer reads');
  });
});

describe('every check declares which field is the actionable one', () => {
  const buildFor = (name) =>
    getCheck(name).buildPrompt({
      ...BASE_CTX,
      task: { criteriaBlock: '- uno' },
      rules: { empty: false, text: '### a.md\nregla' },
      coverage: {
        orphans: [
          { name: 'Nuevo', kind: 'method', path: 'src/a.cs', line: 3, signature: 'public void Nuevo()' },
        ],
      },
      duplication: DUPLICATION_CTX,
    });

  const CHECKS = {
    criteria: 'reasoning',
    security: 'recommendation',
    rules: 'reasoning',
    quality: 'recommendation',
    duplication: 'recommendation',
    tests: 'suggestion',
  };

  it.each(Object.entries(CHECKS))('%s asks for "%s"', (name, field) => {
    const built = buildFor(name);

    expect(built.prompt).toContain(`"${field}" is the only text the developer reads`);
  });
});

// A pull request was blocked over an acceptance criterion the model itself had
// marked MANUAL — "the diff does not prove the existing tests still pass", which
// is true of every diff — while `failOn` for that check is not_met and partial.
// A gate that blocks for a reason it cannot name teaches people to ignore it.
describe('resolveOverall', () => {
  it('fails when something the check blocks on was found', () => {
    expect(resolveOverall('PASS', [{ x: 1 }])).toEqual({ overall: 'FAIL', note: null });
  });

  it('refuses to fail on the model word alone', () => {
    const out = resolveOverall('FAIL', []);

    expect(out.overall).toBe('PASS');
  });

  // Reported, not dropped: the model saw something, and a reviewer deserves to
  // know it did even when it does not stop the merge.
  it('declares the disagreement instead of swallowing it', () => {
    expect(resolveOverall('FAIL', []).note).toContain('ninguna entrada quedó en un estado');
  });

  it('says nothing when model and evidence agree', () => {
    expect(resolveOverall('PASS', [])).toEqual({ overall: 'PASS', note: null });
  });
});

describe('a MANUAL criterion does not block the merge', () => {
  const manualOnly = {
    overall: 'FAIL',
    summary: 'no puedo comprobar los tests desde el diff',
    criteria: [
      { id: 'C1', criterion: 'Login entrega cookie', verdict: 'met', evidence: 'a.cs:1' },
      { id: 'C4', criterion: 'Los tests siguen pasando', verdict: 'manual', evidence: 'no evidence in diff' },
    ],
  };

  it('passes, because manual is not what this check fails on', () => {
    expect(criteria.render(manualOnly, { task: { criteriaBlock: '- a\n- b' } }).overall).toBe('PASS');
  });

  it('still fails when a criterion is genuinely unmet', () => {
    const withGap = {
      ...manualOnly,
      criteria: [{ id: 'C1', criterion: 'x', verdict: 'not_met', evidence: 'ninguna' }],
    };

    expect(criteria.render(withGap, { task: { criteriaBlock: '- a' } }).overall).toBe('FAIL');
  });
});

// `cell()` truncates by character count, which published fragments like
// "…AuthController.cs:172; Inm" — text that reads as a path and is not one.
describe('evidence', () => {
  it('cuts on the separator and says how many were dropped', () => {
    const out = evidence('src/Muy/Largo/AuthController.cs:172; src/Otro/Archivo.cs:44; src/Tercero.cs:9', 50);

    expect(out).toContain('más');
    // Cada ubicación conservada está entera, no en fragmentos: termina en su
    // número de línea. El aviso de cuántas faltan va al final, tras un espacio.
    const kept = out.replace(/\s*\+\d+ más$/, '').split(/\s*;\s*/).filter(Boolean);
    expect(kept.length).toBeGreaterThan(0);
    for (const part of kept) expect(part).toMatch(/\.cs:\d+$/);
  });

  it('keeps the end of a single location too long to fit', () => {
    const out = evidence('src/' + 'x'.repeat(200) + '/Archivo.cs:12', 40);

    expect(out.startsWith('…')).toBe(true);
    expect(out).toContain('Archivo.cs:12');
  });

  it('leaves something that already fits alone', () => {
    expect(evidence('a.cs:1; b.cs:2', 110)).toBe('a.cs:1; b.cs:2');
  });

  it('never exceeds its budget by more than the tail it announces', () => {
    const long = Array.from({ length: 20 }, (_, i) => `src/File${i}.cs:${i}`).join('; ');

    expect(evidence(long, 90).length).toBeLessThanOrEqual(100);
  });
});
