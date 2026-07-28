import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXIT,
  STATUS,
  exitCodeFor,
  isBlockingFailure,
  isValidVerdict,
  makeVerdict,
  skippedVerdict,
  toolErrorVerdict,
} from '../src/report/verdict.mjs';
import { collectVerdicts } from '../src/report.mjs';
import { runCheck } from '../src/run-check.mjs';
import { makeRepo } from './fixtures/repo.mjs';

const ok = (over = {}) =>
  makeVerdict({ check: 'x', title: 'X', status: STATUS.PASS, blocking: true, ...over });

describe('verdict shape', () => {
  it('rejects a verdict with no check name', () => {
    expect(() => makeVerdict({ title: 'X', status: STATUS.PASS, blocking: true })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => makeVerdict({ check: 'x', status: 'weird', blocking: true })).toThrow();
  });

  it('defaults the collections so consumers never guard for undefined', () => {
    const verdict = ok();

    expect(verdict.rows).toEqual([]);
    expect(verdict.details).toEqual([]);
    expect(verdict.notes).toEqual([]);
  });
});

describe('exit codes', () => {
  it('passes with 0', () => {
    expect(exitCodeFor(ok())).toBe(EXIT.PASS);
  });

  it('fails with 1', () => {
    expect(exitCodeFor(ok({ status: STATUS.FAIL }))).toBe(EXIT.FAIL);
  });

  it('reports a tool error with 2', () => {
    const verdict = toolErrorVerdict({ check: 'x', title: 'X', error: 'boom' });

    expect(exitCodeFor(verdict)).toBe(EXIT.TOOL_ERROR);
  });

  it('treats a skip as a pass', () => {
    const verdict = skippedVerdict({ check: 'x', title: 'X', reason: 'nada que hacer' });

    expect(exitCodeFor(verdict)).toBe(EXIT.PASS);
  });
});

describe('blocking', () => {
  it('blocks on a blocking failure', () => {
    expect(isBlockingFailure(ok({ status: STATUS.FAIL }))).toBe(true);
  });

  it('does not block on a non-blocking failure', () => {
    expect(isBlockingFailure(ok({ status: STATUS.FAIL, blocking: false }))).toBe(false);
  });

  it('never blocks on a tool error, whatever the check configured', () => {
    const verdict = toolErrorVerdict({ check: 'x', title: 'X', error: 'gateway caído' });

    expect(verdict.blocking).toBe(false);
    expect(isBlockingFailure(verdict)).toBe(false);
  });

  it('keeps context notes alongside the error', () => {
    const verdict = toolErrorVerdict({
      check: 'x',
      title: 'X',
      error: 'gateway caído',
      notes: ['Diff truncado: 3 archivos fuera.'],
    });

    expect(verdict.notes).toHaveLength(2);
    expect(verdict.notes[1]).toContain('Diff truncado');
  });

  it('does not block on a pass', () => {
    expect(isBlockingFailure(ok())).toBe(false);
  });
});

describe('isValidVerdict', () => {
  it('accepts a well-formed verdict', () => {
    expect(isValidVerdict(ok())).toBe(true);
  });

  // Cases are wrapped in arrays so `each` passes each one as a single
  // argument instead of spreading the object cases into named parameters.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'x'],
    ['an empty object', {}],
    ['a verdict with no status', { check: 'x' }],
    ['a verdict with an unknown status', { check: 'x', status: 'nope' }],
    ['a verdict with no rows array', { check: 'x', status: 'pass', details: [] }],
  ])('rejects %s', (_label, value) => {
    expect(isValidVerdict(value)).toBe(false);
  });
});

describe('collectVerdicts', () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'prv-verdicts-'));
    mkdirSync(join(dir, 'verdict-criteria'), { recursive: true });
    mkdirSync(join(dir, 'verdict-security'), { recursive: true });
    mkdirSync(join(dir, 'verdict-broken'), { recursive: true });

    writeFileSync(join(dir, 'verdict-criteria', 'verdict.json'), JSON.stringify(ok({ check: 'criteria' })));
    writeFileSync(join(dir, 'verdict-security', 'verdict.json'), JSON.stringify(ok({ check: 'security' })));
    writeFileSync(join(dir, 'verdict-broken', 'verdict.json'), '{ not json');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads verdicts from the artifact subdirectories', () => {
    const found = collectVerdicts(dir, { log: () => {} });

    expect(found.map((v) => v.check).sort()).toEqual(['criteria', 'security']);
  });

  it('skips a corrupt artifact instead of failing the whole report', () => {
    expect(() => collectVerdicts(dir, { log: () => {} })).not.toThrow();
  });

  it('returns nothing when the directory does not exist', () => {
    expect(collectVerdicts(join(dir, 'nope'), { log: () => {} })).toEqual([]);
  });
});

describe('runCheck short circuits', () => {
  let repo;

  beforeAll(() => {
    repo = makeRepo({ featureFiles: { 'src/a.txt': 'changed\n' } });
  });

  afterAll(() => repo.cleanup());

  const inputs = (over = {}) => ({
    check: 'security',
    base: 'base',
    head: 'feature',
    repo: repo.dir,
    outFile: 'unused.json',
    headRef: 'feature/1-x',
    prTitle: '',
    prBody: '',
    isFork: false,
    model: '',
    ...over,
  });

  it('reports an unknown check as a tool error, never as a pass', async () => {
    const verdict = await runCheck({ inputs: inputs({ check: 'nope' }), env: {}, log: () => {} });

    expect(verdict.status).toBe(STATUS.TOOL_ERROR);
    expect(verdict.notes[0]).toContain('Disponibles');
  });

  it('skips every AI check on a fork PR', async () => {
    const verdict = await runCheck({ inputs: inputs({ isFork: true }), env: {}, log: () => {} });

    expect(verdict.status).toBe(STATUS.SKIPPED);
    expect(verdict.notes[0]).toContain('fork');
    expect(isBlockingFailure(verdict)).toBe(false);
  });

  it('fails the criteria check when no task can be identified', async () => {
    const verdict = await runCheck({
      inputs: inputs({ check: 'criteria', headRef: 'mejoras-portal' }),
      env: {},
      log: () => {},
    });

    expect(verdict.status).toBe(STATUS.FAIL);
    expect(verdict.blocking).toBe(true);
    expect(verdict.details[0].body).toContain('feature/<id>-<slug>');
  });

  it('skips the criteria check on an exempt branch', async () => {
    const verdict = await runCheck({
      inputs: inputs({ check: 'criteria', headRef: 'chore/pr-validation' }),
      env: {},
      log: () => {},
    });

    expect(verdict.status).toBe(STATUS.SKIPPED);
  });

  it('skips a check when the diff is empty', async () => {
    const verdict = await runCheck({
      inputs: inputs({ base: 'feature', head: 'feature' }),
      env: {},
      log: () => {},
    });

    expect(verdict.status).toBe(STATUS.SKIPPED);
    expect(verdict.notes[0]).toContain('no introduce cambios');
  });

  it('reports a missing gateway key as a tool error, not a failure', async () => {
    const verdict = await runCheck({ inputs: inputs(), env: {}, log: () => {} });

    expect(verdict.status).toBe(STATUS.TOOL_ERROR);
    expect(verdict.notes[0]).toContain('AI_GATEWAY_API_KEY');
    expect(isBlockingFailure(verdict)).toBe(false);
  });

  it('skips the rules check when the repository declares none', async () => {
    const verdict = await runCheck({ inputs: inputs({ check: 'rules' }), env: {}, log: () => {} });

    expect(verdict.status).toBe(STATUS.SKIPPED);
    expect(verdict.notes[0]).toContain('Sin reglas declaradas');
  });
});
