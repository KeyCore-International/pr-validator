// Where rules are found and how a rule says which files it governs.
//
// Repositories write scope in whatever shape their editor taught them: Claude
// Code's `paths:` as one quoted comma list or a YAML block list, Cursor's
// `globs:`. A shape the gate cannot read is a rule applied to every pull
// request, or worse, a glob split in half at the comma inside `{ts,tsx}`.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { declaredScope, loadRules, matchesAny, pinnedInstructionFiles, RULE_SOURCES, rulesDirLabel } from '../src/context/rules.mjs';
import { noRulesVerdict } from '../src/checks/rules/render.mjs';

let repoDir;
afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  repoDir = undefined;
});

/** A throwaway repository tree with the given files. */
function makeTree(files) {
  repoDir = mkdtempSync(join(tmpdir(), 'prv-rule-sources-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(repoDir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return repoDir;
}

const paths = (rules) => rules.sources.map((s) => s.path);

// The shape a real repository uses throughout its `.claude/rules`.
const TS_RULE = [
  '---',
  'description: Component and hook conventions',
  'paths: "src/**/*.ts, src/**/*.tsx"',
  '---',
  '',
  '# Components',
  'One component per file.',
  '',
].join('\n');

const BLOCK_RULE = [
  '---',
  'description: API conventions',
  'paths:',
  '  - "src/Api/**/*.cs"',
  "  - '**/Program.cs'",
  '  # the composition root counts too',
  '  - **/*.{csproj,props}',
  'alwaysApply: false',
  '---',
  '# API',
  'One controller per resource.',
].join('\n');

describe('declaredScope reads every shape a rule is written in', () => {
  it('splits a quoted comma list (paths: "a, b")', () => {
    expect(declaredScope(TS_RULE)).toEqual(['src/**/*.ts', 'src/**/*.tsx']);
  });

  it('reads a YAML block list, skipping comments and stopping at the next key', () => {
    expect(declaredScope(BLOCK_RULE)).toEqual([
      'src/Api/**/*.cs',
      '**/Program.cs',
      '**/*.{csproj,props}',
    ]);
  });

  it('accepts paths alongside globs, appliesTo and files', () => {
    expect(declaredScope('---\npaths: "**/*.cs"\n---\n')).toEqual(['**/*.cs']);
    expect(declaredScope('---\nfiles: src/**\n---\n')).toEqual(['src/**']);
    expect(declaredScope('---\napplies_to: [a/**]\n---\n')).toEqual(['a/**']);
  });

  // The comma inside a brace group belongs to the glob. Splitting there used
  // to produce `src/**/*.{ts` and `tsx}`, neither of which matches anything.
  it.each([
    ['paths: "src/**/*.{ts,tsx}, app/**"', ['src/**/*.{ts,tsx}', 'app/**']],
    ['globs: **/*.{ts,vue}', ['**/*.{ts,vue}']],
    ['globs: ["src/**/*.{ts,tsx}", "lib/**"]', ['src/**/*.{ts,tsx}', 'lib/**']],
    ["paths: ['a/**', 'b/**']", ['a/**', 'b/**']],
  ])('keeps brace groups whole: %s', (line, expected) => {
    expect(declaredScope(`---\n${line}\n---\n`)).toEqual(expected);
  });

  it('drops a trailing YAML comment but not a # inside quotes', () => {
    expect(declaredScope('---\npaths: "src/**" # app code\n---\n')).toEqual(['src/**']);
    expect(declaredScope('---\npaths: "docs/#drafts/**"\n---\n')).toEqual(['docs/#drafts/**']);
  });

  it('reads a frontmatter written with CRLF line endings', () => {
    expect(declaredScope('---\r\npaths:\r\n  - "src/**"\r\n---\r\n# R\r\n')).toEqual(['src/**']);
  });

  // Cursor writes `globs:` with nothing after it for a rule that always applies.
  it('treats an empty key with no list under it as no declared scope', () => {
    expect(declaredScope('---\ndescription: x\nglobs:\nalwaysApply: true\n---\n')).toEqual([]);
  });

  it('moves on to a later scope key when the first one is empty', () => {
    expect(declaredScope('---\nglobs:\npaths: "src/**"\n---\n')).toEqual(['src/**']);
  });

  it('ignores a scope key that only appears in the body', () => {
    expect(declaredScope('# Rule\npaths: "src/**"\n')).toEqual([]);
  });
});

describe('a rule scoped with paths: is matched against the touched files', () => {
  it('loads a quoted comma-list rule for a touched .tsx', () => {
    const repo = makeTree({ '.claude/rules/components.md': TS_RULE });
    const rules = loadRules({ repo, touched: ['src/ui/Card.tsx'] });

    expect(paths(rules)).toEqual(['components.md']);
    expect(rules.text).toContain('One component per file');
    expect(rules.text).not.toContain('paths:');
  });

  it('drops it, with the globs it declared, when nothing under src/ changed', () => {
    const repo = makeTree({ '.claude/rules/components.md': TS_RULE });
    const rules = loadRules({ repo, touched: ['server/Program.cs'] });

    expect(paths(rules)).toEqual([]);
    expect(rules.omittedSources[0].reason).toBe(
      'fuera de alcance (declara src/**/*.ts, src/**/*.tsx)',
    );
    expect(rules.empty).toBe(false);
  });

  it('scopes a block-list rule by any of its items', () => {
    const repo = makeTree({ '.claude/rules/api.md': BLOCK_RULE });

    expect(paths(loadRules({ repo, touched: ['src/Web/Program.cs'] }))).toEqual(['api.md']);
    expect(paths(loadRules({ repo, touched: ['src/Web/Web.csproj'] }))).toEqual(['api.md']);
    expect(paths(loadRules({ repo, touched: ['src/web/app.ts'] }))).toEqual([]);
  });

  it('matches a brace group from a quoted list', () => {
    expect(matchesAny(declaredScope('---\npaths: "src/**/*.{ts,tsx}"\n---\n'), ['src/a/b.tsx'])).toBe(
      true,
    );
  });
});

describe('.agents/rules', () => {
  it('is a rule source, right after .claude/rules', () => {
    const dirs = RULE_SOURCES.filter((s) => s.kind === 'dir').map((s) => s.path.split('\\').join('/'));
    expect(dirs.slice(0, 2)).toEqual(['.claude/rules', '.agents/rules']);
  });

  it('is read, before editor rules and root files', () => {
    const repo = makeTree({
      '.claude/rules/naming.md': '# Naming\nPascalCase.\n',
      '.agents/rules/testing.md': '# Testing\nOne assertion per behaviour.\n',
      '.cursor/rules/api.mdc': '# API\n',
      'AGENTS.md': '# Root\n',
    });

    expect(paths(loadRules({ repo }))).toEqual(['naming.md', 'testing.md', 'api.mdc', 'AGENTS.md']);
  });

  it('honours the scope its rules declare', () => {
    const repo = makeTree({ '.agents/rules/components.md': TS_RULE });

    expect(paths(loadRules({ repo, touched: ['src/a.ts'] }))).toEqual(['components.md']);
    expect(paths(loadRules({ repo, touched: ['README.md'] }))).toEqual([]);
  });

  // Two folders can both hold a `naming.md`; the comment must be able to say
  // which one it read.
  it('names a same-named file in the second folder by its full path', () => {
    const repo = makeTree({
      '.claude/rules/naming.md': '# Naming\nPascalCase.\n',
      '.agents/rules/naming.md': '# Naming\ncamelCase for locals.\n',
    });

    expect(paths(loadRules({ repo }))).toEqual(['naming.md', '.agents/rules/naming.md']);
  });

  // Commonly a junction to `.claude/rules`: reading it twice would spend the
  // budget on a duplicate of every rule.
  it('reads a mirror of .claude/rules once', () => {
    const repo = makeTree({ '.claude/rules/naming.md': '# Naming\nPascalCase.\n' });
    try {
      mkdirSync(join(repo, '.agents'), { recursive: true });
      symlinkSync(join(repo, '.claude', 'rules'), join(repo, '.agents', 'rules'), 'junction');
    } catch {
      return; // The platform cannot build the link; nothing to assert.
    }

    const rules = loadRules({ repo });

    expect(paths(rules)).toEqual(['naming.md']);
    expect(rules.unreadable).toEqual([]);
  });
});

describe('the nearest AGENTS.md / CLAUDE.md for nested folders', () => {
  const MONOREPO = {
    'AGENTS.md': '# Root agents\n',
    'CLAUDE.md': '# Root claude\n',
    'packages/AGENTS.md': '# Packages agents\n',
    'packages/api/AGENTS.md': '# API agents\nControllers stay thin.\n',
    'packages/api/src/Orders.cs': 'class Orders {}\n',
    'packages/web/CLAUDE.md': '# Web claude\n',
    'docs/guide.md': '# Guide\n',
  };

  it('loads the nearest one per name above each touched file, before the root ones', () => {
    const repo = makeTree(MONOREPO);
    const rules = loadRules({ repo, touched: ['packages/api/src/Orders.cs'] });

    expect(paths(rules)).toEqual(['packages/api/AGENTS.md', 'CLAUDE.md', 'AGENTS.md']);
    expect(rules.text).toContain('Controllers stay thin');
  });

  it('loads one per sub-project touched, each once', () => {
    const repo = makeTree(MONOREPO);
    const rules = loadRules({
      repo,
      touched: ['packages/api/src/Orders.cs', 'packages/web/src/App.vue', 'packages/api/x.cs'],
    });

    expect(paths(rules)).toEqual([
      'packages/api/AGENTS.md',
      'packages/web/CLAUDE.md',
      'packages/AGENTS.md',
      'CLAUDE.md',
      'AGENTS.md',
    ]);
  });

  it('adds nothing for files outside any nested folder with instructions', () => {
    const repo = makeTree(MONOREPO);

    expect(paths(loadRules({ repo, touched: ['docs/guide.md', 'README.md'] }))).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
    ]);
  });

  // Without the touched files there is no "nearest": only the root is read.
  it('reads only the root files when the touched files are unknown', () => {
    const repo = makeTree(MONOREPO);

    expect(paths(loadRules({ repo }))).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('accepts Windows separators and ignores paths that leave the tree', () => {
    const repo = makeTree(MONOREPO);
    const rules = loadRules({
      repo,
      touched: ['packages\\api\\src\\Orders.cs', '../outside/AGENTS.md', '/etc/passwd'],
    });

    expect(paths(rules)).toEqual(['packages/api/AGENTS.md', 'CLAUDE.md', 'AGENTS.md']);
  });

  // The nearest AGENTS.md is served before the rule folder, so it is the
  // folder's file that goes when only one fits.
  it('still drops whole files for budget, and says so, keeping the nearest AGENTS.md', () => {
    const repo = makeTree({
      '.claude/rules/naming.md': `# Naming\n${'x'.repeat(200)}\n`,
      'packages/api/AGENTS.md': `# API\n${'y'.repeat(200)}\n`,
    });
    const rules = loadRules({ repo, touched: ['packages/api/a.cs'], maxChars: 250 });

    expect(paths(rules)).toEqual(['packages/api/AGENTS.md']);
    expect(rules.truncated).toBe(true);
    expect(rules.omittedSources).toEqual([
      expect.objectContaining({ path: 'naming.md', reason: 'presupuesto' }),
    ]);
  });
});

describe('the rules budget is spent by relevance to the change', () => {
  const big = (title, front = '') => `${front}# ${title}\n${'z'.repeat(400)}\n`;
  const scoped = (globs) => `---\npaths: "${globs}"\n---\n`;

  it('pins the root AGENTS.md, then narrow scopes, then catch-alls, then unscoped rules', () => {
    const repo = makeTree({
      'AGENTS.md': big('Agents'),
      'CLAUDE.md': '@AGENTS.md\n',
      '.claude/rules/a-commits.md': big('Commits'),
      '.claude/rules/b-all-cs.md': big('All C#', scoped('**/*.cs')),
      '.claude/rules/c-services.md': big('Services', scoped('**/Services/**/*.cs')),
      '.claude/rules/d-tests.md': big('Tests', scoped('**/App.Tests/**/*.cs')),
    });
    const touched = ['src/Services/Orders.cs', 'src/Services/Billing.cs', 'App.Tests/OrdersTests.cs'];
    // Room for three sections of ~420 characters, plus the 11-character shim.
    const rules = loadRules({ repo, touched, maxChars: 1340 });

    // Shown in discovery order; chosen by rank: AGENTS.md (pinned), the
    // services rule (2 touched files), the tests rule (1), CLAUDE.md fits last.
    expect(paths(rules)).toEqual(['c-services.md', 'd-tests.md', 'CLAUDE.md', 'AGENTS.md']);
    expect(rules.omittedSources.map((s) => [s.path, s.reason])).toEqual([
      ['a-commits.md', 'presupuesto'],
      ['b-all-cs.md', 'presupuesto'],
    ]);
  });

  it('pins the nearest AGENTS.md even when the touched files are unknown', () => {
    const repo = makeTree({
      'AGENTS.md': big('Agents'),
      '.claude/rules/naming.md': big('Naming'),
    });

    expect(paths(loadRules({ repo, maxChars: 500 }))).toEqual(['AGENTS.md']);
  });

  it('falls back to the nearest CLAUDE.md where there is no AGENTS.md', () => {
    const repo = makeTree({
      'web/CLAUDE.md': big('Web'),
      '.claude/rules/naming.md': big('Naming'),
    });

    expect(pinnedInstructionFiles(repo, ['web/src/App.vue'])).toEqual(['web/CLAUDE.md']);
    expect(paths(loadRules({ repo, touched: ['web/src/App.vue'], maxChars: 500 }))).toEqual(['web/CLAUDE.md']);
  });

  it('pins one file per sub-project, the root one for files at the root', () => {
    const repo = makeTree({
      'AGENTS.md': '# Root\n',
      'packages/api/AGENTS.md': '# API\n',
      'packages/web/CLAUDE.md': '# Web\n',
    });

    expect(
      pinnedInstructionFiles(repo, ['packages/api/a.cs', 'packages/web/b.vue', 'README.md']).sort(),
    ).toEqual(['AGENTS.md', 'packages/api/AGENTS.md']);
  });
});

describe('the rules folder in messages', () => {
  it('is named relative to the repository, never by an absolute checkout path', () => {
    const repo = makeTree({ 'README.md': 'x' });
    expect(rulesDirLabel(repo, undefined)).toBe('.claude/rules');
    expect(rulesDirLabel(repo, join(repo, '.claude', 'rules'))).toBe('.claude/rules');
    expect(rulesDirLabel(repo, join(repo, 'docs', 'rules'))).toBe('docs/rules');
    expect(rulesDirLabel(repo, join(tmpdir(), 'elsewhere-rules'))).toBe('.claude/rules');
    const rules = loadRules({ repo, rulesDir: join(repo, '.claude', 'rules') });
    expect(rules.dirLabel).toBe('.claude/rules');
    const message = noRulesVerdict(rules).emptyMessage;
    expect(message).toContain('(.claude/rules)');
    expect(message).not.toContain(repo);
  });
});
