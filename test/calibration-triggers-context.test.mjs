// Fixes from the first calibration of the local mode against real branches:
// task ids that were SQL lengths, untested-logic findings for services a test
// reaches through their interface, generated files that ate the diff budget,
// prompts that did not say they were partial, a duplication skip that
// contradicted the facts, and FIX raised from a branch name rather than a
// commit subject.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { idsFromText, resolveTaskRef } from '../src/context/task-ref.mjs';
import { crossWithTests, csharpInterfaces } from '../src/context/coverage.mjs';
import { buildDiff, splitBudgetExempt, truncationNote } from '../src/context/diff.mjs';
import { categorize, isBudgetExempt } from '../src/context/categories.mjs';
import { categorize as categorizeLocal } from '../src/local/classify.mjs';
import { buildContext } from '../src/context/build.mjs';
import { getCheck } from '../src/checks/registry.mjs';
import { loadRepoConfig } from '../src/context/repo-config.mjs';
import { checkConfig } from '../src/local/config.mjs';
import { promptCompleteness } from '../src/local/prompts.mjs';
import { main } from '../src/local/cli.mjs';
import { branchAtHead, nameFromRemote, repoName, resolveBranch } from '../src/local/git.mjs';
import { bigFile, makeRepo } from './fixtures/repo.mjs';

let repo;
const temps = [];
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'prl-cal-'));
  temps.push(dir);
  return dir;
}

const gitIn = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function run(args) {
  const out = { stdout: '', stderr: '' };
  const code = await main(args, {
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += `${text}\n`;
    },
  });
  return { code, ...out };
}

describe('task references in free text', () => {
  it('does not read a SQL length or an index as a task id', () => {
    const body = 'Adds ReasonParameters (nvarchar(1000) null), decimal(18,2), items[2] and varchar(255).';
    expect(idsFromText(body)).toEqual([]);
  });

  it('still reads the forms a developer writes', () => {
    expect(idsFromText('tarea (#3002), [3001], (3000), fix(#77)')).toEqual(['3002', '3001', '3000', '77']);
  });

  it('keeps nvarchar(N) and prose counts out of the context ids', () => {
    const ref = resolveTaskRef({
      headRef: 'fix/6629-reason-codes',
      prBody:
        'Columna ReasonParameters nvarchar(1000). Baja no aplicada sin código (3). ' +
        'Fallan solo en la rama (5) [2]. Relacionada con #4043 y la reconstrucción (#6358).',
    });
    expect(ref.subjectId).toBe('6629');
    expect(ref.contextIds).toEqual(['4043', '6358']);
  });

  it('reads only #N in the body, every form in the title', () => {
    expect(idsFromText('(3002) [3001] #3000', { hashOnly: true })).toEqual(['3000']);
    expect(resolveTaskRef({ headRef: 'x', prTitle: 'ajusta el filtro (3002)' }).subjectId).toBe('3002');
    expect(resolveTaskRef({ headRef: 'x', prBody: 'ajusta el filtro (3002)' }).mode).toBe('none');
  });
});

describe('C# coverage through the interface', () => {
  const SERVICE = `namespace Shop.Services
{
    public class OrderService : BaseService<Order, Guid>,
        IOrderService, IDisposable
    {
        public async Task<int> PlaceAsync(int id)
        {
            if (id > 0)
            {
                return id;
            }
            return 0;
        }
    }
}
`;

  it('reads the interfaces of a base list, generics and line breaks included', () => {
    const lines = SERVICE.split('\n');
    expect(csharpInterfaces(lines, 'OrderService').sort()).toEqual(['IDisposable', 'IOrderService']);
    expect(csharpInterfaces(null, 'Clock')).toEqual(['IClock']);
  });

  const symbol = { name: 'PlaceAsync', path: 'src/OrderService.cs', line: 6, kind: 'method', container: 'OrderService', exported: true };

  it('counts a test that resolves the service by its interface as covering the method', () => {
    repo = makeRepo({
      baseFiles: {
        'src/OrderService.cs': SERVICE,
        'tests/OrderFlowTests.cs': 'var r = await sp.GetRequiredService<IOrderService>()\n    .PlaceAsync(1);\n',
      },
    });
    const out = crossWithTests({ repo: repo.dir, symbols: [symbol] });
    expect(out.orphans).toEqual([]);
    expect(out.covered.map((s) => s.name)).toEqual(['PlaceAsync']);
  });

  it('still reports the method when the test is about another class', () => {
    repo = makeRepo({
      baseFiles: {
        'src/OrderService.cs': SERVICE,
        'tests/PaymentTests.cs': 'var r = await sp.GetRequiredService<IPaymentService>().PlaceAsync(1);\n',
      },
    });
    const out = crossWithTests({ repo: repo.dir, symbols: [symbol] });
    expect(out.orphans.map((s) => s.name)).toEqual(['PlaceAsync']);
  });
});

describe('generated files and the diff budget', () => {
  it('shares one category table between the tier and the budget', () => {
    expect(categorize).toBe(categorizeLocal);
    for (const path of [
      'Api/Migrations/20260101_Add.Designer.cs',
      'Api/Migrations/AppDbContextModelSnapshot.cs',
      'pnpm-lock.yaml',
      'src/__snapshots__/view.spec.ts.snap',
      'src/api.generated.ts',
    ]) {
      expect(isBudgetExempt(path), path).toBe(true);
    }
    for (const path of ['Api/Migrations/20260101_Add.cs', 'src/a.test.ts', 'src/a.ts']) {
      expect(isBudgetExempt(path), path).toBe(false);
    }
  });

  it('splits exempt sections out of a diff, deletions included', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '+x',
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      'deleted file mode 100644',
      '--- a/pnpm-lock.yaml',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-lock',
      '',
    ].join('\n');
    const { reviewable, exempt } = splitBudgetExempt(diff);
    expect(reviewable).toContain('src/a.ts');
    expect(reviewable).not.toContain('pnpm-lock');
    expect(exempt.map((e) => e.path)).toEqual(['pnpm-lock.yaml']);
  });

  it('leaves generated files out BEFORE truncating, so hand-written files fit', () => {
    repo = makeRepo({
      featureFiles: {
        'Api/Migrations/20260101_Add.Designer.cs': bigFile(200, 'designer'),
        'Api/Migrations/AppDbContextModelSnapshot.cs': bigFile(200, 'snapshot'),
        'Api/Orders.cs': 'public class Orders { }\n',
      },
    });
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 4000 });

    expect(ctx.truncated).toBe(false);
    expect(ctx.diff).toContain('Api/Orders.cs');
    expect(ctx.diff).not.toContain('designer 0');
    expect(ctx.diff).toContain('2 generated, lockfile or snapshot file(s) left out of the diff body');
    expect(ctx.exemptFiles.sort()).toEqual([
      'Api/Migrations/20260101_Add.Designer.cs',
      'Api/Migrations/AppDbContextModelSnapshot.cs',
    ]);
    expect(ctx.totalFiles).toBe(3);
    expect(ctx.includedFiles).toBe(1);
    expect(ctx.omittedFiles).toBe(0);
    expect(truncationNote(ctx)).toBeNull();
  });

  it('says so in the truncation note when it also had to cut', () => {
    repo = makeRepo({
      featureFiles: {
        'pnpm-lock.yaml': bigFile(100, 'lock'),
        'src/one.ts': bigFile(120, 'one'),
        'src/two.ts': bigFile(120, 'two'),
      },
    });
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 4000 });
    expect(ctx.truncated).toBe(true);
    expect(ctx.includedFiles + ctx.omittedFiles + ctx.exemptFiles.length).toBe(ctx.totalFiles);
    expect(truncationNote(ctx)).toContain('se apartaron 1 archivo(s) generados');
    expect(ctx.fullDiff).toContain('two 119');
  });
});

describe('partial prompts carry a machine-readable flag', () => {
  it('flags a truncated diff and says how much was shown', () => {
    const ctx = {
      diff: { truncated: true, diff: 'abc', totalChars: 10, totalFiles: 3, includedFiles: 1, omittedFiles: 2, exemptFiles: ['x.Designer.cs'] },
      rules: { truncated: false },
    };
    expect(promptCompleteness(ctx)).toEqual({
      partial: true,
      reasons: ['diff-truncated'],
      diff: { truncated: true, shownChars: 3, totalChars: 10, totalFiles: 3, includedFiles: 1, omittedFiles: 2, omittedPaths: [], partialPath: null, exemptFiles: ['x.Designer.cs'] },
    });
    expect(promptCompleteness({}).partial).toBe(false);
    expect(promptCompleteness({ rules: { truncated: true }, duplication: { indexTruncated: true } }).reasons).toEqual([
      'rules-truncated',
      'duplication-index-truncated',
    ]);
  });

  it('writes the flag to ctx.json and index.json', { timeout: 30_000 }, async () => {
    repo = makeRepo({
      featureFiles: {
        'src/one.ts': bigFile(200, 'one'),
        'src/two.ts': bigFile(200, 'two'),
      },
    });
    writeFileSync(join(repo.dir, '.pr-validator.json'), JSON.stringify({ checks: { quality: { maxDiffChars: 4000 } } }));
    gitIn(repo.dir, ['add', '-A']);
    gitIn(repo.dir, ['commit', '--quiet', '-m', 'config']);
    const out = tempDir();

    const result = await run(['prompts', '--repo', repo.dir, '--base', 'base', '--out', out, '--checks', 'quality']);
    expect(result.code, result.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(join(out, 'prompts', 'quality.ctx.json'), 'utf8'));
    expect(saved.partial).toBe(true);
    expect(saved.partialReasons).toContain('diff-truncated');
    expect(saved.diff.omittedFiles).toBeGreaterThan(0);
    const index = JSON.parse(readFileSync(join(out, 'prompts', 'index.json'), 'utf8'));
    expect(index.partial).toBe(true);
    expect(index.checks[0]).toMatchObject({ check: 'quality', partial: true });
  });
});

const FORMAT = `export function formatCurrency(value: number, currency: string): string {
  const amount = Math.round(value * 100) / 100;
  const parts = amount.toFixed(2).split('.');
  const integer = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  return currency + ' ' + integer + '.' + parts[1];
}
`;

const MONEY = `export function formatMoney(total: number, symbol: string): string {
  const rounded = Math.round(total * 100) / 100;
  const pieces = rounded.toFixed(2).split('.');
  const whole = pieces[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  return symbol + ' ' + whole + '.' + pieces[1];
}
`;

describe('duplication reads the whole branch, not the budgeted prompt', () => {
  it('finds a duplicate the truncated diff no longer shows', { timeout: 30_000 }, async () => {
    repo = makeRepo({
      baseFiles: { 'src/utils/format.ts': FORMAT },
      // The file holding the duplicate is the one too large for the budget.
      featureFiles: { 'src/a/filler.ts': 'export const filler = 1;\n', 'src/z/money.ts': MONEY + bigFile(200, 'money') },
    });
    const check = getCheck('duplication');
    const config = { ...checkConfig(loadRepoConfig({ repo: repo.dir }), 'duplication'), maxDiffChars: 4000 };
    const ctx = await buildContext({
      check,
      inputs: { base: 'base', head: gitIn(repo.dir, ['rev-parse', 'HEAD']), repo: repo.dir, headRef: 'feature', prTitle: '', prBody: '' },
      config,
      fetchBase: false,
    });

    expect(ctx.diff.truncated).toBe(true);
    expect(ctx.diff.diff).not.toContain('formatMoney');
    expect(ctx.diff.omittedPaths).toEqual(['src/z/money.ts']);
    expect(ctx.duplication.findings.map((f) => f.symbol.name)).toContain('formatMoney');
  });
});

describe('facts --branch', () => {
  it('raises FIX for a fix/ branch passed to a detached checkout, and records the name', { timeout: 30_000 }, async () => {
    repo = makeRepo({ featureFiles: { 'src/a.ts': 'export const a = 1;\n' } });
    gitIn(repo.dir, ['checkout', '--quiet', '--detach', 'feature']);

    const plain = tempDir();
    expect((await run(['facts', '--repo', repo.dir, '--base', 'base', '--out', plain])).code).toBe(0);
    const detached = JSON.parse(readFileSync(join(plain, 'facts.json'), 'utf8'));
    // The one branch whose ref points at the detached HEAD names it.
    expect(detached.branch).toBe('feature');
    expect(detached.branchSource).toBe('ref');
    expect(detached.triggers.ids).not.toContain('FIX');

    const named = tempDir();
    const result = await run(['facts', '--repo', repo.dir, '--base', 'base', '--out', named, '--branch', 'hotfix/242-scope']);
    expect(result.code, result.stderr).toBe(0);
    const facts = JSON.parse(readFileSync(join(named, 'facts.json'), 'utf8'));
    expect(facts.branch).toBe('hotfix/242-scope');
    expect(facts.branchSource).toBe('arg');
    expect(facts.triggers.ids).toContain('FIX');
    expect(facts.tier.reasons.join(' ')).toContain('FIX');
  });
});

// Two worktrees of the same commit wrote different facts: `repo` was the
// worktree's folder name, and a detached checkout had no branch at all.
describe('facts name the repository and the branch from git, not from the folder', () => {
  it('writes byte-identical facts from two worktrees of one commit', { timeout: 60_000 }, async () => {
    repo = makeRepo({ featureFiles: { 'src/a.ts': 'export const a = 1;\n' } });
    const head = gitIn(repo.dir, ['rev-parse', 'feature']);
    const parent = tempDir();
    const one = join(parent, 'cal-one');
    const two = join(parent, 'cal-two-other-name');
    gitIn(repo.dir, ['worktree', 'add', '--quiet', '--detach', one, head]);
    gitIn(repo.dir, ['worktree', 'add', '--quiet', '--detach', two, head]);
    try {
      const outs = [tempDir(), tempDir()];
      for (const [i, dir] of [one, two].entries()) {
        const result = await run(['facts', '--repo', dir, '--base', 'base', '--out', outs[i]]);
        expect(result.code, result.stderr).toBe(0);
      }
      const [a, b] = outs.map((out) => readFileSync(join(out, 'facts.json'), 'utf8'));
      expect(a).toBe(b);
      const facts = JSON.parse(a);
      expect(facts.repo).toBe(repoName(repo.dir));
      expect(facts.repo).not.toMatch(/cal-/);
      expect(facts.branch).toBe('feature');
      expect(readFileSync(join(outs[0], 'facts.md'), 'utf8')).toBe(readFileSync(join(outs[1], 'facts.md'), 'utf8'));
    } finally {
      gitIn(repo.dir, ['worktree', 'remove', '--force', one]);
      gitIn(repo.dir, ['worktree', 'remove', '--force', two]);
    }
  });

  it('takes the name from origin when there is one', () => {
    repo = makeRepo();
    gitIn(repo.dir, ['remote', 'add', 'origin', 'git@example.invalid:team/orders-api.git']);
    expect(repoName(repo.dir)).toBe('orders-api');
    expect(nameFromRemote('https://example.invalid/team/web.git/')).toBe('web');
  });

  it('leaves the branch empty when two branches point at a detached HEAD, and skips the base', () => {
    repo = makeRepo({ featureFiles: { 'src/a.ts': 'export const a = 1;\n' } });
    gitIn(repo.dir, ['checkout', '--quiet', '--detach', 'feature']);
    expect(resolveBranch(repo.dir, { base: 'base' })).toEqual({ branch: 'feature', source: 'ref' });
    gitIn(repo.dir, ['branch', 'feature-copy']);
    expect(resolveBranch(repo.dir, { base: 'base' })).toEqual({ branch: '', source: null });
    // The base pointing at HEAD is not a candidate for the branch under review.
    expect(branchAtHead(repo.dir, { exclude: ['feature-copy'] })).toBe('feature');
  });
});
