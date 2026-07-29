import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bodyLines, buildSymbolIndex, indexableFiles } from '../src/context/symbol-index.mjs';
import { isExcludedPath } from '../src/similarity/exclusions.mjs';
import { makeRepo } from './fixtures/repo.mjs';

let repo;
afterEach(() => repo?.cleanup());

const SERVICE = `namespace App;

public class OrderService
{
    public decimal CalculateTotal(Order order)
    {
        decimal total = 0;
        foreach (var line in order.Lines)
        {
            total += line.Price * line.Quantity;
        }
        return total;
    }
}
`;

describe('indexableFiles', () => {
  it('lists only files a symbol extractor can read', () => {
    repo = makeRepo({
      baseFiles: {
        'src/Service.cs': SERVICE,
        'src/app.ts': 'export function go() {}\n',
        'docs/guide.md': '# nada\n',
        'data/seed.sql': 'select 1;\n',
      },
    });

    const files = indexableFiles(repo.dir);

    expect(files).toEqual(expect.arrayContaining(['src/Service.cs', 'src/app.ts']));
    expect(files).not.toContain('docs/guide.md');
    expect(files).not.toContain('data/seed.sql');
  });

  it('returns nothing outside a git repository', () => {
    expect(indexableFiles('/definitely/not/a/repo')).toEqual([]);
  });
});

describe('bodyLines', () => {
  it('stops when the declaration braces close', () => {
    const lines = ['void A() {', '  x();', '}', 'void B() {', '  y();', '}'];

    expect(bodyLines(lines, 0)).toEqual(['void A() {', '  x();', '}']);
  });

  it('keeps only its own line for a declaration with no body', () => {
    const lines = ['interface Thing;', 'class Other {', '}'];

    expect(bodyLines(lines, 0)).toEqual(['interface Thing;']);
  });

  // The brace style most C# in these repositories is written in. Giving up at
  // the declaration line would leave every Allman-style method with an empty
  // body and nothing to compare.
  it('follows an opening brace on the next line', () => {
    const lines = ['public void A(Order o)', '{', '  x();', '}', 'public void B()'];

    expect(bodyLines(lines, 0)).toEqual(['public void A(Order o)', '{', '  x();', '}']);
  });

  it('stops at the line budget rather than reading a whole file', () => {
    const lines = ['void A() {', ...Array.from({ length: 200 }, () => '  x();'), '}'];

    expect(bodyLines(lines, 0, 10)).toHaveLength(10);
  });

  // A line budget bounds nothing on its own: one line can be as long as the
  // file it sits in, and everything that reads the body afterwards pays for it.
  it('stops at the character budget however long a single line is', () => {
    const lines = ['void A() {', 'x'.repeat(400_000), '}'];

    expect(bodyLines(lines, 0, 40, 100).join('').length).toBe(100);
  });

  it('bounds the window by default too', () => {
    const lines = ['void A() {', 'x'.repeat(400_000), '}'];

    expect(bodyLines(lines, 0).join('\n').length).toBeLessThan(20_000);
  });
});

describe('buildSymbolIndex', () => {
  it('indexes public symbols with their bodies', () => {
    repo = makeRepo({ baseFiles: { 'src/Service.cs': SERVICE } });

    const index = buildSymbolIndex({ repo: repo.dir });
    const total = index.symbols.find((s) => s.name === 'CalculateTotal');

    expect(total).toBeDefined();
    expect(total.path).toBe('src/Service.cs');
    expect(total.body).toContain('total += line.Price');
    expect(index.fileCount).toBe(1);
  });

  // The index feeds a "does this already exist?" question, and a private helper
  // is not something another part of the repository could have reused.
  it('leaves non-public symbols out', () => {
    repo = makeRepo({
      baseFiles: { 'src/A.cs': 'public class A {\n  private void Hidden() { }\n}\n' },
    });

    const names = buildSymbolIndex({ repo: repo.dir }).symbols.map((s) => s.name);

    expect(names).toContain('A');
    expect(names).not.toContain('Hidden');
  });

  it('honours the exclusion predicate', () => {
    repo = makeRepo({
      baseFiles: {
        'src/Service.cs': SERVICE,
        'src/Migrations/20240101_Init.cs': 'public class Init { public void Up() { } }\n',
      },
    });

    const paths = buildSymbolIndex({ repo: repo.dir, exclude: isExcludedPath }).symbols.map(
      (s) => s.path,
    );

    expect(paths).toContain('src/Service.cs');
    expect(paths).not.toContain('src/Migrations/20240101_Init.cs');
  });

  // The working tree is the pull request's head in CI, so the symbols the change
  // introduces have to be in the index for anything to be compared against.
  it('includes files that exist but are not committed', () => {
    repo = makeRepo({ baseFiles: { 'src/Service.cs': SERVICE } });
    writeUncommitted(repo.dir, 'src/Nuevo.cs', 'public class Nuevo { public void Ir() { } }\n');

    const names = buildSymbolIndex({ repo: repo.dir }).symbols.map((s) => s.name);

    expect(names).toContain('Nuevo');
  });
});

function writeUncommitted(dir, path, content) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}
