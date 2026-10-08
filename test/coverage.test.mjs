import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crossWithTests, findTestFiles } from '../src/context/coverage.mjs';
import { makeRepo } from './fixtures/repo.mjs';

let repo;
afterEach(() => repo?.cleanup());

const symbol = (name) => ({ name, path: 'src/a.cs', line: 1, kind: 'method', signature: '' });

describe('findTestFiles', () => {
  it.each([
    'test/foo.test.mjs',
    'src/a.spec.ts',
    'tests/OrderTests.cs',
    '__tests__/thing.js',
    'spec/models/user_spec.rb',
  ])('recognises %s as a test file', (path) => {
    repo = makeRepo({ baseFiles: { [path]: 'contenido\n' } });

    expect(findTestFiles(repo.dir)).toContain(path);
  });

  it.each(['src/Service.cs', 'README.md', 'src/latest.ts'])(
    'does not mistake %s for a test file',
    (path) => {
      repo = makeRepo({ baseFiles: { [path]: 'contenido\n' } });

      expect(findTestFiles(repo.dir)).not.toContain(path);
    },
  );

  it('returns nothing outside a git repository', () => {
    expect(findTestFiles('/definitely/not/a/repo')).toEqual([]);
  });
});

describe('crossWithTests', () => {
  // A repository with no suite has nothing to cross against. Reporting every
  // symbol as uncovered would be technically true and completely useless.
  it('reports no suite rather than flagging everything', () => {
    repo = makeRepo({ baseFiles: { 'src/a.cs': 'public class A { }\n' } });

    const out = crossWithTests({ repo: repo.dir, symbols: [symbol('Evaluate')] });

    expect(out.hasTestSuite).toBe(false);
    expect(out.orphans).toEqual([]);
  });

  it('separates mentioned symbols from unmentioned ones', () => {
    repo = makeRepo({
      baseFiles: {
        'tests/AllTests.cs': 'public void Evaluate_devuelve_cero() { new Svc().Evaluate(); }\n',
      },
    });

    const out = crossWithTests({
      repo: repo.dir,
      symbols: [symbol('Evaluate'), symbol('Recalcular')],
    });

    expect(out.hasTestSuite).toBe(true);
    expect(out.covered.map((s) => s.name)).toEqual(['Evaluate']);
    expect(out.orphans.map((s) => s.name)).toEqual(['Recalcular']);
  });

  // Without word boundaries a genuinely untested `Score` would hide behind a
  // mention of `ScoreCalculator`.
  it('does not let a longer name cover a shorter one', () => {
    repo = makeRepo({ baseFiles: { 'tests/A.test.mjs': 'ScoreCalculator()\n' } });

    const out = crossWithTests({ repo: repo.dir, symbols: [symbol('Score')] });

    expect(out.orphans.map((s) => s.name)).toEqual(['Score']);
  });

  // A pull request that adds a symbol and its test together must not report
  // the symbol as uncovered just because the test is not committed yet.
  it('sees test files that exist but are not committed', () => {
    repo = makeRepo({ baseFiles: { 'tests/Old.test.mjs': 'nada\n' } });
    makeUncommitted(repo.dir, 'tests/New.test.mjs', 'Recalcular()\n');

    const out = crossWithTests({ repo: repo.dir, symbols: [symbol('Recalcular')] });

    expect(out.covered.map((s) => s.name)).toEqual(['Recalcular']);
  });

  it('counts the test files it crossed against', () => {
    repo = makeRepo({
      baseFiles: { 'tests/A.test.mjs': 'x\n', 'tests/B.test.mjs': 'y\n' },
    });

    expect(crossWithTests({ repo: repo.dir, symbols: [] }).testFileCount).toBe(2);
  });
});

function makeUncommitted(dir, path, content) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Import-aware mapping, the C# class rule, and the logic filter.
// ---------------------------------------------------------------------------

const LOGIC_TS = (name) => `export function ${name}(date: string): string {
  if (!date) return '-';
  const d = new Date(date);
  return d.toISOString().slice(0, 10);
}
`;

const ts = (name, path, line = 1) => ({ name, path, line, kind: 'function', exported: true, signature: '' });

describe('crossWithTests maps TypeScript tests through their imports', () => {
  const sources = {
    'src/helpers/date.ts': LOGIC_TS('formatDate'),
    'src/legacy/dateHelper.ts': LOGIC_TS('formatDate'),
  };

  it('covers the module the test imports, not a homonym elsewhere', () => {
    repo = makeRepo({
      baseFiles: {
        ...sources,
        'tests/date.test.ts': "import { formatDate } from '../src/helpers/date'\nformatDate('2024-01-01')\n",
      },
    });

    const out = crossWithTests({
      repo: repo.dir,
      symbols: [ts('formatDate', 'src/helpers/date.ts'), ts('formatDate', 'src/legacy/dateHelper.ts')],
    });

    expect(out.covered.map((s) => s.path)).toEqual(['src/helpers/date.ts']);
    expect(out.orphans.map((s) => s.path)).toEqual(['src/legacy/dateHelper.ts']);
  });

  it.each([
    ['an @/ alias', "import { formatDate } from '@/helpers/date'"],
    ['a ~/ alias', "import { formatDate } from '~/helpers/date.ts'"],
    ['a barrel above the module', "import { formatDate } from '@/helpers'"],
    ['a mocked module', "vi.mock('../src/helpers/date')\nconst { formatDate } = await import('x')"],
    ['a require', "const { formatDate } = require('../src/helpers/date')"],
  ])('follows %s', (_, importLine) => {
    repo = makeRepo({ baseFiles: { ...sources, 'tests/date.test.ts': `${importLine}\nformatDate('x')\n` } });

    const out = crossWithTests({ repo: repo.dir, symbols: [ts('formatDate', 'src/helpers/date.ts')] });

    expect(out.covered).toHaveLength(1);
  });

  it('does not count a mention without an import', () => {
    repo = makeRepo({ baseFiles: { ...sources, 'tests/other.test.ts': "import { x } from '../src/other'\n// formatDate\n" } });

    const out = crossWithTests({ repo: repo.dir, symbols: [ts('formatDate', 'src/helpers/date.ts')] });

    expect(out.orphans).toHaveLength(1);
  });

  // Auto-imported folders have no import line to look for.
  it('accepts a bare mention for an auto-imported composable', () => {
    repo = makeRepo({
      baseFiles: {
        'composables/useMoney.ts': LOGIC_TS('useMoney'),
        'tests/money.test.ts': "it('formats', () => { useMoney('1') })\n",
      },
    });

    const out = crossWithTests({ repo: repo.dir, symbols: [ts('useMoney', 'composables/useMoney.ts')] });

    expect(out.covered).toHaveLength(1);
  });
});

describe('crossWithTests maps C# tests through the class', () => {
  const service = `namespace Shop.Pricing;

public class PriceService
{
    public decimal Calculate(decimal price, int quantity)
    {
        if (quantity <= 0) { return 0; }
        return price * quantity;
    }
}
`;
  const method = { name: 'Calculate', path: 'src/Pricing/PriceService.cs', line: 5, kind: 'method', exported: true, signature: '' };

  it('covers a method from <Class>Tests', () => {
    repo = makeRepo({
      baseFiles: {
        'src/Pricing/PriceService.cs': service,
        'tests/Pricing/PriceServiceTests.cs': 'public void Calculate_ReturnsZero_WhenQuantityIsZero() { _sut.Calculate(1, 0); }\n',
      },
    });

    expect(crossWithTests({ repo: repo.dir, symbols: [method] }).covered).toHaveLength(1);
  });

  it('covers a method from a test that names both the class and the method', () => {
    repo = makeRepo({
      baseFiles: {
        'src/Pricing/PriceService.cs': service,
        'tests/CheckoutTests.cs': 'var svc = new PriceService(); svc.Calculate(1, 2);\n',
      },
    });

    expect(crossWithTests({ repo: repo.dir, symbols: [method] }).covered).toHaveLength(1);
  });

  it('does not let a test about another class cover the method', () => {
    repo = makeRepo({
      baseFiles: {
        'src/Pricing/PriceService.cs': service,
        'tests/TaxServiceTests.cs': 'var tax = new TaxService(); tax.Calculate(1, 2);\n',
      },
    });

    expect(crossWithTests({ repo: repo.dir, symbols: [method] }).orphans).toHaveLength(1);
  });
});

describe('crossWithTests crosses only exported, logic-bearing symbols', () => {
  it('lists the rest as exempt, with the reason', () => {
    repo = makeRepo({
      baseFiles: {
        'src/api/orders.ts': [
          'export function listOrders() {', // 1
          '  return http.get(\'/orders\')', // 2
          '}', // 3
          'export function orderTotal(o) {', // 4
          '  return o.price * o.quantity', // 5
          '}', // 6
        ].join('\n'),
        'tests/unrelated.test.ts': "import { x } from '../src/x'\n",
      },
    });

    const out = crossWithTests({
      repo: repo.dir,
      symbols: [
        ts('listOrders', 'src/api/orders.ts', 1),
        ts('orderTotal', 'src/api/orders.ts', 4),
        { ...ts('helper', 'src/api/orders.ts', 4), exported: false },
      ],
    });

    expect(out.orphans.map((s) => s.name)).toEqual(['orderTotal']);
    expect(out.exempt.map((s) => [s.name, s.exemptReason])).toEqual([
      ['listOrders', 'no-logic'],
      ['helper', 'not-exported'],
    ]);
  });

  it('crosses everything when asked to', () => {
    repo = makeRepo({
      baseFiles: {
        'src/api/orders.ts': "export function listOrders() {\n  return http.get('/orders')\n}\n",
        'tests/unrelated.test.ts': 'nothing\n',
      },
    });

    const out = crossWithTests({ repo: repo.dir, symbols: [ts('listOrders', 'src/api/orders.ts')], logicOnly: false });

    expect(out.orphans).toHaveLength(1);
    expect(out.exempt).toEqual([]);
  });
});
