// C# symbols, found with regular expressions.
//
// A real parser would be more accurate and would drag native binaries or wasm
// into a bundle that runs in other teams' CI. What these patterns miss produces
// FEWER findings, never false ones, and that is the right side to fail on: a
// missed symbol costs one observation, a hallucinated one costs the reader's
// trust in every other observation.
//
// Every method is collected, whatever its access, with a `scope`:
//
//   public / protected / internal / private   by its modifiers; a member with
//                                             none is private, as C# says
//   local                                     a local function inside a method
//
// `exported` stays true only for `public`, as it always was: the tests check
// asks for tests on what other code can call. The duplication check reads every
// scope, because a private helper copied into a second service is a copy all
// the same. Constructors stay out — they have no return type, so the method
// shape never matches them, and they are not a unit anybody reuses.

import { MAX_NAME_CHARS } from './limits.mjs';
import { bodyEnd, maskSource } from './scan.mjs';

const ACCESS = '(?:public|internal|protected|private|file)';

/** Type declarations: class, record, interface, struct, enum. */
const TYPE = new RegExp(
  `^\\s*(?:\\[[^\\]]*\\]\\s*)*((?:${ACCESS}\\s+){0,2})(?:(?:abstract|sealed|static|partial|readonly|ref|unsafe|new)\\s+)*(record(?:\\s+(?:struct|class))?|class|interface|struct|enum)\\s+([A-Za-z_]\\w*)`,
);

/**
 * Method declarations: access, modifiers, a return type, a name, a parameter
 * list.
 *
 * The parameter list has to be there, and must not end in a `;` unless an
 * arrow comes first: without it this is a field, and `Foo Bar(x);` with a
 * semicolon is a call or an abstract member, neither of which has a body.
 */
const METHOD = new RegExp(
  `^\\s*(?:\\[[^\\]]*\\]\\s*)*((?:${ACCESS}\\s+){0,2})((?:(?:static|virtual|override|abstract|sealed|async|extern|new|partial|unsafe|readonly)\\s+)*)` +
    '([A-Za-z_][\\w<>,.\\[\\]?]*(?:<[^()]*>)?\\??)\\s+([A-Za-z_]\\w*)\\s*(<[^()]*>)?\\s*(\\((?:[^;]*|.*=>.*))?$',
);

/** `public string Name { get; set; }` is data, not behaviour worth a test. */
const PROPERTY = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:${ACCESS})\\b[^(;]*\\{\\s*get\\b`);

/**
 * Words that sit where a return type would and never are one.
 *
 * Without an access modifier the method shape is short enough that statements
 * inside a body fit it: `return Calculate(`, `await SendAsync(`, `else Retry(`.
 * A local function cannot start with any of these.
 */
const NOT_A_TYPE = new Set([
  'return', 'await', 'throw', 'yield', 'new', 'else', 'case', 'using', 'var', 'goto', 'in', 'is', 'as',
  'not', 'and', 'or', 'when', 'out', 'ref', 'params', 'checked', 'unchecked', 'lock', 'fixed',
  'where', 'select', 'from', 'orderby', 'group', 'join', 'let', 'into', 'on', 'equals', 'by',
  'ascending', 'descending', 'namespace', 'static', 'async', 'virtual', 'override', 'abstract',
  'sealed', 'extern', 'partial', 'unsafe', 'readonly', 'public', 'private', 'protected', 'internal',
  'delegate', 'event', 'operator', 'implicit', 'explicit', 'const', 'default', 'typeof', 'nameof', 'sizeof',
]);

/** Words that sit where a method name would and never are one. */
const NOT_A_NAME = new Set([
  'if', 'while', 'for', 'foreach', 'switch', 'catch', 'using', 'lock', 'fixed', 'return', 'nameof',
  'typeof', 'sizeof', 'default', 'when', 'new', 'operator', 'this', 'base', 'checked', 'unchecked',
]);

const KIND_FOR = { class: 'class', record: 'class', struct: 'class', interface: 'interface', enum: 'enum' };

/**
 * @param {Array<{line: number, text: string}>} lines
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean,
 *   scope: string, container: string|null, span: [number, number]}>}
 */
export function extract(lines) {
  // A CRLF file leaves `\r` on every line, and `.` does not match it: every
  // pattern anchored on `$` would fail on a Windows checkout.
  const texts = lines.map((entry) => String(entry.text ?? '').replace(/\r$/, ''));
  const masked = maskSource(texts, { regex: false, verbatim: true });
  const lineAt = (index) => lines[Math.min(index, lines.length - 1)]?.line ?? 0;

  const out = [];
  // Open declarations that can hold others: types hold members, methods hold
  // local functions.
  const containers = [];

  for (let i = 0; i < masked.length; i += 1) {
    while (containers.length && containers[containers.length - 1].end < i) containers.pop();

    const code = masked[i];
    if (!code.trim() || PROPERTY.test(code)) continue;

    let insideMethod = containers.some((frame) => frame.kind === 'method');

    // A declaration with an access modifier is never inside a method. When the
    // frames say otherwise they are wrong — a method whose body the diff did not
    // include never closes — and they are dropped rather than trusted.
    const type = code.match(TYPE);
    const method = type ? null : code.match(METHOD);
    const accessWritten = Boolean((type?.[1] ?? method?.[1] ?? '').trim());
    if (insideMethod && accessWritten) {
      while (containers.length && containers[containers.length - 1].kind === 'method') containers.pop();
      insideMethod = containers.some((frame) => frame.kind === 'method');
    }

    const enclosing = containers[containers.length - 1] ?? null;

    if (type && !insideMethod) {
      const end = bodyEnd(masked, i, { raw: texts });
      const name = type[3].slice(0, MAX_NAME_CHARS);
      const access = type[1];
      out.push({
        name,
        // `record struct Foo` and `record class Foo` are records.
        kind: KIND_FOR[type[2].split(/\s+/)[0]] ?? 'class',
        line: lines[i].line,
        signature: signatureAt(texts, masked, i),
        exported: /\bpublic\b/.test(access),
        scope: accessScope(access, 'internal'),
        container: enclosing?.path ?? null,
        span: [lines[i].line, lineAt(end)],
      });
      containers.push({ kind: 'type', path: enclosing?.path ? `${enclosing.path}.${name}` : name, end });
      continue;
    }

    // Group 6 is the parameter list. Without it this is a field declaration.
    if (!method || !method[6]) continue;

    const [, access, , returnType, rawName, generics = ''] = method;
    if (NOT_A_TYPE.has(returnType) || NOT_A_NAME.has(rawName)) continue;
    // A type is whole: its angle brackets balance and it does not end on a
    // separator. `_mapper.Map<List<A>, List<B>>(` fits the shape otherwise,
    // with `_mapper.Map<List<A>,` as the "type" and `List` as the "name".
    if (!wholeType(returnType) || !balanced(generics)) continue;

    // A local function has no access modifier. One that carries one is not
    // inside a method, whatever the brace count says — reading only the added
    // lines of a diff is enough to put the count off.
    const local = insideMethod && !access.trim();
    const end = bodyEnd(masked, i, { raw: texts });
    // An interface member or an abstract method whose parameter list wraps:
    // the first line fits the shape, and the `;` that says there is no body
    // comes lines later. Nothing to compare and nothing to test.
    if (bodiless(masked, i, end)) continue;
    const name = rawName.slice(0, MAX_NAME_CHARS);
    const owner = local ? containers.filter((frame) => frame.kind === 'method').pop() : enclosing;

    out.push({
      name,
      kind: 'method',
      line: lines[i].line,
      signature: signatureAt(texts, masked, i),
      exported: /\bpublic\b/.test(access),
      scope: local ? 'local' : accessScope(access, 'private'),
      container: owner?.path ?? null,
      span: [lines[i].line, lineAt(end)],
    });
    containers.push({ kind: 'method', path: owner?.path ? `${owner.path}.${name}` : name, end });
  }

  return out;
}

/**
 * A `;` right after the parameter list closes, on the same line: a declaration
 * with no body.
 *
 * Only that line is read. Looking further would reach whatever comes next, and
 * when only the added lines of a diff are read, what comes next is unrelated
 * code whose `;` says nothing about this declaration.
 */
function bodiless(masked, start, end) {
  let depth = 0;
  let opened = false;
  for (let i = start; i <= end; i += 1) {
    const code = masked[i] ?? '';
    for (let k = 0; k < code.length; k += 1) {
      const c = code[k];
      if (c === '(') {
        depth += 1;
        opened = true;
      } else if (c === ')') {
        depth -= 1;
        if (opened && depth === 0) return /^[^{=]*;/.test(code.slice(k + 1));
      }
    }
  }
  return false;
}

function balanced(text) {
  let depth = 0;
  for (const c of text) {
    if (c === '<') depth += 1;
    else if (c === '>') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function wholeType(type) {
  return balanced(type) && !/[,.]$/.test(type);
}

/** How many lines a parameter list may wrap across and still be joined. */
const MAX_SIGNATURE_LINES = 20;

/**
 * The declaration as written: its line, plus the lines its parameter list
 * wraps onto, so the arity the signature signal reads is the real one.
 */
function signatureAt(texts, masked, i) {
  const first = texts[i].trim();
  let depth = parenDelta(masked[i]);
  if (depth <= 0) return first.slice(0, 200);

  const parts = [first];
  for (let k = i + 1; k < texts.length && k - i < MAX_SIGNATURE_LINES && depth > 0; k += 1) {
    parts.push(texts[k].trim());
    depth += parenDelta(masked[k]);
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 200);
}

function parenDelta(line) {
  let delta = 0;
  for (const c of line) {
    if (c === '(') delta += 1;
    else if (c === ')') delta -= 1;
  }
  return delta;
}

/**
 * The scope an access modifier list grants.
 *
 * `private protected` is narrower than protected and `protected internal`
 * wider than internal; each is reported as its narrower half, which is the
 * side that decides who could have reused it.
 */
function accessScope(access, fallback) {
  if (/\bpublic\b/.test(access)) return 'public';
  if (/\bprivate\b/.test(access)) return 'private';
  if (/\bprotected\b/.test(access)) return 'protected';
  if (/\binternal\b|\bfile\b/.test(access)) return 'internal';
  return fallback;
}
