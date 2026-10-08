import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDuplicationContext,
  MAX_PAIRS,
  MIN_TOKENS_EXPORTED,
  MIN_TOKENS_PRIVATE,
} from '../src/context/duplication.mjs';
import { buildSymbolIndex, inlineIgnore } from '../src/context/symbol-index.mjs';
import { changedLinesByFile, spanChange } from '../src/symbols/index.mjs';
import { makeRepo } from './fixtures/repo.mjs';

let repo;
let scratch;
afterEach(() => {
  repo?.cleanup();
  repo = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function diffOf(dir) {
  return execFileSync('git', ['-C', dir, 'diff', 'base...feature'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

const pairsOf = (out) =>
  out.findings.flatMap((f) => f.matches.map((m) => `${f.symbol.name}->${m.candidate.name}`));

describe('changedLinesByFile', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,6 +1,6 @@',
    ' function a() {',
    '-  return 1',
    '+  return 2',
    ' }',
    ' function b() {',
    '-  old()',
    ' }',
    '+function c() {}',
  ].join('\n');

  it('numbers added lines and anchors removed ones on the new side', () => {
    const changes = changedLinesByFile(patch).get('src/a.ts');
    expect([...changes.added]).toEqual([2, 6]);
    // `return 1` stood where `return 2` stands; `old()` stood where line 5 is now.
    expect([...changes.removed]).toEqual([2, 5]);
  });
});

describe('spanChange', () => {
  const changes = { added: new Set([10, 20]), removed: new Set([31, 40]) };

  it('reads an added declaration line as added', () => {
    expect(spanChange({ line: 10, span: [10, 15] }, changes)).toBe('added');
  });

  it('reads an added line inside the span as modified', () => {
    expect(spanChange({ line: 18, span: [18, 22] }, changes)).toBe('modified');
  });

  it('reads a removal inside the span as modified', () => {
    expect(spanChange({ line: 30, span: [30, 35] }, changes)).toBe('modified');
  });

  // A removal anchors on the line that now stands where it was, so a line
  // removed right above a declaration anchors on the declaration itself.
  it('does not read a removal just above the declaration as touching it', () => {
    expect(spanChange({ line: 40, span: [40, 45] }, changes)).toBeNull();
  });

  it('reads a symbol the diff does not reach as untouched', () => {
    expect(spanChange({ line: 50, span: [50, 60] }, changes)).toBeNull();
    expect(spanChange({ line: 50, span: [50, 60] }, undefined)).toBeNull();
  });

  it('falls back to the declaration line when there is no span', () => {
    expect(spanChange({ line: 20 }, changes)).toBe('added');
    expect(spanChange({ line: 21 }, changes)).toBeNull();
  });
});

const INVOICE = `namespace App;

public class InvoiceService
{
    public decimal ComputeSum(Invoice invoice)
    {
        decimal acumulado = 0;
        foreach (var item in invoice.Items)
        {
            acumulado += item.Amount * item.Count;
        }
        return acumulado;
    }
}
`;

const ORDER_BEFORE = `namespace App;

public class OrderService
{
    public decimal CalculateTotal(Order order)
    {
        return order.Total;
    }
}
`;

const ORDER_AFTER = `namespace App;

public class OrderService
{
    public decimal CalculateTotal(Order order)
    {
        decimal total = 0;
        foreach (var line in order.Lines)
        {
            total += line.Price * line.Quantity;
        }
        return total;
    }
}
`;

describe('buildDuplicationContext: touched spans', () => {
  // The case the declaration-line rule missed: the method already existed and
  // its body was rewritten into a copy of another one.
  it('compares a method whose body was rewritten, marked as modified', () => {
    repo = makeRepo({
      baseFiles: { 'src/InvoiceService.cs': INVOICE, 'src/OrderService.cs': ORDER_BEFORE },
      featureFiles: { 'src/OrderService.cs': ORDER_AFTER },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const finding = out.findings.find((f) => f.symbol.name === 'CalculateTotal');

    expect(finding).toBeDefined();
    expect(finding.symbol.change).toBe('modified');
    expect(finding.matches[0].candidate.name).toBe('ComputeSum');
  });

  it('leaves out a file change that reaches no function', () => {
    repo = makeRepo({
      baseFiles: { 'src/InvoiceService.cs': INVOICE, 'src/OrderService.cs': ORDER_AFTER },
      featureFiles: { 'src/OrderService.cs': `using System;\n${ORDER_AFTER}` },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.introduced).toBe(0);
    expect(out.findings).toEqual([]);
  });
});

describe('buildDuplicationContext: every scope', () => {
  it('finds a copied private C# method', () => {
    const existing = INVOICE.replace('public decimal ComputeSum', 'private decimal ComputeSum');
    const copy = ORDER_AFTER.replace('public decimal CalculateTotal', 'decimal CalculateTotal');

    repo = makeRepo({
      baseFiles: { 'src/InvoiceService.cs': existing },
      featureFiles: { 'src/OrderService.cs': copy },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const finding = out.findings.find((f) => f.symbol.name === 'CalculateTotal');

    expect(finding.symbol).toMatchObject({ scope: 'private', change: 'added' });
    expect(finding.matches[0].candidate).toMatchObject({ name: 'ComputeSum', scope: 'private' });
  });

  // Two composables that each keep their own currency formatter as an inner
  // function — the shape a copy takes most often in a front end.
  it('finds a formatter copied between the inner functions of two composables', () => {
    const helper = (name, guard) => `export function ${name}() {
  const base = useConfig()

  function formatCurrency(value: number${guard ? ' | null' : ''}): string {${guard ? "\n    if (value == null) return '-'" : ''}
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value)
  }

  return { base, formatCurrency }
}
`;

    repo = makeRepo({
      baseFiles: { 'composables/usePropertyCard.ts': helper('usePropertyCard', true) },
      featureFiles: { 'composables/usePageSchema.ts': helper('usePageSchema', false) },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const finding = out.findings.find(
      (f) => f.symbol.name === 'formatCurrency' && f.symbol.path === 'composables/usePageSchema.ts',
    );

    expect(finding).toBeDefined();
    expect(finding.symbol).toMatchObject({ scope: 'inner', container: 'usePageSchema' });
    expect(finding.matches[0].candidate).toMatchObject({ name: 'formatCurrency', container: 'usePropertyCard' });
    expect(finding.matches[0].score).toBeGreaterThanOrEqual(0.7);
  });

  it('finds a NestJS service method copied into another service', () => {
    const service = (cls, method) => `@Injectable()
export class ${cls} {
  constructor(private readonly repo: Repo) {}

  async ${method}(tenantId: string, page: number): Promise<Item[]> {
    const items = await this.repo.find({ where: { tenantId } })
    const start = (page - 1) * 20
    return items.filter((i) => i.active).slice(start, start + 20)
  }
}
`;

    repo = makeRepo({
      baseFiles: { 'src/catalog.service.ts': service('CatalogService', 'listActive') },
      featureFiles: { 'src/inventory.service.ts': service('InventoryService', 'pageOfActive') },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toContain('pageOfActive->listActive');
  });

  it('finds a <script setup> function that copies an exported helper', () => {
    const body = `{
  const date = new Date(value)
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return \`\${day}/\${month}/\${date.getFullYear()}\`
}`;

    repo = makeRepo({
      baseFiles: { 'src/utils/date.ts': `export function formatDate(value: string) ${body}\n` },
      featureFiles: {
        'src/components/EventCard.vue': `<template>\n  <p>{{ when }}</p>\n</template>\n\n<script setup lang="ts">\nfunction formatearFecha(value: string) ${body}\n</script>\n`,
      },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const finding = out.findings.find((f) => f.symbol.name === 'formatearFecha');

    expect(finding.symbol).toMatchObject({ scope: 'private', container: 'EventCard', line: 6 });
    expect(finding.matches[0].candidate.name).toBe('formatDate');
  });
});

describe('buildDuplicationContext: token floors', () => {
  const tiny = (exported, name) => `${exported ? 'export ' : ''}function ${name}(n: number) {
  return n + 1
}
`;

  it('holds private symbols to the higher floor', () => {
    expect(MIN_TOKENS_EXPORTED).toBe(8);
    expect(MIN_TOKENS_PRIVATE).toBe(16);

    repo = makeRepo({
      baseFiles: { 'src/a.ts': tiny(false, 'increment') },
      featureFiles: { 'src/b.ts': tiny(false, 'bump') },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.introduced).toBe(0);
    expect(out.findings).toEqual([]);
  });

  it('compares the same short body when both are exported', () => {
    repo = makeRepo({
      baseFiles: { 'src/a.ts': tiny(true, 'increment') },
      featureFiles: { 'src/b.ts': tiny(true, 'bump') },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toEqual(['bump->increment']);
  });
});

describe('buildDuplicationContext: caps', () => {
  const body = `{
  let total = 0
  for (const item of items) {
    if (item.active) total += item.price * item.qty
  }
  return Math.round(total * 100) / 100
}`;

  const copies = (exported, count, prefix) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `src/${prefix}${i}.ts`,
        `${exported ? 'export ' : ''}function ${prefix}Sum${i}(items: Item[]) ${body}\n`,
      ]),
    );

  it('keeps at most 3 candidates for a private symbol and declares the cut', () => {
    repo = makeRepo({
      baseFiles: copies(false, 6, 'old'),
      featureFiles: { 'src/new.ts': `function freshSum(items: Item[]) ${body}\n` },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const finding = out.findings.find((f) => f.symbol.name === 'freshSum');

    expect(finding.matches).toHaveLength(3);
    expect(out.truncation.candidates).toBeGreaterThan(0);
  });

  it('keeps up to 5 for an exported one', () => {
    repo = makeRepo({
      baseFiles: copies(true, 7, 'old'),
      featureFiles: { 'src/new.ts': `export function freshSum(items: Item[]) ${body}\n` },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.findings.find((f) => f.symbol.name === 'freshSum').matches).toHaveLength(5);
  });

  it(`keeps at most ${MAX_PAIRS} pairs per run and says how many it dropped`, () => {
    repo = makeRepo({
      baseFiles: copies(true, 5, 'old'),
      featureFiles: copies(true, 4, 'added'),
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });
    const total = out.findings.reduce((n, f) => n + f.matches.length, 0);

    expect(total).toBe(MAX_PAIRS);
    expect(out.pairsTruncated).toBe(true);
    expect(out.truncation.pairs).toBeGreaterThan(0);
  });
});

describe('inline ignore', () => {
  it('reads a reason on the line above, through decorators and doc lines', () => {
    const lines = [
      '// pr-validator-ignore duplication: mirrors the legacy API on purpose',
      '/** Doc. */',
      '@Memo()',
      'function legacySum() {',
    ];
    expect(inlineIgnore(lines, 3)).toEqual({ reason: 'mirrors the legacy API on purpose', line: 1 });
  });

  it('reads one on the declaration line itself', () => {
    expect(inlineIgnore(['decimal Sum() { // pr-validator-ignore duplication: generated shape'], 0)).toEqual({
      reason: 'generated shape',
      line: 1,
    });
  });

  it('marks an ignore without a reason as invalid', () => {
    expect(inlineIgnore(['/* pr-validator-ignore duplication */', 'function a() {'], 1)).toEqual({ invalid: true, line: 1 });
    expect(inlineIgnore(['// pr-validator-ignore duplication:   ', 'function a() {'], 1)).toEqual({ invalid: true, line: 1 });
  });

  it('does not reach past a line of code', () => {
    const lines = ['// pr-validator-ignore duplication: other one', 'const x = 1', 'function a() {'];
    expect(inlineIgnore(lines, 2)).toBeNull();
  });
});

describe('buildDuplicationContext: inline ignore', () => {
  const body = `{
  let total = 0
  for (const item of items) {
    if (item.active) total += item.price * item.qty
  }
  return total
}`;

  // The ignore was merged with the code it sits on; this change rewrites the
  // body into a copy. The ignore is the base's, so it holds.
  it('drops a symbol whose ignore the base branch carried, and lists it with its reason', () => {
    const ignore = '// pr-validator-ignore duplication: kept apart until the billing split lands\n';
    repo = makeRepo({
      baseFiles: {
        'src/a.ts': `export function sumActive(items: Item[]) ${body}\n`,
        'src/b.ts': `${ignore}export function totalActive(items: Item[]) {\n  return items.length\n}\n`,
      },
      featureFiles: { 'src/b.ts': `${ignore}export function totalActive(items: Item[]) ${body}\n` },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.findings).toEqual([]);
    expect(out.headIgnores).toEqual([]);
    expect(out.suppressed).toEqual([
      { path: 'src/b.ts', line: 2, name: 'totalActive', reason: 'kept apart until the billing split lands' },
    ]);
  });

  // A pull request must not declare its own copy acceptable: an ignore the
  // change itself writes is listed, and the symbol is compared anyway.
  it('does not honour an ignore the change under review adds', () => {
    repo = makeRepo({
      baseFiles: { 'src/a.ts': `export function sumActive(items: Item[]) ${body}\n` },
      featureFiles: {
        'src/b.ts': `// pr-validator-ignore duplication: kept apart until the billing split lands\nexport function totalActive(items: Item[]) ${body}\n`,
      },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toEqual(['totalActive->sumActive']);
    expect(out.suppressed).toEqual([]);
    expect(out.headIgnores).toEqual([
      { path: 'src/b.ts', line: 2, name: 'totalActive', reason: 'kept apart until the billing split lands' },
    ]);
  });

  it('does not honour an ignore whose reason the change rewrites', () => {
    repo = makeRepo({
      baseFiles: {
        'src/a.ts': `export function sumActive(items: Item[]) ${body}\n`,
        'src/b.ts': '// pr-validator-ignore duplication: old reason\nexport function totalActive(items: Item[]) {\n  return 0\n}\n',
      },
      featureFiles: {
        'src/b.ts': `// pr-validator-ignore duplication: new reason\nexport function totalActive(items: Item[]) ${body}\n`,
      },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toEqual(['totalActive->sumActive']);
    expect(out.headIgnores.map((entry) => entry.reason)).toEqual(['new reason']);
  });

  it('still compares a symbol whose ignore gives no reason, and reports the ignore', () => {
    repo = makeRepo({
      baseFiles: { 'src/a.ts': `export function sumActive(items: Item[]) ${body}\n` },
      featureFiles: { 'src/b.ts': `// pr-validator-ignore duplication\nexport function totalActive(items: Item[]) ${body}\n` },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toEqual(['totalActive->sumActive']);
    expect(out.invalidSuppressions).toEqual([{ path: 'src/b.ts', line: 2, name: 'totalActive' }]);
  });

  // An ignore speaks for the code it sits on. On the EXISTING half it must not
  // hide every future copy of it.
  it('does not let an ignore on the existing symbol hide a new copy', () => {
    repo = makeRepo({
      baseFiles: { 'src/a.ts': `// pr-validator-ignore duplication: old reason\nexport function sumActive(items: Item[]) ${body}\n` },
      featureFiles: { 'src/b.ts': `export function totalActive(items: Item[]) ${body}\n` },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toEqual(['totalActive->sumActive']);
  });
});

describe('buildDuplicationContext: homonym pass', () => {
  it('runs the default pass, and passes the touched symbols and the index to a replacement', () => {
    repo = makeRepo({
      baseFiles: { 'src/a.ts': 'export function formatDate(v: string) {\n  return v.slice(0, 10)\n}\n' },
      featureFiles: { 'src/b.ts': "export function formatDate(v: string) {\n  return new Date(v).toLocaleDateString('es')\n}\n" },
    });

    const diffText = diffOf(repo.dir);
    // Wired by default: the two `formatDate` helpers do different things.
    const wired = buildDuplicationContext({ diffText, repo: repo.dir }).homonyms;
    expect(wired.map((pair) => [pair.name, pair.symbol.path, pair.candidate.path])).toEqual([
      ['formatDate', 'src/b.ts', 'src/a.ts'],
    ]);
    // And it can be switched off.
    expect(buildDuplicationContext({ diffText, repo: repo.dir, homonymPass: null }).homonyms).toEqual([]);

    let received = null;
    const out = buildDuplicationContext({
      diffText,
      repo: repo.dir,
      homonymPass: (input) => {
        received = input;
        return [{ kind: 'homonym', name: 'formatDate' }];
      },
    });

    expect(out.homonyms).toEqual([{ kind: 'homonym', name: 'formatDate' }]);
    expect(received.symbols.map((s) => s.path)).toEqual(['src/b.ts']);
    expect(received.index.map((s) => s.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('buildSymbolIndex: cacheDir', () => {
  it('keeps no cache by default', () => {
    repo = makeRepo({ baseFiles: { 'src/a.ts': 'export function a() {\n  return 1\n}\n' } });
    const index = buildSymbolIndex({ repo: repo.dir });
    expect(index.symbols.map((s) => s.name)).toEqual(['a']);
  });

  it('reuses a file whose content has not changed and rereads one that has', () => {
    repo = makeRepo({ baseFiles: { 'src/a.ts': 'export function a() {\n  return 1\n}\n' } });
    scratch = mkdtempSync(join(tmpdir(), 'prv-cache-'));

    buildSymbolIndex({ repo: repo.dir, cacheDir: scratch });
    const file = join(scratch, 'symbol-index.json');
    const cache = JSON.parse(readFileSync(file, 'utf8'));
    expect(cache.files['src/a.ts'].symbols[0].name).toBe('a');

    // Tamper with the cached entry: a hit returns it as stored.
    cache.files['src/a.ts'].symbols[0].name = 'fromCache';
    writeFileSync(file, JSON.stringify(cache));
    expect(buildSymbolIndex({ repo: repo.dir, cacheDir: scratch }).symbols[0].name).toBe('fromCache');

    // A changed file misses the cache, whatever it holds.
    writeFileSync(join(repo.dir, 'src/a.ts'), 'export function b() {\n  return 2\n}\n');
    expect(buildSymbolIndex({ repo: repo.dir, cacheDir: scratch }).symbols[0].name).toBe('b');
  });
});
