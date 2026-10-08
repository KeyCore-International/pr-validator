import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetRank, buildDiff, DiffError, fitDiffToBudget, isTooLargeError, truncationNote } from '../src/context/diff.mjs';
import { classifyDiffFiles } from '../src/context/files.mjs';
import { isContentFailure } from '../src/run-check.mjs';
import { bigFile, makeRepo } from './fixtures/repo.mjs';

describe('buildDiff', () => {
  let repo;

  beforeAll(() => {
    repo = makeRepo({
      baseFiles: { 'src/a.txt': 'original a\n' },
      featureFiles: {
        'src/a.txt': 'changed a\n',
        'src/b.txt': 'new b\n',
        'src/c.txt': 'new c\n',
      },
    });
  });

  afterAll(() => repo.cleanup());

  it('produces a diff between two refs', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature' });

    expect(ctx.empty).toBe(false);
    expect(ctx.totalFiles).toBe(3);
    expect(ctx.diff).toContain('src/b.txt');
    expect(ctx.block.startsWith('```diff')).toBe(true);
  });

  it('reports an empty diff when the refs match', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'feature', head: 'feature' });

    expect(ctx.empty).toBe(true);
    expect(ctx.totalFiles).toBe(0);
    expect(ctx.block).toContain('empty');
  });

  it('throws DiffError for an unknown ref', () => {
    expect(() => buildDiff({ repo: repo.dir, base: 'nope', head: 'feature' })).toThrow(DiffError);
  });

  it('requires a base ref', () => {
    expect(() => buildDiff({ repo: repo.dir })).toThrow(DiffError);
  });

  it('does not truncate when the diff fits the budget', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 100000 });

    expect(ctx.truncated).toBe(false);
    expect(ctx.omittedFiles).toBe(0);
    expect(truncationNote(ctx)).toBeNull();
  });
});

describe('buildDiff truncation', () => {
  let repo;

  beforeAll(() => {
    repo = makeRepo({
      featureFiles: {
        'src/one.txt': bigFile(120, 'one'),
        'src/two.txt': bigFile(120, 'two'),
        'src/three.txt': bigFile(120, 'three'),
      },
    });
  });

  afterAll(() => repo.cleanup());

  it('counts how many files were dropped', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 4000 });

    expect(ctx.truncated).toBe(true);
    expect(ctx.totalFiles).toBe(3);
    expect(ctx.omittedFiles).toBeGreaterThan(0);
    expect(ctx.includedFiles + ctx.omittedFiles).toBe(ctx.totalFiles);
  });

  it('cuts on a file boundary so no half hunk reaches the model', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 4000 });
    const body = ctx.diff.replace(/\n\n\[\.\.\. diff truncated.*$/s, '');

    // Every `diff --git` header that survived must have its full hunk header.
    const headers = (body.match(/^diff --git /gm) || []).length;
    const hunks = (body.match(/^@@ /gm) || []).length;
    expect(hunks).toBeGreaterThanOrEqual(headers);
  });

  it('states the scale of the cut, not just that it happened', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 4000 });
    const note = truncationNote(ctx);

    expect(note).toContain('La revisión es parcial');
    expect(note).toContain(String(ctx.totalChars));
    expect(note).toMatch(/\d+ de \d+ archivos/);
  });
});

// "A third party is down" and "this pull request could not be read" are different
// claims, and only the first is safe to answer with a green non-blocking warning.
// A diff too large to buffer is a property of the branch: the `maxChars` budget
// cannot prevent it, because it applies to the returned string long after the
// child process has already been killed.
describe('failures caused by the change under review', () => {
  it('marks a diff that overruns the buffer as a content failure', () => {
    const err = new DiffError('x', { contentFailure: true });

    expect(isContentFailure(err)).toBe(true);
  });

  it('leaves an ordinary git failure as an infrastructure failure', () => {
    expect(isContentFailure(new DiffError('git diff failed: no such ref'))).toBe(false);
  });

  it.each([
    ['a gateway outage', new Error('fetch failed')],
    ['nothing at all', null],
  ])('does not blame the author for %s', (_label, err) => {
    expect(isContentFailure(err)).toBe(false);
  });

  // Belt and braces for a pattern the branch wrote that does not compile. The
  // glob reader no longer lets one escape, but a new caller might.
  it('treats an uncompilable pattern as a content failure', () => {
    expect(isContentFailure(new SyntaxError('Invalid regular expression'))).toBe(true);
  });
});

describe('isTooLargeError', () => {
  it.each([
    ['the ENOBUFS code', { code: 'ENOBUFS', message: 'spawn error' }],
    ['the maxBuffer message', { message: 'stdout maxBuffer length exceeded' }],
  ])('recognises %s', (_label, err) => {
    expect(isTooLargeError(err)).toBe(true);
  });

  it.each([
    ['a missing ref', { message: "fatal: bad revision 'origin/nope'" }],
    ['nothing', null],
  ])('does not mistake %s for it', (_label, err) => {
    expect(isTooLargeError(err)).toBe(false);
  });
});

// A branch whose production code alone nearly fills the budget used to lose its
// last service to the docs and tests that git happened to print first, and the
// prompt only said how many files were missing, never which.
describe('the diff budget serves production code first and names what it leaves out', () => {
  let repo;

  beforeAll(() => {
    repo = makeRepo({
      featureFiles: {
        'Api.Tests/OrdersTests.cs': bigFile(30, 'test'),
        'Api/Services/Orders.cs': bigFile(30, 'orders'),
        'Api/Services/Zeta.cs': bigFile(30, 'zeta'),
        'docs/design-note.md': bigFile(30, 'doc'),
        'pr-body.md': bigFile(30, 'body'),
      },
    });
  });

  afterAll(() => repo.cleanup());

  it('keeps every production file and drops docs and tests before them', () => {
    // Room for two of the five ~2 400-character sections.
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 5200 });

    expect(ctx.truncated).toBe(true);
    expect(ctx.diff).toContain('orders 29');
    expect(ctx.diff).toContain('zeta 29');
    expect(ctx.diff).not.toContain('test 0');
    expect(ctx.omittedPaths).toEqual(['Api.Tests/OrdersTests.cs', 'docs/design-note.md', 'pr-body.md']);
    expect(ctx.includedFiles + ctx.omittedFiles).toBe(ctx.totalFiles);
    expect(ctx.partialPath).toBeNull();
  });

  it('names every omitted file in the diff body', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 5200 });
    const marker = ctx.diff.slice(ctx.diff.lastIndexOf('[... diff truncated'));

    for (const path of ctx.omittedPaths) expect(marker).toContain(path);
    expect(marker).toContain('3 file(s) left out');
  });

  it('gives tests what production left over before docs', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 7800 });

    expect(ctx.diff).toContain('test 29');
    expect(ctx.omittedPaths).toEqual(['docs/design-note.md', 'pr-body.md']);
  });

  it('cuts the first production file short only when no file fits whole', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature', maxChars: 1000 });

    expect(ctx.partialPath).toBe('Api/Services/Orders.cs');
    expect(ctx.diff).toContain('orders 0');
    expect(ctx.diff).toContain('Api/Services/Orders.cs is cut short');
    expect(ctx.omittedPaths).not.toContain('Api/Services/Orders.cs');
    expect(ctx.includedFiles + ctx.omittedFiles).toBe(ctx.totalFiles);
  });
});

describe('fitDiffToBudget and budgetRank', () => {
  const section = (path, size) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${'x'.repeat(size)}\n`;

  it('ranks production, then styles and locales, then tests, then everything else', () => {
    expect(budgetRank('src/a.ts')).toBe(0);
    expect(budgetRank('src/a.css')).toBe(1);
    expect(budgetRank('src/locales/es.json')).toBe(1);
    expect(budgetRank('src/a.spec.ts')).toBe(2);
    expect(budgetRank('README.md')).toBe(3);
    expect(budgetRank('.claude/rules/a.md')).toBe(3);
  });

  it('skips a file that does not fit and keeps walking, in git order', () => {
    const diff = section('src/big.ts', 500) + section('src/small.ts', 10) + section('src/other.ts', 10);
    const fit = fitDiffToBudget(diff, 300);

    expect(fit.included).toEqual(['src/small.ts', 'src/other.ts']);
    expect(fit.omitted).toEqual(['src/big.ts']);
    expect(fit.diff.indexOf('src/small.ts')).toBeLessThan(fit.diff.indexOf('src/other.ts'));
  });

  it('leaves a diff that fits untouched', () => {
    const diff = section('src/a.ts', 10) + section('README.md', 10);
    expect(fitDiffToBudget(diff, 10000)).toEqual({
      diff,
      truncated: false,
      included: ['src/a.ts', 'README.md'],
      omitted: [],
      partial: null,
    });
  });
});

// The default stat abbreviates a long path to `.../Services/X.cs`, and the file
// list read from it scopes the rules: a rule for `**/Infrastructure/Services/**`
// was dropped as out of scope for a branch that changed exactly those files.
describe('the stat keeps full paths', () => {
  let repo;
  const long = 'Very.Long.Project.Name.Infrastructure/Services/Deeply/Nested/Folder/SomeQuiteLongServiceName.cs';

  beforeAll(() => {
    repo = makeRepo({ featureFiles: { [long]: 'class A {}\n' } });
  });

  afterAll(() => repo.cleanup());

  it('lists the whole path, and the file list read from it matches', () => {
    const ctx = buildDiff({ repo: repo.dir, base: 'base', head: 'feature' });

    expect(ctx.stat).toContain(long);
    expect(ctx.stat).not.toContain('.../');
    expect(classifyDiffFiles(ctx).files).toEqual([long]);
  });
});
