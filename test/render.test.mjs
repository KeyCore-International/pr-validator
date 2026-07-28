import { describe, expect, it } from 'vitest';
import * as criteria from '../src/checks/criteria/render.mjs';
import * as security from '../src/checks/security/render.mjs';
import * as rules from '../src/checks/rules/render.mjs';
import { getCheck, listChecks, sortChecks, UnknownCheckError } from '../src/checks/registry.mjs';
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

describe('registry', () => {
  it('exposes the implemented checks in display order', () => {
    expect(listChecks()).toEqual(['criteria', 'security', 'rules']);
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
      task: { description: htmlToText(TASK_HTML_WITH_CRITERIA) },
    });

    expect(built.system).toContain('task DESCRIPTION');
    expect(built.prompt).toContain('Task description');
    expect(built.prompt).toContain('Output format');
  });

  it('builds a prompt from a criteria block, numbering the bullets', () => {
    const built = criteria.buildPrompt({
      ...BASE_CTX,
      task: { criteriaBlock: '- primero\n- segundo\n' },
    });

    expect(built.system).toContain('a list of acceptance criteria');
    expect(built.prompt).toContain('C1. primero');
    expect(built.prompt).toContain('C2. segundo');
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
    };

    const built = check.buildPrompt(ctx);

    expect(built.prompt).toContain('Return ONLY a single JSON object');
    expect(built.prompt).toContain('Do not quote the diff back');
    expect(built.system.length).toBeGreaterThan(80);
  });
});
