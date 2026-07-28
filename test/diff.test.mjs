import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDiff, DiffError, truncationNote } from '../src/context/diff.mjs';
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
