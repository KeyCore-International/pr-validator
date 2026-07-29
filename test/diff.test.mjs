import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDiff, DiffError, isTooLargeError, truncationNote } from '../src/context/diff.mjs';
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
