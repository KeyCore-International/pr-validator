import { describe, expect, it } from 'vitest';
import { classifyDiffFiles, filesFromStat, isCodeFile } from '../src/context/files.mjs';

const stat = (...lines) => [...lines, ` ${lines.length} files changed, 4 insertions(+)`].join('\n');

describe('filesFromStat', () => {
  it('reads the paths and drops the summary line', () => {
    expect(filesFromStat(stat(' README.md | 4 ++--', ' src/a.cs | 2 +-'))).toEqual([
      'README.md',
      'src/a.cs',
    ]);
  });

  // git compresses renames into `src/{old => new}.cs`; the file that exists
  // afterwards is the destination.
  it('resolves the rename form to the destination path', () => {
    expect(filesFromStat(' src/{old => new}/Service.cs | 2 +-\n 1 file changed')).toEqual([
      'src/new/Service.cs',
    ]);
  });

  it('handles binary entries', () => {
    expect(filesFromStat(' public/logo.png | Bin 0 -> 1234 bytes\n 1 file changed')).toEqual([
      'public/logo.png',
    ]);
  });

  it('returns nothing for an empty stat', () => {
    expect(filesFromStat('')).toEqual([]);
    expect(filesFromStat(undefined)).toEqual([]);
  });
});

describe('isCodeFile', () => {
  // Infrastructure and configuration count as code on purpose: that is where
  // embedded secrets and wrong permissions live, and treating them as prose
  // would leave the most dangerous files unreviewed.
  it.each([
    '.github/workflows/deploy.yml',
    'appsettings.json',
    'main.tf',
    'Dockerfile',
    'scripts/deploy.sh',
    'db/migration.sql',
    'package-lock.json',
    'src/a.cs',
    'src/App.vue',
  ])('treats %s as code', (path) => {
    expect(isCodeFile(path)).toBe(true);
  });

  it.each([
    'README.md',
    'docs/guia.md',
    'notes.txt',
    'public/logo.png',
    'assets/font.woff2',
    'LICENSE',
    '.gitignore',
  ])('treats %s as not code', (path) => {
    expect(isCodeFile(path)).toBe(false);
  });
});

describe('classifyDiffFiles', () => {
  it('reports no code for a documentation-only change', () => {
    const out = classifyDiffFiles({ stat: stat(' README.md | 4 ++--', ' docs/a.md | 2 +-') });

    expect(out.hasCode).toBe(false);
    expect(out.nonCode).toHaveLength(2);
  });

  it('reports code when a single code file is touched among prose', () => {
    const out = classifyDiffFiles({ stat: stat(' README.md | 2 +-', ' src/a.cs | 8 ++++') });

    expect(out.hasCode).toBe(true);
    expect(out.code).toEqual(['src/a.cs']);
  });

  it('reports code for an infrastructure-only change', () => {
    const out = classifyDiffFiles({ stat: stat(' .github/workflows/deploy.yml | 10 ++++') });

    expect(out.hasCode).toBe(true);
  });
});
