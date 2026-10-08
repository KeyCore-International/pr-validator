// Pure pieces of the local mode: file categories, tiers, trigger specs and the
// deterministic JSON writer.

import { describe, expect, it } from 'vitest';
import { categorize } from '../src/local/classify.mjs';
import { computeTier } from '../src/local/tier.mjs';
import { compilePattern, evaluateTriggers, mergeTriggerSpecs, TriggerSpecError } from '../src/local/triggers.mjs';
import { attributionHits, DEFAULT_ATTRIBUTION_PATTERNS } from '../src/local/history.mjs';
import { compact, stableStringify } from '../src/local/json.mjs';

describe('categorize', () => {
  it.each([
    ['src/app/orders.ts', 'prod'],
    ['Api/Controllers/OrdersController.cs', 'prod'],
    ['Api/Migrations/20260101_AddOrders.cs', 'prod'],
    ['Api/Migrations/20260101_AddOrders.Designer.cs', 'generated'],
    ['Api/Migrations/AppDbContextModelSnapshot.cs', 'generated'],
    ['src/utils/format.test.ts', 'test'],
    ['src/__tests__/format.ts', 'test'],
    ['App.Tests.Unit/OrdersTests.cs', 'test'],
    ['App.IntegrationTests/Fixture.cs', 'test'],
    ['src/__snapshots__/view.snap', 'snapshot'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['packages.lock.json', 'lockfile'],
    ['README.md', 'docs'],
    ['.claude/rules/naming.ts', 'tooling'],
    ['src/locales/es.json', 'locale'],
    ['src/styles/main.scss', 'style'],
    ['public/logo.png', 'asset'],
    ['dist/index.js', 'generated'],
    ['src/types/env.d.ts', 'prod'],
  ])('%s is %s', (path, category) => {
    expect(categorize(path)).toBe(category);
  });
});

describe('computeTier', () => {
  it('is XS with no production lines, whatever fired', () => {
    expect(computeTier({ prodLines: 0, triggers: ['FIX'] }).value).toBe('XS');
  });

  it('is S for a small change with at most one soft trigger', () => {
    expect(computeTier({ prodLines: 120, triggers: [] }).value).toBe('S');
    expect(computeTier({ prodLines: 400, triggers: ['CONTRACT', 'FIX'] }).value).toBe('S');
  });

  it('is M for size, two triggers, or any hard trigger', () => {
    expect(computeTier({ prodLines: 401, triggers: [] }).value).toBe('M');
    expect(computeTier({ prodLines: 10, triggers: ['CONTRACT', 'NEW_HELPER'] }).value).toBe('M');
    expect(computeTier({ prodLines: 10, triggers: ['AUTH'] }).value).toBe('M');
  });

  it('is L for size, three triggers, SEED, or MIG with WRITE — even when small', () => {
    expect(computeTier({ prodLines: 1501, triggers: [] }).value).toBe('L');
    expect(computeTier({ prodLines: 10, triggers: ['CONTRACT', 'DATA', 'NEW_HELPER'] }).value).toBe('L');
    expect(computeTier({ prodLines: 10, triggers: ['SEED'] }).value).toBe('L');
    expect(computeTier({ prodLines: 10, triggers: ['MIG', 'WRITE'] }).value).toBe('L');
  });

  it('names a FIX that fired instead of saying "no triggers"', () => {
    const tier = computeTier({ prodLines: 12, triggers: ['FIX'] });
    expect(tier.value).toBe('S');
    expect(tier.reasons[0]).toContain('FIX');
    expect(tier.reasons[0]).not.toContain('no triggers');
    expect(computeTier({ prodLines: 12, triggers: [] }).reasons[0]).toContain('no triggers');
  });

  it('honours calibrated thresholds', () => {
    expect(computeTier({ prodLines: 300, triggers: [], thresholds: { sMax: 200 } }).value).toBe('M');
  });

  it('forces L with full, and S with quick unless a hard trigger refuses it', () => {
    expect(computeTier({ prodLines: 10, triggers: [], force: 'full' })).toMatchObject({ value: 'L', forced: 'full' });
    expect(computeTier({ prodLines: 900, triggers: [], force: 'quick' })).toMatchObject({ value: 'S', forced: 'quick' });

    const refused = computeTier({ prodLines: 900, triggers: ['MIG'], force: 'quick' });
    expect(refused.value).toBe('M');
    expect(refused.forced).toBeNull();
    expect(refused.refused).toContain('MIG');
  });
});

describe('trigger specs', () => {
  it('merges files by adding patterns and keeps the built-in FIX', () => {
    const specs = mergeTriggerSpecs([
      { triggers: { AUTH: { paths: ['src/auth/**'] } } },
      [{ id: 'AUTH', paths: ['src/guards/**'], scope: 'all' }],
    ]);
    expect(specs.AUTH.paths).toEqual(['src/auth/**', 'src/guards/**']);
    expect(specs.AUTH.scope).toBe('all');
    expect(specs.FIX.branches.length).toBe(1);
    expect(specs.FIX.commits).toEqual([]);
  });

  it('rejects malformed specs and patterns', () => {
    expect(() => mergeTriggerSpecs([{ auth: {} }])).toThrow(TriggerSpecError);
    expect(() => mergeTriggerSpecs([{ AUTH: { paths: 'src/**' } }])).toThrow(TriggerSpecError);
    expect(() => mergeTriggerSpecs([{ AUTH: { added: ['('] } }])).toThrow(TriggerSpecError);
  });

  it('compiles /body/flags and bare bodies', () => {
    expect(compilePattern('/abc/i').test('ABC')).toBe(true);
    expect(compilePattern('abc').test('ABC')).toBe(false);
  });

  it('reads production files only unless the trigger asks for all', () => {
    const specs = mergeTriggerSpecs([
      { SECURITY: { paths: ['**/Security/**'] }, TOUCHED: { paths: ['**/Security/**'], scope: 'all' } },
    ]);
    const files = [{ path: 'App.Tests/Security/AuthTests.cs', status: 'M', category: 'test' }];
    const result = evaluateTriggers({ specs, files, diffText: '' });
    expect(result.ids).toEqual(['TOUCHED']);
  });

  it('matches added lines, new files and commit subjects', () => {
    // A custom trigger may still read commit subjects; FIX no longer does.
    const specs = mergeTriggerSpecs([
      {
        WRITE: { added: ['/\\[Http(Post|Put|Delete)/'], addedIn: ['**/*.cs'] },
        NEW_HELPER: { newPaths: ['**/Helpers/**'] },
        REVERT: { commits: ['/^revert\\b/i'] },
      },
    ]);
    const diffText = [
      'diff --git a/Api/OrdersController.cs b/Api/OrdersController.cs',
      '--- a/Api/OrdersController.cs',
      '+++ b/Api/OrdersController.cs',
      '@@ -1,1 +1,2 @@',
      ' class A {}',
      '+[HttpPost]',
      '',
    ].join('\n');
    const files = [
      { path: 'Api/OrdersController.cs', status: 'M', category: 'prod' },
      { path: 'Api/Helpers/Money.cs', status: 'A', category: 'prod' },
    ];
    const commits = [
      { sha: 'abc', subject: 'fix(orders): rounding' },
      { sha: 'def', subject: 'Revert "feat: x"' },
    ];

    const result = evaluateTriggers({ specs, files, diffText, commits });
    expect(result.ids).toEqual(['NEW_HELPER', 'REVERT', 'WRITE']);
    expect(result.hits.WRITE.hits[0]).toMatchObject({ path: 'Api/OrdersController.cs', line: 2 });
  });

  it('raises FIX for a fix/ or hotfix/ branch, never for a fix(...) commit subject', () => {
    const specs = mergeTriggerSpecs([]);
    const run = (opts) => evaluateTriggers({ specs, files: [], diffText: '', ...opts });
    expect(run({ branch: 'fix/6629-reason-codes' }).ids).toEqual(['FIX']);
    expect(run({ branch: 'hotfix/242-scope' }).hits.FIX.hits[0]).toMatchObject({ kind: 'branch', path: 'hotfix/242-scope' });
    expect(run({ branch: 'feature/6566-x', commits: [{ sha: 'a', subject: 'fix(auth): review' }] }).ids).toEqual([]);
    expect(run({ branch: 'feature/fix-typo' }).ids).toEqual([]);
    expect(run({ branch: '' }).ids).toEqual([]);
  });

  it('counts a file once per trigger when several of its globs match it', () => {
    const specs = mergeTriggerSpecs([
      { NEW_PRIMITIVE: { newPaths: ['**/composables/use*.ts', '**/composables/**/use*.ts'], paths: ['**/composables/**', 'src/**'] } },
    ]);
    const files = [{ path: 'composables/useSchemaOrg.ts', status: 'A', category: 'prod' }];
    const result = evaluateTriggers({ specs, files, diffText: '' });
    expect(result.hits.NEW_PRIMITIVE.count).toBe(2);
    expect(result.hits.NEW_PRIMITIVE.hits.map((hit) => hit.kind).sort()).toEqual(['new', 'path']);
  });

  it('rejects a branch pattern that does not compile', () => {
    expect(() => mergeTriggerSpecs([{ FIX: { branches: ['('] } }])).toThrow(TriggerSpecError);
  });

  // AUTH by folder fired for a reducer action and a terms message in an auth
  // folder and pushed a small change to the largest tier. A scoped pattern
  // weighs what the lines do there, and leaves the plain patterns global.
  describe('scoped added patterns', () => {
    const SCOPED = {
      pattern: '/\\b(token|guard|permission|role)s?\\b/i',
      in: ['**/auth/**', '**/guards/**'],
    };
    const diffFor = (path, lines) =>
      [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,1 +1,${lines.length + 1} @@`, ' x', ...lines.map((l) => `+${l}`), ''].join('\n');

    it('reads only the files its own globs name', () => {
      const specs = mergeTriggerSpecs([{ AUTH: { added: ['/use server/', SCOPED] } }]);
      const files = [
        { path: 'src/auth/AuthContext.tsx', status: 'M', category: 'prod' },
        { path: 'src/screens/Home.tsx', status: 'M', category: 'prod' },
      ];
      const harmless = diffFor('src/auth/AuthContext.tsx', ["dispatch({type: 'LEGAL_CONTRACT_SIGNED'});"]);
      expect(evaluateTriggers({ specs, files, diffText: harmless }).ids).toEqual([]);

      const outside = diffFor('src/screens/Home.tsx', ['const token = read();']);
      expect(evaluateTriggers({ specs, files, diffText: outside }).ids).toEqual([]);

      const guarded = diffFor('src/auth/AuthContext.tsx', ['setToken(response.token);']);
      const hit = evaluateTriggers({ specs, files, diffText: guarded });
      expect(hit.ids).toEqual(['AUTH']);
      expect(hit.hits.AUTH.hits[0]).toMatchObject({
        kind: 'added',
        path: 'src/auth/AuthContext.tsx',
        pattern: `${SCOPED.pattern} in **/auth/**,**/guards/**`,
      });
    });

    it('ignores addedIn, which keeps restricting only the plain strings', () => {
      const specs = mergeTriggerSpecs([{ AUTH: { added: ['/secret/', SCOPED], addedIn: ['**/config/**'] } }]);
      const files = [{ path: 'src/auth/guard.ts', status: 'M', category: 'prod' }];
      const diffText = diffFor('src/auth/guard.ts', ['const secret = 1;', 'if (!permission) deny();']);
      const result = evaluateTriggers({ specs, files, diffText });
      expect(result.hits.AUTH.hits.map((h) => h.line)).toEqual([3]);
    });

    it('merges the same scoped item from two files once, globs in any order', () => {
      const specs = mergeTriggerSpecs([
        { AUTH: { added: [SCOPED] } },
        { AUTH: { added: [{ pattern: SCOPED.pattern, in: [...SCOPED.in].reverse() }, '/plain/'] } },
      ]);
      expect(specs.AUTH.added).toEqual([{ pattern: SCOPED.pattern, in: ['**/auth/**', '**/guards/**'] }, '/plain/']);
    });

    it('rejects a scoped item without globs or with a bad pattern', () => {
      expect(() => mergeTriggerSpecs([{ AUTH: { added: [{ pattern: '/x/', in: [] }] } }])).toThrow(TriggerSpecError);
      expect(() => mergeTriggerSpecs([{ AUTH: { added: [{ in: ['**'] }] } }])).toThrow(TriggerSpecError);
      expect(() => mergeTriggerSpecs([{ AUTH: { added: [{ pattern: '(', in: ['**'] }] } }])).toThrow(TriggerSpecError);
    });
  });

  it('raises a caller flag even when no spec declares it', () => {
    const result = evaluateTriggers({ specs: mergeTriggerSpecs([]), files: [], diffText: '', flags: ['FIX'] });
    expect(result.ids).toEqual(['FIX']);
  });
});

describe('attribution', () => {
  const patterns = DEFAULT_ATTRIBUTION_PATTERNS.map(compilePattern);

  it('flags tool trailers and leaves human co-authors alone', () => {
    const commits = [
      { sha: 'a', subject: 'feat: x', body: 'feat: x\n\nCo-Authored-By: Tool <noreply@vendor.example>' },
      { sha: 'b', subject: 'feat: y', body: 'feat: y\n\nCo-authored-by: Ana <123+ana@users.noreply.github.com>' },
      { sha: 'c', subject: 'feat: z', body: 'feat: z\n\nGenerated with some tool' },
    ];
    expect(attributionHits(commits, patterns).map((hit) => hit.sha)).toEqual(['a', 'c']);
  });
});

describe('deterministic JSON', () => {
  it('sorts keys at every level and drops bodies', () => {
    const value = compact({ b: 1, a: { d: 0.123456789, c: 'x', body: 'source' }, s: new Set(['z', 'y']) });
    expect(stableStringify(value)).toBe(
      '{\n  "a": {\n    "c": "x",\n    "d": 0.1235\n  },\n  "b": 1,\n  "s": [\n    "y",\n    "z"\n  ]\n}\n',
    );
  });
});
