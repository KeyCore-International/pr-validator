// What the duplication comparison leaves out, and how it says so.
//
// One-statement delegation, a container paired with its own inner function,
// same-file siblings, the wall-clock budget and the notes that declare caps
// and inline ignores. Each one was a false positive, a false negative or a
// silent cut found by replaying real pull requests through the context.

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { contextNotes, duplicationNotes, shortCircuit } from '../src/checks/short-circuit.mjs';
import { buildDuplicationContext, isDelegation } from '../src/context/duplication.mjs';
import { buildSymbolIndex } from '../src/context/symbol-index.mjs';
import { makeRepo } from './fixtures/repo.mjs';

let repo;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function diffOf(dir) {
  return execFileSync('git', ['-C', dir, 'diff', 'base...feature'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

const pairsOf = (out) =>
  out.findings.flatMap((f) => f.matches.map((m) => `${f.symbol.name}->${m.candidate.name}`));

const fn = (body) => ({ name: 'f', kind: 'function', exported: true, signature: '', body });

describe('isDelegation', () => {
  it('reads a routed call or a single assignment as delegation', () => {
    expect(isDelegation(fn("export function goToSync() {\n  router.push({ name: 'sync-history', params: { id } })\n}"))).toBe(true);
    expect(isDelegation(fn("const handleRetry = () => {\n  emit('retry')\n}"))).toBe(true);
    expect(isDelegation(fn('export const getSyncStatus = (id: string) => apiService.get(buildSyncUrl(id))'))).toBe(true);
    expect(isDelegation(fn('const handleFailed = (): void => { statusFailed.value = true; };'))).toBe(true);
    expect(isDelegation(fn('public Task<Order> Get(Guid id) { return _repository.GetByIdAsync(id); }'))).toBe(true);
    // A discarded promise is still one routed call.
    expect(isDelegation(fn("const goToSync = (): void => {\n  void router.push({ name: 'sync', params: { id: id.value } });\n};"))).toBe(true);
  });

  it('does not read a one-statement body with logic, or two statements, as delegation', () => {
    const money =
      "export function money(v: number) {\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v)\n}";

    expect(isDelegation(fn(money))).toBe(false);
    expect(isDelegation(fn('export const total = (a: number, b: number) => a * b + 1'))).toBe(false);
    expect(isDelegation(fn('export function load() {\n  loading.value = true\n  fetchAll()\n}'))).toBe(false);
    expect(isDelegation(fn('export const names = (rows: Row[]) => rows.map((r) => r.name)'))).toBe(false);
    expect(isDelegation(fn('export function pick(a: A) {\n  if (a.x) return a.x\n  return a.y\n}'))).toBe(false);
  });
});

describe('buildDuplicationContext: one-statement delegation', () => {
  it('does not pair router navigations that differ only in the route name', () => {
    const nav = (name, route) =>
      `export function ${name}() {\n  router.push({ name: '${route}', params: { id: props.id } })\n}\n`;
    repo = makeRepo({
      baseFiles: { 'src/views/a.ts': nav('goBack', 'listing') + nav('goToHistory', 'history') },
      featureFiles: { 'src/views/b.ts': nav('goToSync', 'sync') },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.introduced).toBe(0);
    expect(out.findings).toEqual([]);
  });

  // The private floor is measured past the head: a one-line handler is nine
  // tokens of head and a few of body.
  it('does not pair one-line handlers inside components', () => {
    const component = (name, flag) =>
      `export function ${name}() {\n  const ${flag} = ref(false)\n  const handle${name} = (): void => {\n    ${flag}.value = true\n  }\n  return { handle${name} }\n}\n`;
    repo = makeRepo({
      baseFiles: { 'src/a.ts': component('useA', 'failed') },
      featureFiles: { 'src/b.ts': component('useB', 'opened') },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).not.toContain('handleuseB->handleuseA');
  });
});

describe('buildDuplicationContext: nesting and same-file siblings', () => {
  const helper = [
    '  function resolveImage(path: string | null): string {',
    "    if (!path) return '/images/placeholder.jpg'",
    "    return path.startsWith('http') ? path : `${apiUrl}${path}`",
    '  }',
  ].join('\n');

  const composable = (name, extra = '') =>
    `export function ${name}() {\n  const { apiUrl } = useRuntimeConfig().public\n${extra}\n${helper}\n\n  return { resolveImage }\n}\n`;

  // Touching an inner helper marks its container modified too, and the
  // container's window holds the helper's body: they used to pair.
  it('never pairs a container with a function declared inside it', () => {
    // Scored alone, `useLeads` against `getLeads` is about 0.71: one name, and a
    // window that holds the inner body.
    const leads = (size) =>
      [
        'export function useLeads() {',
        '  const leads = ref([])',
        '  const getLeads = async (page: number) => {',
        `    const response = await leadService.list({ page, size: ${size} })`,
        '    leads.value = response.data.items.filter((l) => l.active)',
        '    total.value = response.data.total',
        '    return leads.value',
        '  }',
        '  return { leads, getLeads }',
        '}',
        '',
      ].join('\n');
    repo = makeRepo({
      baseFiles: { 'composables/useLeads.ts': leads(10) },
      featureFiles: { 'composables/useLeads.ts': leads(20) },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const pairs = out.findings.flatMap((f) =>
      f.matches.map((m) => [f.symbol.name, m.candidate.name].sort().join('~')),
    );

    expect(out.introduced).toBe(2);
    expect(pairs).not.toContain('getLeads~useLeads');
  });

  // Same path, name and kind used to mean "the same declaration". With inner
  // helpers indexed, two of them in one file are two functions.
  it('pairs an inner helper copied next to an identical one in the same file', () => {
    repo = makeRepo({
      baseFiles: { 'composables/useData.ts': composable('useDataHome') },
      featureFiles: {
        'composables/useData.ts': `${composable('useDataHome')}\n${composable('useDataDetail', '  const ready = ref(true)')}`,
      },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const finding = out.findings.find((f) => f.symbol.name === 'resolveImage' && f.symbol.container === 'useDataDetail');

    expect(finding, pairsOf(out).join(', ')).toBeDefined();
    expect(finding.matches[0].candidate).toMatchObject({ name: 'resolveImage', container: 'useDataHome' });
  });
});

describe('buildDuplicationContext: budget', () => {
  it('starts the budget before the index, and declares a run that spent it', () => {
    repo = makeRepo({
      baseFiles: { 'src/a.ts': 'export function a(n: number) {\n  return Math.round(n * 100) / 100\n}\n' },
      featureFiles: { 'src/b.ts': 'export function b(n: number) {\n  return Math.round(n * 100) / 100\n}\n' },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir, budgetMs: 0 });

    expect(out.comparisonTruncated).toBe(true);
    expect(out.indexTruncated).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it('stops reading files once the deadline has passed', () => {
    repo = makeRepo({ baseFiles: { 'src/a.ts': 'export function a() {\n  return 1\n}\n' } });

    const index = buildSymbolIndex({ repo: repo.dir, deadline: Date.now() - 1 });

    expect(index).toMatchObject({ symbols: [], truncated: true, timedOut: true });
  });
});

describe('duplication notes', () => {
  const check = { meta: { title: 'Duplicación', contextNeeds: ['duplication'] } };
  const empty = {
    indexed: 40,
    indexTruncated: false,
    comparisonTruncated: false,
    introduced: 0,
    findings: [],
    truncation: { candidates: 0, pairs: 0 },
    pairsTruncated: false,
    suppressed: [],
    headIgnores: [],
    invalidSuppressions: [],
  };

  it('says the touched symbols were suppressed instead of claiming none were comparable', () => {
    const duplication = {
      ...empty,
      suppressed: [{ path: 'src/b.ts', line: 2, name: 'totalActive', reason: 'kept apart until the split' }],
    };
    const reason = shortCircuit({ name: 'duplication', check, inputs: {}, ctx: { duplication } }).notes[0];

    expect(reason).toContain('1 símbolo(s) tocado(s) quedaron excluidos');
    expect(reason).toContain('`src/b.ts:2` totalActive');
    expect(reason).toContain('kept apart until the split');
    expect(reason).not.toContain('no introduce símbolos');
  });

  it('declares the caps, the ignores the branch added and the ignores without a reason', () => {
    const duplication = {
      ...empty,
      introduced: 3,
      findings: [{ symbol: {}, matches: [{}] }],
      truncation: { candidates: 2, pairs: 21 },
      pairsTruncated: true,
      headIgnores: [{ path: 'src/c.ts', line: 7, name: 'copy', reason: 'mine is fine' }],
      invalidSuppressions: [{ path: 'src/d.ts', line: 3, name: 'bare' }],
    };
    const notes = contextNotes({ duplication }, {}, 'duplication').join('\n');

    expect(notes).toContain('2 candidato(s) por encima del tope por símbolo');
    expect(notes).toContain('21 par(es) por encima del tope de pares');
    expect(notes).toContain('`src/c.ts:7` copy');
    expect(notes).toContain('no se aplicaron');
    expect(notes).toContain('`src/d.ts:3` bare');
    expect(duplicationNotes(empty)).toEqual([]);
  });

  // End to end through the same short-circuit CI uses: an ignore the branch
  // writes no longer turns the check into a skip.
  it('does not let an ignore the branch adds skip the check', () => {
    const body = `{
  let total = 0
  for (const item of items) {
    if (item.active) total += item.price * item.qty
  }
  return total
}`;
    repo = makeRepo({
      baseFiles: { 'src/a.ts': `export function formatSum(items: Item[]) ${body}\n` },
      featureFiles: {
        'src/b.ts': `// pr-validator-ignore duplication: legacy\nexport function formatTotal(items: Item[]) ${body}\n`,
      },
    });

    const duplication = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(shortCircuit({ name: 'duplication', check, inputs: {}, ctx: { duplication } })).toBeNull();
    expect(contextNotes({ duplication }, {}, 'duplication').join('\n')).toContain('`src/b.ts:2` formatTotal');
  });
});
