// The logic-bearing functions a change touches, asked whether or not the
// repository has tests. In a repo with no suite this list is the only signal
// that the change carries logic nobody can verify.

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { logicTouchedSymbols, suiteFamilies, testFamily } from '../src/context/coverage.mjs';
import { makeRepo } from './fixtures/repo.mjs';

let repo;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

function diffOf(dir) {
  return execFileSync('git', ['-C', dir, 'diff', '--no-color', 'base', 'feature'], { encoding: 'utf8' });
}

const PRICE_BASE = [
  'export function total(items) {', // 1
  '  let sum = 0', // 2
  '  for (const item of items) sum += item.price', // 3
  '  return sum', // 4
  '}', // 5
  '', // 6
  'export function label(name) {', // 7
  "  return 'Item ' + name", // 8
  '}', // 9
  '',
].join('\n');

describe('logicTouchedSymbols', () => {
  it('lists added and modified logic of any scope, and leaves flat or untouched functions out', () => {
    repo = makeRepo({
      baseFiles: { 'src/price.ts': PRICE_BASE },
      featureFiles: {
        'src/price.ts': [
          'export function total(items) {', // 1
          '  let sum = 0', // 2
          '  for (const item of items) sum += item.price * (item.qty ?? 1)', // 3 (body changed)
          '  return sum', // 4
          '}', // 5
          '', // 6
          'export function label(name) {', // 7
          "  return 'Item ' + name", // 8
          '}', // 9
          '', // 10
          'function discount(amount, rate) {', // 11 (new, private)
          '  if (rate > 0.5) return amount', // 12
          '  return amount - amount * rate', // 13
          '}', // 14
          '', // 15
          'export function title(name) {', // 16 (new, flat)
          '  return name', // 17
          '}', // 18
          '',
        ].join('\n'),
      },
    });

    const touched = logicTouchedSymbols({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(touched.map((s) => [s.name, s.change, s.line, s.endLine])).toEqual([
      ['total', 'modified', 1, 5],
      ['discount', 'added', 11, 14],
    ]);
    expect(touched[0].reasons).toContain('loop');
    expect(touched[1].reasons).toContain('branches');
    expect(touched[1].exported).toBe(false);
  });

  it('reads C# methods, private ones included', () => {
    repo = makeRepo({
      baseFiles: {
        'src/Orders/OrderService.cs': [
          'namespace Shop;',
          'public class OrderService',
          '{',
          '    public int Count() => 0;',
          '}',
          '',
        ].join('\n'),
      },
      featureFiles: {
        'src/Orders/OrderService.cs': [
          'namespace Shop;',
          'public class OrderService',
          '{',
          '    public int Count() => 0;',
          '',
          '    private decimal Fee(decimal amount)',
          '    {',
          '        if (amount > 100m) return 0m;',
          '        return amount * 0.05m;',
          '    }',
          '}',
          '',
        ].join('\n'),
      },
    });

    const touched = logicTouchedSymbols({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(touched.map((s) => [s.name, s.kind, s.change])).toEqual([['Fee', 'method', 'added']]);
  });

  it('reads only the files the caller includes', () => {
    repo = makeRepo({
      baseFiles: { 'src/price.ts': PRICE_BASE },
      featureFiles: {
        'src/price.ts': PRICE_BASE.replace('item.price', 'item.price * 2'),
        'scripts/seed.ts': 'export function seed(n) {\n  for (let i = 0; i < n; i++) insert(i)\n}\n',
      },
    });

    const touched = logicTouchedSymbols({
      diffText: diffOf(repo.dir),
      repo: repo.dir,
      include: (path) => path.startsWith('src/'),
    });

    expect(touched.map((s) => s.name)).toEqual(['total']);
  });

  it('is empty for a diff with no logic and for an empty diff', () => {
    repo = makeRepo({
      baseFiles: { 'src/price.ts': PRICE_BASE },
      featureFiles: { 'src/price.ts': PRICE_BASE.replace("'Item '", "'Article '") },
    });

    expect(logicTouchedSymbols({ diffText: diffOf(repo.dir), repo: repo.dir })).toEqual([]);
    expect(logicTouchedSymbols({ diffText: '', repo: repo.dir })).toEqual([]);
  });
});

describe('testFamily and suiteFamilies', () => {
  it.each([
    ['tests/Shop.Tests/OrderServiceTests.cs', 'csharp'],
    ['src/price.spec.ts', 'script'],
    ['src/components/Card.vue', 'script'],
    ['test/money.test.mjs', 'script'],
    ['tests/Unit/PriceTest.php', 'php'],
    ['tests/fixtures/data.json', null],
  ])('%s is %s', (path, family) => {
    expect(testFamily(path)).toBe(family);
  });

  it('lists the languages that have a test file', () => {
    expect([...suiteFamilies(['tests/A.Tests/ATests.cs', 'tests/fixtures/x.json'])]).toEqual(['csharp']);
    expect([...suiteFamilies([])]).toEqual([]);
  });
});
