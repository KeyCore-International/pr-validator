// What this validator will and will not open.
//
// Rule files, indexed sources and the test corpus are all read out of a tree a
// pull request can rewrite, and what they contain reaches an external gateway.
// So a symlink is refused whatever it points at: `.git/config` — which holds
// the credential `actions/checkout` writes — is INSIDE the repository, and a
// containment test alone would let it through.
//
// The other half of these tests is the opposite risk: a repository whose rules
// really are symlinks must not have them vanish in silence. Every refusal is
// recorded and reported.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isRegularFileWithin } from '../src/context/files.mjs';
import { loadRules, rulesSourceNotes } from '../src/context/rules.mjs';
import { crossWithTests } from '../src/context/coverage.mjs';
import { buildSymbolIndex } from '../src/context/symbol-index.mjs';
import { noRulesVerdict } from '../src/checks/rules/render.mjs';
import { makeRepo } from './fixtures/repo.mjs';

/**
 * Creating a symlink needs a privilege Windows does not grant by default.
 *
 * The guard itself runs on every platform; only the cases that have to BUILD a
 * symlink to attack it are gated, so a developer machine that cannot create
 * one reports skips instead of false passes.
 */
const SYMLINKS_SUPPORTED = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'prv-symlink-probe-'));
  try {
    writeFileSync(join(dir, 'target'), 'x', 'utf8');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

const describeSymlinks = describe.skipIf(!SYMLINKS_SUPPORTED);

const dirs = [];
let repo;

afterEach(() => {
  repo?.cleanup();
  repo = undefined;
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** A throwaway directory tree, cleaned up after the test. */
function makeTree(files = {}, prefix = 'prv-guard-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) write(join(dir, path), content);
  return dir;
}

function write(full, content) {
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function link(target, at, type) {
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, type);
}

describe('isRegularFileWithin', () => {
  it('accepts a regular file inside the root', () => {
    const root = makeTree({ 'docs/a.md': '# a\n' });

    expect(isRegularFileWithin(join(root, 'docs/a.md'), root)).toBe(true);
  });

  it('refuses a directory, so a folder named like a rule file is not read', () => {
    const root = makeTree({ 'docs/a.md': '# a\n' });

    expect(isRegularFileWithin(join(root, 'docs'), root)).toBe(false);
  });

  it('refuses a path that does not exist', () => {
    const root = makeTree();

    expect(isRegularFileWithin(join(root, 'missing.md'), root)).toBe(false);
  });

  it('refuses a file outside the root', () => {
    const root = makeTree();
    const other = makeTree({ 'secret.txt': 'TOKEN\n' });

    expect(isRegularFileWithin(join(other, 'secret.txt'), root)).toBe(false);
  });

  // A `startsWith` containment test would read `/srv/repo-secrets` as living
  // inside `/srv/repo`. Comparison is component-wise for exactly this case.
  it('does not treat a sibling with a longer name as being inside', () => {
    const parent = makeTree();
    const root = join(parent, 'repo');
    write(join(parent, 'repo-secrets', 'creds.md'), '# creds\n');
    mkdirSync(root, { recursive: true });

    expect(isRegularFileWithin(join(parent, 'repo-secrets', 'creds.md'), root)).toBe(false);
  });

  // Anything thrown here would be laundered into a non-blocking tool error, so
  // the guard answers false and never raises.
  it.each([
    ['', ''],
    [null, null],
    [undefined, undefined],
    ['\0invalid', '\0invalid'],
  ])('answers false instead of throwing for (%s, %s)', (path, root) => {
    expect(() => isRegularFileWithin(path, root)).not.toThrow();
    expect(isRegularFileWithin(path, root)).toBe(false);
  });

  describeSymlinks('with symlinks', () => {
    // The load-bearing half: the target being inside the repository does NOT
    // make a link safe, because `.git/config` is inside the repository.
    it('refuses a symlink even when its target is inside the root', () => {
      const root = makeTree({ 'inside.md': '# inside\n' });
      link(join(root, 'inside.md'), join(root, 'docs/link.md'));

      expect(isRegularFileWithin(join(root, 'docs/link.md'), root)).toBe(false);
    });

    it('refuses a symlink pointing outside the root', () => {
      const root = makeTree();
      const other = makeTree({ 'secret.txt': 'TOKEN\n' });
      link(join(other, 'secret.txt'), join(root, 'link.md'));

      expect(isRegularFileWithin(join(root, 'link.md'), root)).toBe(false);
    });

    it('refuses a dangling symlink without throwing', () => {
      const root = makeTree();
      link(join(root, 'nowhere.md'), join(root, 'dangling.md'));

      expect(isRegularFileWithin(join(root, 'dangling.md'), root)).toBe(false);
    });

    // Reached through a symlinked FOLDER the entries look local; only the real
    // path says otherwise.
    it('refuses a file reached through a symlinked directory that leaves the root', () => {
      const root = makeTree();
      const other = makeTree({ 'creds.md': '# creds\n' });
      link(other, join(root, 'outside'), 'junction');

      expect(isRegularFileWithin(join(root, 'outside', 'creds.md'), root)).toBe(false);
    });
  });
});

describeSymlinks('loadRules with symlinked sources', () => {
  const REAL = '# Naming\nPascalCase.\n';

  it('does not read a rule file that is a symlink', () => {
    const tree = makeTree({ '.claude/rules/naming.md': REAL, 'runner-token.txt': 'TOKEN-SECRETO\n' });
    link(join(tree, 'runner-token.txt'), join(tree, '.claude/rules/leak.md'));

    const rules = loadRules({ repo: tree });

    expect(rules.text).toContain('PascalCase');
    expect(rules.text).not.toContain('TOKEN-SECRETO');
    expect(rules.sources.map((s) => s.path)).not.toContain('leak.md');
  });

  // The refusal is the fix; recording it is what keeps the fix honest.
  it('records the refused file as an omission with its own reason', () => {
    const tree = makeTree({ '.claude/rules/naming.md': REAL, 'runner-token.txt': 'TOKEN\n' });
    link(join(tree, 'runner-token.txt'), join(tree, '.claude/rules/leak.md'));

    const rules = loadRules({ repo: tree });
    const omitted = rules.omittedSources.find((s) => s.path === 'leak.md');

    expect(omitted).toBeDefined();
    expect(omitted.reason).toContain('no es un archivo regular dentro del repositorio');
    expect(rules.unreadable).toEqual(['leak.md']);
  });

  it('reports the refusal in the notes the comment carries', () => {
    const tree = makeTree({ '.claude/rules/naming.md': REAL, 'runner-token.txt': 'TOKEN\n' });
    link(join(tree, 'runner-token.txt'), join(tree, '.claude/rules/leak.md'));

    const notes = rulesSourceNotes(loadRules({ repo: tree }));

    expect(notes.some((n) => n.includes('Reglas no leídas') && n.includes('leak.md'))).toBe(true);
    // Not folded into the out-of-scope line: they send a developer elsewhere.
    expect(notes.some((n) => n.includes('no aplicar a los archivos de este PR'))).toBe(false);
  });

  it('records a refused root source instead of reporting it as absent', () => {
    const tree = makeTree({ 'CLAUDE.md': '# Proyecto\nNada de console.log.\n' });
    link(join(tree, 'CLAUDE.md'), join(tree, 'AGENTS.md'));

    const rules = loadRules({ repo: tree });

    expect(rules.sources.map((s) => s.path)).toEqual(['CLAUDE.md']);
    expect(rules.unreadable).toEqual(['AGENTS.md']);
  });

  // A monorepo pointing `.claude/rules` at a folder it really owns keeps its
  // rules: the guard rejects the link, not the directory it stands for.
  it('still loads a rules folder that is an in-repo directory symlink', () => {
    const tree = makeTree({ 'packages/conventions/rules/naming.md': REAL });
    link(join(tree, 'packages/conventions/rules'), join(tree, '.claude/rules'), 'junction');

    const rules = loadRules({ repo: tree });

    expect(rules.sources.map((s) => s.path)).toEqual(['naming.md']);
    expect(rules.text).toContain('PascalCase');
    expect(rules.unreadable).toEqual([]);
  });

  // The regression the previous attempt introduced: every rule refused, the
  // corpus empty, and the check reporting a repository that declared nothing.
  it('does not report an empty repository when the guard refused every rule', () => {
    const tree = makeTree({ 'conventions/naming.md': REAL, 'conventions/api.md': '# API\n' });
    link(join(tree, 'conventions/naming.md'), join(tree, '.claude/rules/naming.md'));
    link(join(tree, 'conventions/api.md'), join(tree, '.claude/rules/api.md'));

    const rules = loadRules({ repo: tree });

    expect(rules.text).toBe('');
    expect(rules.empty).toBe(false);
    expect(rules.unreadable).toEqual(['api.md', 'naming.md']);

    // What the runner turns into the skipped verdict's reason.
    const message = noRulesVerdict(rules).emptyMessage;
    expect(message).not.toContain('Sin reglas declaradas');
    expect(message).toContain('naming.md');
    expect(message).toContain('api.md');
  });
});

describe('loadRules without symlinks', () => {
  it('still calls a repository that wrote nothing down empty', () => {
    const rules = loadRules({ repo: makeTree({ 'src/a.cs': 'class A {}\n' }) });

    expect(rules.empty).toBe(true);
    expect(rules.unreadable).toEqual([]);
    expect(noRulesVerdict(rules).emptyMessage).toContain('Sin reglas declaradas');
  });
});

describeSymlinks('buildSymbolIndex with symlinked sources', () => {
  it('leaves a symlinked file out of the index and counts it as skipped', () => {
    const outside = makeTree({ 'Outside.cs': 'public class SecretoDeFuera { public void Ir() { } }\n' });
    repo = makeRepo({ baseFiles: { 'src/Service.cs': 'public class Service { public void Ir() { } }\n' } });
    link(join(outside, 'Outside.cs'), join(repo.dir, 'src/Fuera.cs'));

    const index = buildSymbolIndex({ repo: repo.dir });

    expect(index.symbols.map((s) => s.name)).toContain('Service');
    expect(index.symbols.map((s) => s.name)).not.toContain('SecretoDeFuera');
    expect(index.skippedFiles).toBe(1);
  });
});

describeSymlinks('crossWithTests with symlinked test files', () => {
  const symbol = (name) => ({ name, path: 'src/a.cs', line: 1, kind: 'method', signature: '' });

  it('does not read a symlinked test file, and counts the refusal', () => {
    const outside = makeTree({ 'Secret.test.mjs': 'Recalcular()\n' });
    repo = makeRepo({ baseFiles: { 'tests/Real.test.mjs': 'nada\n' } });
    link(join(outside, 'Secret.test.mjs'), join(repo.dir, 'tests/Link.test.mjs'));

    const out = crossWithTests({ repo: repo.dir, symbols: [symbol('Recalcular')] });

    // Not read, so the symbol stays uncovered — the direction that costs a
    // question rather than hiding one.
    expect(out.orphans.map((s) => s.name)).toEqual(['Recalcular']);
    expect(out.testFileCount).toBe(2);
    expect(out.refusedTestFiles).toBe(1);
  });
});
