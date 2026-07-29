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
