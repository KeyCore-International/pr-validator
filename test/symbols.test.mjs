import { describe, expect, it } from 'vitest';
import { extract as csharp } from '../src/symbols/csharp.mjs';
import { extract as typescript } from '../src/symbols/typescript.mjs';
import { extract as php } from '../src/symbols/php.mjs';
import { componentNameFromPath, extract as vue } from '../src/symbols/vue.mjs';
import { addedLinesByFile, extractorFor, symbolsFromDiff } from '../src/symbols/index.mjs';

/** Turn a source snippet into the shape the extractors consume. */
const lines = (src) => src.split('\n').map((text, i) => ({ line: i + 1, text }));
const names = (symbols) => symbols.map((s) => s.name);

describe('csharp symbols', () => {
  const found = csharp(
    lines(
      [
        'public class VacancyService',
        '    public async Task<Result> EvaluateAsync(int id)',
        '    public string Name { get; set; }',
        '    public int Total => a + b;',
        '    private void Hidden()',
        '    public record ScoreDto(int Value);',
        '    public interface IScorer',
        '    internal static void Helper(string x)',
      ].join('\n'),
    ),
  );

  it('finds types and methods', () => {
    expect(names(found)).toEqual([
      'VacancyService',
      'EvaluateAsync',
      'ScoreDto',
      'IScorer',
      'Helper',
    ]);
  });

  // Properties and expression-bodied members are data, not units a test targets.
  it('leaves properties out', () => {
    expect(names(found)).not.toContain('Name');
    expect(names(found)).not.toContain('Total');
  });

  it('marks non-public members as not exported', () => {
    expect(found.find((s) => s.name === 'Helper').exported).toBe(false);
    expect(found.find((s) => s.name === 'VacancyService').exported).toBe(true);
  });

  it('records the line the symbol was declared on', () => {
    expect(found.find((s) => s.name === 'EvaluateAsync').line).toBe(2);
  });
});

describe('typescript symbols', () => {
  const found = typescript(
    lines(
      [
        'export function buildScore(a: number): number {',
        'export async function fetchAll<T>(url: string) {',
        'export class ScoreService {',
        'export interface Scorer {',
        'export type Result = { a: number }',
        "export const useVacancies = defineStore('vac', () => {",
        'export const normalize = (raw: string): string =>',
        'export const MAX = 100;',
        'function privateHelper() {',
        'export default function App() {',
      ].join('\n'),
    ),
  );

  it('finds exported behaviour', () => {
    expect(names(found)).toEqual([
      'buildScore',
      'fetchAll',
      'ScoreService',
      'Scorer',
      'Result',
      'useVacancies',
      'normalize',
      'App',
    ]);
  });

  // A constant holding a value is data; the arrow is what makes it behaviour.
  it('leaves plain exported constants out', () => {
    expect(names(found)).not.toContain('MAX');
  });

  it('leaves module-private helpers out', () => {
    expect(names(found)).not.toContain('privateHelper');
  });
});

describe('php symbols', () => {
  const found = php(
    lines(
      [
        'final class OrderService',
        '    public function place(Order $o): void {',
        '    function helper() {',
        '    private function secret() {',
        '    public function __construct() {',
        'interface Payable',
        'enum Status: string',
      ].join('\n'),
    ),
  );

  // No visibility keyword means public in PHP — the opposite of C#, and the
  // easiest thing to get wrong.
  it('treats a method with no visibility keyword as public', () => {
    expect(found.find((s) => s.name === 'helper').exported).toBe(true);
  });

  it('leaves private methods and constructors out', () => {
    expect(names(found)).not.toContain('secret');
    expect(names(found)).not.toContain('__construct');
  });

  it('finds types', () => {
    expect(names(found)).toEqual(
      expect.arrayContaining(['OrderService', 'Payable', 'Status']),
    );
  });
});

describe('vue symbols', () => {
  it.each([
    ['src/components/VacancyCard.vue', 'VacancyCard'],
    ['src/components/vacancy-card.vue', 'VacancyCard'],
    ['vacancy_card.vue', 'VacancyCard'],
  ])('names the component after its file: %s', (path, expected) => {
    expect(componentNameFromPath(path)).toBe(expected);
  });

  it('reports the component once and delegates the script block', () => {
    const found = vue(
      [
        { line: 3, text: '<template>' },
        { line: 9, text: 'export function useCard() {' },
      ],
      'src/components/vacancy-card.vue',
    );

    expect(names(found)).toEqual(['VacancyCard', 'useCard']);
    expect(found[0].kind).toBe('component');
  });
});

describe('extractorFor', () => {
  it.each(['a.cs', 'a.ts', 'a.tsx', 'a.js', 'a.vue', 'a.php'])('supports %s', (path) => {
    expect(extractorFor(path)).toBeTypeOf('function');
  });

  // An unsupported language is an honest omission, not an error.
  it.each(['a.py', 'a.rb', 'a.md', 'Dockerfile'])('returns null for %s', (path) => {
    expect(extractorFor(path)).toBeNull();
  });
});

describe('addedLinesByFile', () => {
  const patch = [
    'diff --git a/Svc.cs b/Svc.cs',
    '--- a/Svc.cs',
    '+++ b/Svc.cs',
    '@@ -1,4 +1,6 @@',
    ' public class A',
    ' {',
    '-    public void Old() { }',
    '+    public void Nuevo() { }',
    '+    public void Otro() { }',
    ' }',
  ].join('\n');

  it('numbers added lines as they will appear in the new file', () => {
    const added = addedLinesByFile(patch).get('Svc.cs');

    expect(added).toHaveLength(2);
    expect(added[0].line).toBe(3);
    expect(added[1].line).toBe(4);
  });

  it('ignores removed lines when advancing the counter', () => {
    expect(addedLinesByFile(patch).get('Svc.cs')[0].text).toContain('Nuevo');
  });
});

describe('symbolsFromDiff', () => {
  const patch = [
    'diff --git a/Svc.cs b/Svc.cs',
    '--- a/Svc.cs',
    '+++ b/Svc.cs',
    '@@ -1,2 +1,4 @@',
    ' public class A',
    ' {',
    '+    public void Nuevo() { }',
    '+    private void Oculto() { }',
    'diff --git a/notes.md b/notes.md',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -0,0 +1 @@',
    '+# public class NoEsCodigo',
  ].join('\n');

  it('reports only exported symbols from supported languages', () => {
    expect(symbolsFromDiff(patch).map((s) => `${s.path}:${s.line} ${s.name}`)).toEqual([
      'Svc.cs:3 Nuevo',
    ]);
  });

  it('returns nothing for an empty diff', () => {
    expect(symbolsFromDiff('')).toEqual([]);
  });
});
