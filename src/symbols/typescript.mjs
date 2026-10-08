// TypeScript and JavaScript symbols, found with regular expressions.
//
// Same trade as the C# extractor: no parser, no dependency, and what the
// patterns miss produces fewer findings rather than wrong ones.
//
// Every function-like declaration is collected, with a `scope` that says who
// can reach it:
//
//   exported   `export function`, `export const x = () =>`, `export { x }`
//   module     a top-level function or arrow nobody exports
//   public / protected / private   a class member, by its modifier
//   member     a method of an object literal
//   inner      a function declared inside another one — the helpers a `use*`
//              composable or a component keeps to itself
//
// `exported` stays true only for the first scope. The tests check reads only
// those: a module-private helper is an implementation detail, and demanding a
// test for it pushes people to pin down things they should stay free to rename.
// The duplication check reads them all, because a copied private helper is a
// copy all the same.

import { MAX_NAME_CHARS } from './limits.mjs';
import { bodyEnd, braceDepths, closingIndex, maskSource } from './scan.mjs';

const ID = '[A-Za-z_$][\\w$]*';

/** `export function foo(`, `export async function foo(` */
const EXPORT_FUNCTION = new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})\\s*[(<]`);

/** `export class Foo`, `export abstract class Foo` */
const EXPORT_CLASS = new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+(${ID})`);

/** `export interface Foo`, `export type Foo =` */
const EXPORT_INTERFACE = new RegExp(`^\\s*export\\s+(?:interface|type)\\s+(${ID})`);

/** `export enum Foo` */
const EXPORT_ENUM = new RegExp(`^\\s*export\\s+(?:const\\s+)?enum\\s+(${ID})`);

/** `export const foo =` — behaviour only when what follows is a function. */
const EXPORT_BINDING = new RegExp(`^\\s*export\\s+(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*`);

/** `function foo(` with no `export`. */
const LOCAL_FUNCTION = new RegExp(`^\\s*(?:async\\s+)?function\\s*\\*?\\s*(${ID})\\s*[(<]`);

/** `class Foo` with no `export`. */
const LOCAL_CLASS = new RegExp(`^\\s*(?:abstract\\s+)?class\\s+(${ID})`);

/** `const foo =` with no `export`. */
const LOCAL_BINDING = new RegExp(`^\\s*(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*`);

/** `defineStore(…)` and friends: what they return is the composable. */
const FACTORY = /^(?:defineStore|defineComponent|createStore)\s*\(/;

/** A method declared in a class body: `async load(id) {`, `private static parse<T>(raw) {` */
const CLASS_METHOD = new RegExp(
  `^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*((?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set|accessor)\\s+)*)\\*?\\s*(#?${ID})\\s*[?!]?\\s*(?:<[^>]*>)?\\s*\\(`,
);

/** A function-valued field in a class body: `private onClick = (e) => {` */
const CLASS_FIELD = new RegExp(
  `^\\s*((?:(?:public|private|protected|static|readonly|override|declare)\\s+)*)(#?${ID})\\s*[?!]?\\s*(?::[^=]+)?=\\s*`,
);

/** A method of an object literal: `format(value) {`, `async load() {`, `get total() {` */
const OBJECT_METHOD = new RegExp(`^\\s*(?:(?:async|get|set)\\s+)?\\*?\\s*(${ID})\\s*(?:<[^>]*>)?\\s*\\(`);

/** A function-valued key of an object literal: `format: (value) =>`, `load: async function () {` */
const OBJECT_KEY = new RegExp(`^\\s*(${ID})\\s*:\\s*`);

/** `export { a, b as c }` with no `from`: a list that exports local declarations. */
const EXPORT_LIST = /^\s*export\s*\{/;

/** `export default foo` naming a local declaration. */
const EXPORT_DEFAULT_NAME = new RegExp(`^\\s*export\\s+default\\s+(${ID})\\s*;?\\s*$`);

/** Words that look like a call in the shapes above and never name a declaration. */
const NOT_A_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'super', 'new', 'constructor',
  'typeof', 'await', 'yield', 'throw', 'delete', 'void', 'else', 'do', 'with', 'import', 'export',
]);

/** How many lines a declaration head may wrap across before it is given up on. */
const MAX_HEAD_LINES = 20;

/** Ceiling on the text a head is read from, whatever the line count. */
const MAX_HEAD_CHARS = 4000;

/**
 * @param {Array<{line: number, text: string}>} lines
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean,
 *   scope: string, container: string|null, span: [number, number]}>}
 */
export function extract(lines) {
  // A CRLF file leaves `\r` on every line, and `.` does not match it: every
  // pattern anchored on `$` would fail on a Windows checkout.
  const texts = lines.map((entry) => String(entry.text ?? '').replace(/\r$/, ''));
  const masked = maskSource(texts, { regex: true });
  const depths = braceDepths(masked);

  const out = [];
  const containers = [];
  const exportedNames = new Set();

  const lineAt = (index) => lines[Math.min(index, lines.length - 1)]?.line ?? 0;

  for (let i = 0; i < masked.length; i += 1) {
    while (containers.length && containers[containers.length - 1].end < i) containers.pop();

    const code = masked[i];
    if (!code.trim()) continue;

    const container = containers[containers.length - 1] ?? null;

    if (EXPORT_LIST.test(code)) {
      const list = exportListText(masked, i);
      // `export { a } from './x'` re-exports someone else's declaration.
      if (!/\}\s*from\b/.test(list)) {
        for (const name of exportListNames(list)) exportedNames.add(name);
      }
      continue;
    }

    const exportDefault = code.match(EXPORT_DEFAULT_NAME);
    if (exportDefault && !NOT_A_NAME.has(exportDefault[1])) {
      exportedNames.add(exportDefault[1]);
      continue;
    }

    const found = declarationAt(masked, i, container, depths);

    if (found) {
      const end = bodyEnd(masked, i, { raw: texts });
      const symbol = {
        name: found.name.replace(/^#/, '').slice(0, MAX_NAME_CHARS),
        kind: found.kind,
        line: lines[i].line,
        signature: signatureAt(texts, masked, i),
        exported: found.scope === 'exported',
        scope: found.scope,
        container: found.container ?? null,
        span: [lines[i].line, lineAt(end)],
      };
      out.push(symbol);

      if (found.kind === 'class') {
        containers.push({ kind: 'class', path: containerPath(container, symbol.name), end, bodyDepth: depths[i] + 1 });
      } else if (found.kind === 'function' || found.kind === 'method') {
        // A factory handed an options object (`defineStore('x', {`) holds its
        // behaviour as object members; one handed a setup function holds it as
        // inner functions. The open brace at the end of the line says which.
        const objectBody = found.factory && /[(,]\s*\{\s*$/.test(code);
        containers.push({
          kind: objectBody ? 'object' : 'function',
          path: containerPath(container, symbol.name),
          end,
          bodyDepth: depths[i] + 1,
        });
      }
      continue;
    }

    const object = objectOpenerAt(code, container);
    if (object) {
      const end = bodyEnd(masked, i, { raw: texts });
      if (end > i) {
        containers.push({
          kind: 'object',
          path: object.name ? containerPath(container, object.name) : (container?.path ?? null),
          end,
          bodyDepth: depths[i] + 1,
        });
      }
    }
  }

  // `export { a }` and `export default a` can come after the declaration, so
  // they are applied once everything has been read. Only top-level
  // declarations can be exported by name.
  if (exportedNames.size) {
    for (const symbol of out) {
      if (symbol.scope === 'module' && exportedNames.has(symbol.name)) {
        symbol.exported = true;
        symbol.scope = 'exported';
      }
    }
  }

  return out;
}

function containerPath(parent, name) {
  if (!name) return parent?.path ?? null;
  return parent?.path ? `${parent.path}.${name}` : name;
}

/**
 * The declaration that starts on line `i`, or null.
 *
 * Exported shapes are recognised wherever they appear — `export` is only legal
 * at the top level, and reading only the added lines of a diff gives no
 * reliable nesting. The other shapes depend on what the line sits inside.
 */
function declarationAt(masked, i, container, depths) {
  const code = masked[i];

  if (/^\s*export\b/.test(code)) return exportedDeclaration(masked, i, code);

  if (!container) {
    // Nested in something that is not a declaration — a callback, an `if` at
    // module level — is still nested: nobody outside can call it.
    return localDeclaration(masked, i, code, depths[i] > 0 ? 'inner' : 'module', null);
  }

  if (container.kind === 'class') {
    if (depths[i] !== container.bodyDepth) return null;
    return classMember(masked, i, code, container);
  }

  if (container.kind === 'object') {
    if (depths[i] !== container.bodyDepth) return null;
    return objectMember(masked, i, code, container);
  }

  // Inside a function: a helper of its own.
  return localDeclaration(masked, i, code, 'inner', container.path);
}

function exportedDeclaration(masked, i, code) {
  let match = code.match(EXPORT_FUNCTION);
  if (match) return { name: match[1], kind: 'function', scope: 'exported' };

  match = code.match(EXPORT_CLASS);
  if (match) return { name: match[1], kind: 'class', scope: 'exported' };

  match = code.match(EXPORT_INTERFACE);
  if (match) return { name: match[1], kind: 'interface', scope: 'exported' };

  match = code.match(EXPORT_ENUM);
  if (match) return { name: match[1], kind: 'enum', scope: 'exported' };

  match = code.match(EXPORT_BINDING);
  if (match) {
    const value = valueKind(headText(masked, i), match[0].length);
    if (value) return { name: match[1], kind: 'function', scope: 'exported', factory: value === 'factory' };
  }

  return null;
}

function localDeclaration(masked, i, code, scope, container) {
  let match = code.match(LOCAL_FUNCTION);
  if (match) return { name: match[1], kind: 'function', scope, container };

  match = code.match(LOCAL_CLASS);
  if (match) return { name: match[1], kind: 'class', scope, container };

  match = code.match(LOCAL_BINDING);
  if (match) {
    const value = valueKind(headText(masked, i), match[0].length);
    if (value) return { name: match[1], kind: 'function', scope, container, factory: value === 'factory' };
  }

  return null;
}

function classMember(masked, i, code, container) {
  const field = code.match(CLASS_FIELD);
  if (field && !NOT_A_NAME.has(field[2])) {
    const value = valueKind(headText(masked, i), field[0].length);
    if (value === 'function') {
      return { name: field[2], kind: 'method', scope: memberScope(field[1], field[2]), container: container.path };
    }
  }

  const method = code.match(CLASS_METHOD);
  if (!method || NOT_A_NAME.has(method[2])) return null;
  if (!opensBody(headText(masked, i), method[0].length - 1)) return null;

  return { name: method[2], kind: 'method', scope: memberScope(method[1], method[2]), container: container.path };
}

function memberScope(modifiers, name) {
  if (/\bprivate\b/.test(modifiers) || name.startsWith('#')) return 'private';
  if (/\bprotected\b/.test(modifiers)) return 'protected';
  return 'public';
}

function objectMember(masked, i, code, container) {
  const key = code.match(OBJECT_KEY);
  if (key && !NOT_A_NAME.has(key[1])) {
    const value = valueKind(headText(masked, i), key[0].length);
    if (value === 'function') return { name: key[1], kind: 'method', scope: 'member', container: container.path };
    return null;
  }

  const method = code.match(OBJECT_METHOD);
  if (!method || NOT_A_NAME.has(method[1])) return null;
  if (!opensBody(headText(masked, i), method[0].length - 1)) return null;

  return { name: method[1], kind: 'method', scope: 'member', container: container.path };
}

/**
 * Does the parameter list opening at `open` close and then open a body?
 *
 * This is what tells a method (`format(value) {`) from a call that happens to
 * start a line (`compute(value),`) inside an object literal or a class.
 */
function opensBody(text, open) {
  if (text[open] !== '(') return false;
  const after = closingIndex(text, open);
  if (after === -1) return false;
  const rest = text.slice(after).replace(/^\s+/, '');
  if (rest.startsWith('{')) return true;
  // A return type annotation between the list and the body.
  return rest.startsWith(':') && afterReturnType(rest.slice(1)) === '{';
}

/** After a parameter list: an optional return type, then `=>`. */
function arrowFollows(rest) {
  const trimmed = rest.replace(/^\s+/, '');
  if (trimmed.startsWith('=>')) return true;
  return trimmed.startsWith(':') && afterReturnType(trimmed.slice(1)) === '=>';
}

/**
 * Skip a return type annotation and say what follows it: `{`, `=>`, or null
 * when a statement ends first.
 *
 * The type is read as brackets — `Promise<Map<string, number>>`, `{ a: number }`.
 * A `{` before any type has been read opens an object type, and so does one
 * that continues a type: after `&`, `|`, `,`, `?`, `:` or a type operator
 * (`r is Row & { data: T }`, `A | { empty: true }`). Any other `{` at depth 0
 * after a type is the body.
 */
function afterReturnType(text) {
  let depth = 0;
  let sawType = false;

  for (let k = 0; k < text.length; k += 1) {
    const c = text[k];

    if (c === '=' && text[k + 1] === '>') {
      if (depth === 0 && sawType) return '=>';
      k += 1;
      continue;
    }

    if (c === '{' && depth === 0 && sawType && !continuesType(text.slice(0, k))) return '{';

    if (c === '(' || c === '[' || c === '<' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '>' || c === '}') depth -= 1;
    else if ((c === ';' || c === '=') && depth <= 0) return null;

    if (depth < 0) return null;
    if (!/\s/.test(c)) sawType = true;
  }

  return null;
}

/** Does a type annotation read so far still expect an operand, so a `{` here is an object type? */
function continuesType(before) {
  const tail = before.trimEnd();
  if (/[&|,?:]$/.test(tail)) return true;
  return /(?:^|[^\w$])(?:is|keyof|typeof|readonly|extends|infer|asserts)$/.test(tail);
}

/**
 * What a binding is initialised with, read from `at` in `text`.
 *
 * @returns {'function'|'factory'|null}
 */
function valueKind(text, at) {
  const value = text.slice(at).replace(/^\s+/, '');

  if (/^(?:async\s+)?function\b/.test(value)) return 'function';
  if (new RegExp(`^(?:async\\s+)?${ID}\\s*=>`).test(value)) return 'function';
  if (FACTORY.test(value)) return 'factory';

  const params = value.match(/^(?:async\s*)?(?:<[^>]*>\s*)?\(/);
  if (!params) return null;

  const open = params[0].length - 1;
  const after = closingIndex(value, open);
  if (after === -1) return null;

  return arrowFollows(value.slice(after)) ? 'function' : null;
}

/**
 * The masked text of a declaration head: line `i` and the lines it wraps onto.
 *
 * A parameter list written one parameter per line is why this exists. It joins
 * forward until the brackets opened on line `i` are closed and something
 * follows them, within a line and character budget.
 */
function headText(masked, i) {
  let text = masked[i];
  // Braces count too: a return type written as an object literal
  // (`(): {` … `} => {`) puts the arrow lines below the declaration.
  let depth = bracketDelta(masked[i], true);
  let k = i + 1;

  while (k < masked.length && k - i < MAX_HEAD_LINES && text.length < MAX_HEAD_CHARS) {
    const tail = text.trimEnd();
    // Brackets closed and the line does not end mid-expression.
    const settled = depth <= 0 && !/(?:=>|[=:(,|&?])$/.test(tail);
    if (settled) break;
    text += `\n${masked[k]}`;
    depth += bracketDelta(masked[k], true);
    k += 1;
  }

  return text.slice(0, MAX_HEAD_CHARS);
}

function bracketDelta(line, braces = false) {
  let delta = 0;
  for (const c of line) {
    if (c === '(' || c === '[' || (braces && c === '{')) delta += 1;
    else if (c === ')' || c === ']' || (braces && c === '}')) delta -= 1;
  }
  return delta;
}

/**
 * The declaration as written, for the signature signal.
 *
 * One line when the parameter list closes on it, which is what every
 * declaration that fits on a line has always been stored as. A list wrapped
 * across lines is joined up to the line that closes it, so the arity the
 * signature signal reads is the real one.
 */
function signatureAt(texts, masked, i) {
  const first = texts[i].trim();
  let depth = bracketDelta(masked[i]);
  if (depth <= 0) return first.slice(0, 200);

  const parts = [first];
  for (let k = i + 1; k < texts.length && k - i < MAX_HEAD_LINES && depth > 0; k += 1) {
    parts.push(texts[k].trim());
    depth += bracketDelta(masked[k]);
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 200);
}

/** An `export { … }` list, joined across the lines it wraps onto. */
function exportListText(masked, i) {
  let text = masked[i];
  for (let k = i + 1; k < masked.length && k - i < MAX_HEAD_LINES && !text.includes('}'); k += 1) {
    text += `\n${masked[k]}`;
  }
  // The `from` of a re-export can sit on the line that closes the list.
  return text;
}

/** `export { a, b as c }` → ['a', 'b'] */
function exportListNames(text) {
  const open = text.indexOf('{');
  const close = text.indexOf('}', open);
  if (open === -1 || close === -1) return [];

  return text
    .slice(open + 1, close)
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter((name) => new RegExp(`^${ID}$`).test(name));
}

/**
 * An object literal opened at the end of this line, and the name it is bound to.
 *
 * `const api = {`, `methods: {`, `export default {`, `export default
 * defineComponent({`, `return {`. Only these shapes: a brace after `)` or `=>`
 * is a block, and treating a block as an object would read its statements as
 * members.
 */
function objectOpenerAt(code, container) {
  const trimmed = code.trimEnd();
  if (!trimmed.endsWith('{')) return null;

  const before = trimmed.slice(0, -1).trimEnd();
  const opensObject = /(?:[=:(,[?]|\breturn|\bdefault)$/.test(before) && !/=>$/.test(before);
  if (!opensObject) return null;

  // Inside a function body only a returned object is worth reading as a set of
  // members: `return { format(v) { … } }` is how a composable hands them out.
  if (container?.kind === 'function' && !/^\s*return\b/.test(code)) {
    const binding = code.match(LOCAL_BINDING);
    if (!binding) return null;
    return { name: binding[1] };
  }

  let match = code.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (match) return { name: match[1] };

  match = code.match(new RegExp(`^\\s*(${ID})\\s*:`));
  if (match) return { name: match[1] };

  if (/^\s*export\s+default\b/.test(code)) return { name: 'default' };

  return { name: null };
}
