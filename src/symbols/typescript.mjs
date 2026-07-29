// Exported TypeScript and JavaScript symbols, found with regular expressions.
//
// Same trade as the C# extractor: no parser, no dependency, and what the
// patterns miss produces fewer findings rather than wrong ones.
//
// Only exported symbols are collected. A module-private helper is an
// implementation detail, and reporting it as untested would push people to
// write tests against things they are free to rename tomorrow.

const EXPORTED = /^\s*export\s+(?:default\s+)?/;

/** `export function foo(`, `export async function foo(` */
const FUNCTION = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/;

/** `export class Foo`, `export abstract class Foo` */
const CLASS = /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;

/** `export interface Foo`, `export type Foo =` */
const INTERFACE = /^\s*export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/;

/** `export enum Foo` */
const ENUM = /^\s*export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;

/**
 * `export const foo = (a) => …`, `export const foo = function …`
 *
 * Deliberately narrower than "any exported const": a constant holding a value
 * is data, and the arrow or `function` keyword is what makes it behaviour.
 */
const ARROW =
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/;

/** `export const useThing = defineStore(…)` and friends — composables/factories. */
const FACTORY_CALL =
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:defineStore|defineComponent|createStore)\s*\(/;

const PATTERNS = [
  [FUNCTION, 'function'],
  [CLASS, 'class'],
  [INTERFACE, 'interface'],
  [ENUM, 'enum'],
  [FACTORY_CALL, 'function'],
  [ARROW, 'function'],
];

/**
 * @param {Array<{line: number, text: string}>} lines
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean}>}
 */
export function extract(lines) {
  const out = [];

  for (const { line, text } of lines) {
    if (!EXPORTED.test(text)) continue;

    for (const [pattern, kind] of PATTERNS) {
      const match = text.match(pattern);
      if (!match) continue;

      const name = match[1] ?? match[2];
      if (!name) continue;

      out.push({ name, kind, line, signature: text.trim().slice(0, 200), exported: true });
      break;
    }
  }

  return out;
}
