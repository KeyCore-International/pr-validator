// The local CLI against a real throwaway repository: facts, prompts and render
// are exercised through `main`, the same entry the bundle runs, so exit codes
// and written files are what a caller actually gets.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/local/cli.mjs';
import { buildContext } from '../src/context/build.mjs';
import { getCheck } from '../src/checks/registry.mjs';
import { loadRepoConfig } from '../src/context/repo-config.mjs';
import { checkConfig } from '../src/local/config.mjs';
import { EXIT } from '../src/local/errors.mjs';
import { repoName } from '../src/local/git.mjs';
import { makeRepo } from './fixtures/repo.mjs';

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

const ORDERS = `import { router } from './router';

export function registerOrders(): void {
  router.post('/orders', (req, res) => {
    res.status(201).send(req.body);
  });
}
`;

const RULE = `---
paths: "src/**"
---
# Naming

Functions are named in English.
`;

const TRIGGERS = {
  triggers: {
    WRITE: { added: ['/router\\.(post|put|patch|delete)\\(/'] },
    NEW_HELPER: { newPaths: ['src/utils/**'] },
    AUTH: { paths: ['src/security/**'] },
  },
};

const BASE_FILES = {
  'src/utils/format.ts': FORMAT,
  'test/format.test.ts': "import { formatCurrency } from '../src/utils/format';\n// formatCurrency\n",
  '.claude/rules/naming.md': RULE,
};

const FEATURE_FILES = {
  'src/utils/money.ts': MONEY,
  'src/api/orders.ts': ORDERS,
  'docs/notes.md': '# notes\n',
};

function gitIn(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: (text) => {
        out.stdout += text;
      },
      stderr: (text) => {
        out.stderr += `${text}\n`;
      },
    },
  };
}

async function run(args) {
  const { out, io } = capture();
  const code = await main(args, io);
  return { code, ...out };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

let repo;
const temps = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'prl-out-'));
  temps.push(dir);
  return dir;
}

function setup({ featureFiles = FEATURE_FILES } = {}) {
  repo = makeRepo({ baseFiles: BASE_FILES, featureFiles });
  const triggers = join(tempDir(), 'triggers.json');
  writeFileSync(triggers, JSON.stringify(TRIGGERS), 'utf8');
  return { dir: repo.dir, triggers };
}

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

// Each case builds a git repository and runs facts on it: dozens of git
// processes. Alone they take about a second; under the full parallel suite on
// Windows the first one also pays the cold start, so the default 5 s is short.
describe('pr-local facts', { timeout: 30_000 }, () => {
  it('classifies the change, fires triggers and computes the tier', async () => {
    const { dir, triggers } = setup();
    const out = tempDir();

    const result = await run(['facts', '--repo', dir, '--base', 'base', '--out', out, '--triggers', triggers]);
    expect(result.code, result.stderr).toBe(EXIT.OK);

    const facts = JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8'));
    expect(facts.mergeBase).toBe(gitIn(dir, ['rev-parse', 'base']));
    expect(facts.head.sha).toBe(gitIn(dir, ['rev-parse', 'HEAD']));
    expect(facts.branch).toBe('feature');

    const categories = Object.fromEntries(facts.files.map((file) => [file.path, file.category]));
    expect(categories).toEqual({
      'docs/notes.md': 'docs',
      'src/api/orders.ts': 'prod',
      'src/utils/money.ts': 'prod',
    });
    // Production lines exclude the markdown file.
    expect(facts.prodLines).toBe(MONEY.split('\n').length - 1 + ORDERS.split('\n').length - 1);

    expect(facts.triggers.ids).toEqual(['NEW_HELPER', 'WRITE']);
    expect(facts.triggers.hits.WRITE.hits[0]).toMatchObject({ kind: 'added', path: 'src/api/orders.ts', line: 4 });
    // WRITE is a hard trigger, and two triggers fired: M.
    expect(facts.tier.value).toBe('M');

    expect(facts.foreignMerges).toEqual([]);
    expect(facts.attribution.hits).toEqual([]);

    // The new helper duplicates the existing one, and nothing tests it.
    const dup = facts.duplication.findings.find((f) => f.symbol.name === 'formatMoney');
    expect(dup?.matches[0].candidate.name).toBe('formatCurrency');
    expect(dup.matches[0].candidate.body).toBeUndefined();
    expect(facts.coverage.orphans.map((o) => o.name)).toContain('formatMoney');

    expect(readFileSync(join(out, 'diff.patch'), 'utf8')).toContain('+export function formatMoney');
    expect(readFileSync(join(out, 'facts.md'), 'utf8')).toContain('## Escalón: M');
  });

  it('writes byte-identical facts on two runs over the same commit', async () => {
    const { dir, triggers } = setup();
    const first = tempDir();
    const second = tempDir();

    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', first, '--triggers', triggers])).code).toBe(0);
    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', second, '--triggers', triggers])).code).toBe(0);

    const a = readFileSync(join(first, 'facts.json'), 'utf8');
    const b = readFileSync(join(second, 'facts.json'), 'utf8');
    expect(a).toBe(b);

    // Keys are sorted at every level.
    const parsed = JSON.parse(a);
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    expect(Object.keys(parsed.tier)).toEqual([...Object.keys(parsed.tier)].sort());
  });

  it('is XS for a change with no production lines', async () => {
    const { dir } = setup({ featureFiles: { 'docs/notes.md': '# notes\n' } });
    const out = tempDir();

    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', out])).code).toBe(0);
    const facts = JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8'));
    expect(facts.prodLines).toBe(0);
    expect(facts.tier.value).toBe('XS');
  });

  it('refuses a dirty tracked tree with exit 4', async () => {
    const { dir } = setup();
    writeFileSync(join(dir, 'src/utils/money.ts'), `${MONEY}// edit\n`, 'utf8');

    const result = await run(['facts', '--repo', dir, '--base', 'base', '--out', tempDir()]);
    expect(result.code).toBe(EXIT.DIRTY);
    expect(result.stderr).toContain('src/utils/money.ts');
  });

  it('ignores untracked files when checking the tree', async () => {
    const { dir } = setup();
    writeFileSync(join(dir, 'scratch.txt'), 'local\n', 'utf8');

    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', tempDir()])).code).toBe(0);
  });

  it('refuses a base the branch does not contain with exit 5, unless --allow-behind', async () => {
    const { dir } = setup();
    gitIn(dir, ['checkout', '--quiet', 'base']);
    writeFileSync(join(dir, 'later.ts'), 'export const later = 1;\n', 'utf8');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '--quiet', '-m', 'later on base']);
    gitIn(dir, ['checkout', '--quiet', 'feature']);

    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', tempDir()])).code).toBe(EXIT.NOT_ANCESTOR);

    const out = tempDir();
    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', out, '--allow-behind'])).code).toBe(0);
    const facts = JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8'));
    expect(facts.preconditions.baseIsAncestor).toBe(false);
    // The diff still runs from the merge-base, so the base's later commit is not in it.
    expect(facts.files.map((f) => f.path)).not.toContain('later.ts');
  });

  it('exits 6 when HEAD is not the expected commit', async () => {
    const { dir } = setup();
    const result = await run(['facts', '--repo', dir, '--base', 'base', '--out', tempDir(), '--expect-head', 'deadbeef']);
    expect(result.code).toBe(EXIT.HEAD_MOVED);
  });

  it('exits 2 for a base ref that does not exist', async () => {
    const { dir } = setup();
    const result = await run(['facts', '--repo', dir, '--base', 'no-such-ref', '--out', tempDir()]);
    expect(result.code).toBe(EXIT.GIT);
  });

  it('exits 1 for usage errors', async () => {
    const { dir } = setup();
    expect((await run(['facts', '--repo', dir, '--base', 'base'])).code).toBe(EXIT.USAGE);
    expect((await run(['facts', '--nope'])).code).toBe(EXIT.USAGE);
    expect((await run(['nope'])).code).toBe(EXIT.USAGE);
    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', tempDir(), '--quick', '--full'])).code).toBe(
      EXIT.USAGE,
    );
  });

  it('computes triggers from the merge-base even with --since, and reports the delta apart', async () => {
    const { dir, triggers } = setup();
    const first = gitIn(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'src/utils/extra.ts'), 'export const extra = 2;\n', 'utf8');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '--quiet', '-m', 'fix(utils): extra']);

    const out = tempDir();
    const result = await run(['facts', '--repo', dir, '--base', 'base', '--out', out, '--since', first, '--triggers', triggers]);
    expect(result.code, result.stderr).toBe(0);

    const facts = JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8'));
    expect(facts.since.files).toEqual(['src/utils/extra.ts']);
    // WRITE came in before `--since` and still counts.
    expect(facts.triggers.ids).toContain('WRITE');
    // A fix(...) commit subject is not an incident: FIX needs a fix/ or hotfix/
    // branch, or --fix.
    expect(facts.triggers.ids).not.toContain('FIX');
    expect(existsSync(join(out, 'diff-since.patch'))).toBe(true);
  });

  it('reports tool attribution in commit messages', async () => {
    const { dir } = setup();
    writeFileSync(join(dir, 'src/utils/more.ts'), 'export const more = 3;\n', 'utf8');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '--quiet', '-m', 'feat: more\n\nCo-Authored-By: Bot <noreply@example.com>']);

    const out = tempDir();
    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', out])).code).toBe(0);
    const facts = JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8'));
    expect(facts.attribution.hits).toHaveLength(1);
    expect(facts.attribution.hits[0].line).toContain('noreply@example.com');
  });

  it('reports a merge of another branch as foreign, and a merge of the base as not', async () => {
    const { dir } = setup();
    gitIn(dir, ['checkout', '--quiet', '-b', 'other', 'base']);
    writeFileSync(join(dir, 'src/other.ts'), 'export const other = 1;\n', 'utf8');
    gitIn(dir, ['add', '-A']);
    gitIn(dir, ['commit', '--quiet', '-m', 'other work']);
    gitIn(dir, ['checkout', '--quiet', 'feature']);
    gitIn(dir, ['merge', '--quiet', '--no-ff', '--no-edit', 'other']);

    const out = tempDir();
    expect((await run(['facts', '--repo', dir, '--base', 'base', '--out', out])).code).toBe(0);
    const facts = JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8'));
    expect(facts.foreignMerges).toHaveLength(1);
    expect(facts.foreignMerges[0].parent).toBe(gitIn(dir, ['rev-parse', 'other']));
  });
});

describe('pr-local facts: suite and the logic the change touches', { timeout: 30_000 }, () => {
  const DISCOUNT = [
    'export function applyDiscount(total: number, rate: number): number {',
    '  if (rate <= 0) return total;',
    '  return total - total * rate;',
    '}',
    '',
  ].join('\n');
  const FLAT = "export function greeting(name: string): string {\n  return 'Hola ' + name;\n}\n";

  async function factsOf(baseFiles, featureFiles) {
    repo = makeRepo({ baseFiles, featureFiles });
    const out = tempDir();
    const result = await run(['facts', '--repo', repo.dir, '--base', 'base', '--out', out]);
    expect(result.code, result.stderr).toBe(EXIT.OK);
    return {
      facts: JSON.parse(readFileSync(join(out, 'facts.json'), 'utf8')),
      md: readFileSync(join(out, 'facts.md'), 'utf8'),
    };
  }

  it('lists the logic a change adds in a repo with no test suite', async () => {
    const { facts, md } = await factsOf(
      { 'src/utils/text.ts': FLAT },
      { 'src/utils/discount.ts': DISCOUNT, 'docs/discount.md': '# discount\n' },
    );

    expect(facts.coverage.suite).toBe('none');
    expect(facts.coverage.hasTestSuite).toBe(false);
    expect(facts.coverage.orphans).toEqual([]);
    expect(facts.coverage.logicTouchedCount).toBe(1);
    expect(facts.coverage.logicTouched).toEqual([
      {
        change: 'added',
        container: null,
        endLine: 4,
        kind: 'function',
        line: 1,
        name: 'applyDiscount',
        path: 'src/utils/discount.ts',
        reasons: ['branches', 'arithmetic'],
        scope: 'exported',
        suite: 'none',
      },
    ]);
    expect(md).toContain('sin suite de su lenguaje: 1');
    expect(md).toContain('applyDiscount (src/utils/discount.ts:1, added)');
  });

  it('marks a change to an existing function as modified', async () => {
    const { facts } = await factsOf(
      { 'src/utils/discount.ts': DISCOUNT },
      { 'src/utils/discount.ts': DISCOUNT.replace('rate <= 0', 'rate <= 0 || rate > 1') },
    );

    expect(facts.coverage.logicTouched.map((e) => [e.name, e.change, e.suite])).toEqual([
      ['applyDiscount', 'modified', 'none'],
    ]);
  });

  it('lists nothing for a change with no logic, suite or not', async () => {
    const { facts } = await factsOf({ 'src/utils/text.ts': FLAT }, { 'src/utils/text.ts': FLAT.replace('Hola', 'Hello') });

    expect(facts.coverage.suite).toBe('none');
    expect(facts.coverage.logicTouched).toEqual([]);
    expect(facts.coverage.logicTouchedCount).toBe(0);
  });

  it('leaves test files out, and says the suite is present when there is one', async () => {
    const { facts } = await factsOf(
      { 'test/discount.test.ts': "import { applyDiscount } from '../src/utils/discount';\n" },
      {
        'src/utils/discount.ts': DISCOUNT,
        'test/discount.test.ts': "import { applyDiscount } from '../src/utils/discount';\nfunction cases(n: number) {\n  for (let i = 0; i < n; i++) applyDiscount(i, 0.1);\n}\n",
      },
    );

    expect(facts.coverage.suite).toBe('present');
    expect(facts.coverage.logicTouched.map((e) => [e.name, e.suite])).toEqual([['applyDiscount', 'present']]);
  });

  it('answers the suite per language in a repo with two stacks', async () => {
    const { facts } = await factsOf(
      { 'api/tests/Shop.Tests/OrderServiceTests.cs': 'public class OrderServiceTests { }\n' },
      { 'web/src/utils/discount.ts': DISCOUNT },
    );

    expect(facts.coverage.suite).toBe('present');
    expect(facts.coverage.logicTouched.map((e) => [e.name, e.suite])).toEqual([['applyDiscount', 'none']]);
  });
});

describe('pr-local prompts and render', () => {
  it('writes the prompt CI would send, identical apart from the untrusted-block ids', async () => {
    const { dir } = setup();
    const out = tempDir();
    const body = join(tempDir(), 'body.md');
    writeFileSync(body, 'Adds an orders endpoint.\n', 'utf8');

    const result = await run([
      'prompts', '--repo', dir, '--base', 'base', '--out', out,
      '--checks', 'quality,security', '--title', 'Orders', '--body-file', body,
    ]);
    expect(result.code, result.stderr).toBe(0);

    const system = readFileSync(join(out, 'prompts', 'quality.system.md'), 'utf8');
    const user = readFileSync(join(out, 'prompts', 'quality.user.md'), 'utf8');

    // What CI would build for the same inputs.
    const check = getCheck('quality');
    const repoConfig = loadRepoConfig({ repo: dir });
    const head = gitIn(dir, ['rev-parse', 'HEAD']);
    const ctx = await buildContext({
      check,
      inputs: {
        base: 'base',
        head,
        repo: gitIn(dir, ['rev-parse', '--show-toplevel']),
        headRef: 'feature',
        prTitle: 'Orders',
        prBody: 'Adds an orders endpoint.\n',
      },
      config: checkConfig(repoConfig, 'quality'),
      fetchBase: false,
    });
    // The one deliberate difference: the header names the repository, never the
    // folder it is checked out in, so two worktrees of one commit agree.
    const built = check.buildPrompt({ ...ctx, repo: repoName(dir) });

    expect(user).toContain(`Repo: ${repoName(dir)}
`);
    expect(user).not.toContain(ctx.repo);
    expect(system).toBe(built.system);
    expect(user.replace(UUID, 'ID')).toBe(built.prompt.replace(UUID, 'ID'));
    expect(user).toMatch(/AUTHOR_INPUT_BEGIN [0-9a-f-]{36}/);
    expect(user).toContain('## Output format');

    const index = JSON.parse(readFileSync(join(out, 'prompts', 'index.json'), 'utf8'));
    expect(index.checks.map((c) => [c.check, c.kind])).toEqual([
      ['quality', 'prompt'],
      ['security', 'prompt'],
    ]);
  });

  it('writes a skip verdict where CI would not call a model', async () => {
    const { dir } = setup();
    const out = tempDir();

    expect((await run(['prompts', '--repo', dir, '--base', 'base', '--out', out, '--checks', 'criteria'])).code).toBe(0);

    // The branch carries no task id: the criteria check skips, green.
    const skip = JSON.parse(readFileSync(join(out, 'prompts', 'criteria.skip.json'), 'utf8'));
    expect(skip.status).toBe('skipped');
    expect(existsSync(join(out, 'prompts', 'criteria.user.md'))).toBe(false);

    // Rendering a skipped check copies its verdict.
    expect((await run(['render', '--out', out, '--check', 'criteria'])).code).toBe(0);
    const verdict = JSON.parse(readFileSync(join(out, 'verdicts', 'criteria.json'), 'utf8'));
    expect(verdict.status).toBe('skipped');
  });

  it('reads the task from a task file', async () => {
    const { dir } = setup();
    const out = tempDir();
    const taskFile = join(tempDir(), 'task.json');
    writeFileSync(
      taskFile,
      JSON.stringify({ id: '321', title: 'Orders endpoint', description: 'Criteria:\n1. POST /orders returns 201' }),
      'utf8',
    );

    const result = await run([
      'prompts', '--repo', dir, '--base', 'base', '--out', out,
      '--checks', 'criteria', '--head-ref', 'feature/321-orders', '--task-file', taskFile,
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(out, 'prompts', 'criteria.user.md'), 'utf8')).toContain('POST /orders returns 201');
    const saved = JSON.parse(readFileSync(join(out, 'prompts', 'criteria.ctx.json'), 'utf8'));
    expect(saved.taskId).toBe('321');
  });

  it('renders an answer into the verdict shape CI writes', async () => {
    const { dir } = setup();
    const out = tempDir();
    expect((await run(['prompts', '--repo', dir, '--base', 'base', '--out', out, '--checks', 'quality'])).code).toBe(0);

    const answer = join(tempDir(), 'quality.json');
    writeFileSync(
      answer,
      '```json\n' +
        JSON.stringify({
          overall: 'FAIL',
          summary: 'Unvalidated body echoed back.',
          findings: [
            { severity: 'high', issue: 'Echoes the request body', location: 'src/api/orders.ts:5', recommendation: 'Validate it.' },
          ],
        }) +
        '\n```\n',
      'utf8',
    );

    const result = await run(['render', '--out', out, '--check', 'quality', '--in', answer, '--model', 'reviewer']);
    expect(result.code, result.stderr).toBe(0);

    const verdict = JSON.parse(readFileSync(join(out, 'verdicts', 'quality.json'), 'utf8'));
    expect(verdict).toMatchObject({
      schema: 1,
      check: 'quality',
      status: 'fail',
      blocking: true,
      summary: 'Unvalidated body echoed back.',
    });
    expect(verdict.rows[0]).toMatchObject({ id: 'Q1', verdict: 'ALTA' });
    expect(verdict.meta.model).toBe('reviewer');
  });

  it('refuses an answer without the check shape, and render before prompts', async () => {
    const { dir } = setup();
    const out = tempDir();
    const answer = join(tempDir(), 'bad.json');
    writeFileSync(answer, JSON.stringify({ overall: 'PASS' }), 'utf8');

    expect((await run(['render', '--out', out, '--check', 'quality', '--in', answer])).code).toBe(EXIT.USAGE);

    expect((await run(['prompts', '--repo', dir, '--base', 'base', '--out', out, '--checks', 'quality'])).code).toBe(0);
    expect((await run(['render', '--out', out, '--check', 'quality', '--in', answer])).code).toBe(EXIT.USAGE);
    expect(existsSync(join(out, 'verdicts', 'quality.json'))).toBe(false);
  });

  it('rejects an unknown check name', async () => {
    const { dir } = setup();
    const result = await run(['prompts', '--repo', dir, '--base', 'base', '--out', tempDir(), '--checks', 'nope']);
    expect(result.code).toBe(EXIT.USAGE);
  });
});

describe('pr-local config, inventory and rules', () => {
  it('prints the config with the local block from head and base', async () => {
    repo = makeRepo({
      baseFiles: { '.pr-validator.json': JSON.stringify({ local: { helperDirs: ['src/utils'] } }) },
      featureFiles: { '.pr-validator.json': JSON.stringify({ local: { helperDirs: ['src/lib'] } }) },
    });

    const result = await run(['config', '--repo', repo.dir, '--base', 'base']);
    expect(result.code, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.head.local).toEqual({ helperDirs: ['src/lib'] });
    expect(value.base.local).toEqual({ helperDirs: ['src/utils'] });
    expect(value.checks.duplication).toBeDefined();
  });

  it('lists exported symbols under the given directories only', async () => {
    const { dir } = setup();
    const result = await run(['inventory', '--repo', dir, '--dirs', 'src/utils']);
    expect(result.code, result.stderr).toBe(0);

    const value = JSON.parse(result.stdout);
    const names = value.symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['formatCurrency', 'formatMoney']));
    expect(names).not.toContain('registerOrders');
    expect(value.symbols.every((s) => s.body === undefined)).toBe(true);
  });

  it('loads repository rules and extra packs apart, scoped to the touched files', async () => {
    const { dir } = setup();
    const pack = tempDir();
    writeFileSync(join(pack, 'atomic.md'), '# Atomic components\n\nReuse primitives.\n', 'utf8');
    const out = tempDir();

    const result = await run(['rules', '--repo', dir, '--base', 'base', '--extra-dir', pack, '--out', out]);
    expect(result.code, result.stderr).toBe(0);

    const value = JSON.parse(result.stdout);
    expect(value.touched).toEqual(['docs/notes.md', 'src/api/orders.ts', 'src/utils/money.ts']);
    expect(value.extra).toHaveLength(1);
    expect(value.extra[0].sources.map((s) => s.path)).toEqual(['atomic.md']);

    const text = readFileSync(join(out, 'rules.md'), 'utf8');
    expect(text).toContain('Reuse primitives.');
    expect(text).toContain('Functions are named in English.');
  });
});

describe('pr-local help and version', () => {
  it('prints help and version with exit 0', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Commands:');

    const factsHelp = await run(['facts', '--help']);
    expect(factsHelp.code).toBe(0);
    expect(factsHelp.stdout).toContain('--triggers');

    const version = await run(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
