// How big, how branchy, how deep is a function — and does it carry logic?
//
// Four plain numbers per function: lines, parameters, maximum nesting and
// cyclomatic complexity. They are triggers, not verdicts: a long function is a
// question for a reviewer, and a repository whose own linter already enforces
// one of these limits answers it there instead.
//
// `isLogicBearing` is the one that gates something. A function with logic —
// branches, a loop, a calculation, a date, a regular expression, a parse —
// is expected to have a test; a DTO, a getter, a one-line mapper or a call
// handed straight to another service is not. Regular expressions over the
// source, no parser: what they miss makes a function look simpler, so the
// mistake costs a missing question, never an invented one.

import { stripCode } from './body.mjs';
import { normalizeSignature } from './signature.mjs';

/** Keywords that open a block counted as nesting when followed by `{`. */
const CONTROL = new Set(['if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'using', 'lock']);

/** Each adds one path through the function. `else if` counts through its `if`. */
const BRANCH_KEYWORDS = /\b(?:if|case|catch|for|foreach|while)\b/g;

/** `&&`, `||` and `??`, compound assignments included. */
const BRANCH_OPERATORS = /&&|\|\||\?\?/g;

/**
 * A ternary `?`: whitespace on both sides. That keeps out `?.`, `??`, the
 * optional `x?: T` of TypeScript and the nullable `int? x` of C#, none of
 * which put a space before the `?`.
 */
const TERNARY = /(?<=\s)\?(?=\s)/g;

const LOOP = /\b(?:for|foreach|while|do)\b|\.(?:forEach|ForEach|reduce|reduceRight|Aggregate)\s*\(/;

/** Date and time handling, in the libraries teams actually use. */
const DATE_OPS = new RegExp(
  [
    String.raw`\bnew\s+Date\b`,
    String.raw`\bDate\s*\.\s*(?:now|parse|UTC)\b`,
    String.raw`\b(?:DateTime|DateTimeOffset|DateOnly|TimeOnly|TimeSpan|TimeZoneInfo)\b`,
    String.raw`\b(?:moment|dayjs)\s*[.(]`,
    String.raw`\.(?:toISOString|getTime|getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|getUTC\w+|setDate|setMonth|setFullYear|setHours|setMinutes|toLocaleDateString|toLocaleTimeString|toDateString|getTimezoneOffset)\s*\(`,
    String.raw`\.(?:AddDays|AddMonths|AddYears|AddHours|AddMinutes|AddSeconds|ToUniversalTime|ToLocalTime)\s*\(`,
    String.raw`\b(?:differenceIn\w+|addDays|subDays|addMonths|startOf\w*|endOf\w*|isBefore|isAfter|parseISO|formatISO)\s*\(`,
  ].join('|'),
);

const REGEX_OPS = /\b(?:RegExp|Regex)\b|__regex__|\.(?:test|exec|matchAll)\s*\(/;

const MATH_OPS = /\bMathF?\s*\.|\b[Dd]ecimal\s*\.\s*(?:Round|Floor|Ceiling|Truncate)\b/;

const CURRENCY_OPS = /\bIntl\s*\.|\bNumberFormat\b|\bCultureInfo\b|\.(?:toFixed|toPrecision|toLocaleString)\s*\(|\bcurrency\b/;

const PARSE_OPS =
  /\b(?:parseInt|parseFloat)\s*\(|\bJSON\s*\.\s*parse\b|\bNumber\s*\(|\.(?:Parse|TryParse|ParseExact|TryParseExact)\s*\(|\bConvert\s*\.\s*To\w+\s*\(|\.parse\s*\(/;

/**
 * Arithmetic: a binary operator whose left side is an operand. A number on the
 * left (`60 * 1000`) is a constant, a string on either side is concatenation;
 * both are left out. Compound assignment (`total += x`) counts.
 */
const ARITHMETIC =
  /(?<![\w$.])([A-Za-z_$][\w$.]*|[)\]])\s*([+\-*/%])(?![+\-=>*/])\s*(?=[A-Za-z_$(\d])|(?<![\w$.])([A-Za-z_$][\w$.]*)\s*[+\-*/%]=(?!=)/g;

/** Words that can precede `-1` without being an operand. */
const NOT_OPERANDS = new Set(['return', 'case', 'typeof', 'await', 'yield', 'in', 'of', 'new', 'throw', 'else', 'do', 'void', 'delete']);

/** Accessor syntax: `get total()`. */
const GETTER = /^\s*(?:(?:public|private|protected|static|override|readonly)\s+)*get\s+[A-Za-z_$][\w$]*\s*\(/;

const MAPPER_NAME = /^(?:map|to|from)[A-Z_]|^(?:Map|To|From)[A-Z]|Mapper$|Mapping$/;

/**
 * Where data-transfer shapes live. A name alone is not enough: `validateRequest`
 * ends like a DTO and carries logic, while `toDto` is a mapper and is judged as one.
 */
const DTO_PATH = /(^|\/)(dtos?|DTOs?|contracts\/(requests|responses))\/|(Dto|DTO|ViewModel)\.cs$|\.dto\.[a-z]+$/;

const MIGRATION_PATH = /(^|\/)migrations?\/|ModelSnapshot\.cs$|(^|\/)migrations?[^/]*\.(cs|php|ts|js)$/i;

const DI_REGISTRATION = /\.(?:AddScoped|AddTransient|AddSingleton|AddDbContext\w*|AddHttpClient|TryAdd\w+)\s*[<(]/;

/** Kinds that carry behaviour of their own. Classes carry it through their methods. */
const BEHAVIOUR_KINDS = new Set(['function', 'method']);

/**
 * Where the body proper starts: past the parameter list, at its `{` or `=>`.
 * Measures that should not see the declaration (`DateTime d` as a parameter
 * type is not a date operation) start here.
 */
function bodyStart(code) {
  const open = code.indexOf('(');
  if (open === -1) {
    const arrow = code.indexOf('=>');
    return arrow === -1 ? 0 : arrow + 2;
  }

  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return 0;

  for (let i = close + 1; i < code.length; i += 1) {
    if (code[i] === '{') return i;
    if (code[i] === '=' && code[i + 1] === '>') return i + 2;
  }
  return close + 1;
}

/** Parameters from the signature, or from the body's declaration when it has none. */
function paramCount(signature, code) {
  const fromSignature = normalizeSignature(signature ?? '').arity;
  if (fromSignature !== null) return fromSignature;

  const declared = normalizeSignature(code.slice(0, bodyStart(code))).arity;
  return declared ?? 0;
}

/** Deepest stack of control blocks. A nested function's own block is not one. */
function maxNesting(code) {
  let pending = null; // paren depth at which a control keyword is waiting for its `{`
  let parens = 0;
  let deepest = 0;
  const stack = [];
  let controlDepth = 0;

  for (const [token] of code.matchAll(/[A-Za-z_$][\w$]*|=>|[(){};]/g)) {
    if (token === '(') parens += 1;
    else if (token === ')') parens = Math.max(0, parens - 1);
    else if (token === '{') {
      const isControl = pending !== null && pending === parens;
      stack.push(isControl);
      if (isControl) controlDepth += 1;
      deepest = Math.max(deepest, controlDepth);
      pending = null;
    } else if (token === '}') {
      if (stack.pop()) controlDepth -= 1;
    } else if (token === ';' || token === '=>' || token === 'function') {
      if (pending === parens) pending = null;
    } else if (CONTROL.has(token)) {
      pending = parens;
    }
  }

  return deepest;
}

function countMatches(text, pattern) {
  let count = 0;
  for (const _ of text.matchAll(pattern)) count += 1;
  return count;
}

function hasArithmetic(code) {
  for (const match of code.matchAll(ARITHMETIC)) {
    if (NOT_OPERANDS.has(match[1] ?? match[3])) continue;
    return true;
  }
  return false;
}

/** A symbol given as an object, or a bare body string. */
function asSymbol(input) {
  return typeof input === 'string' ? { body: input, signature: '', kind: 'function', name: '' } : input ?? {};
}

/**
 * Size and shape of one function.
 *
 * @param {object|string} input a symbol `{body, signature}` or a body
 * @returns {{lines: number, params: number, nesting: number, cyclomatic: number}}
 */
export function computeMetrics(input) {
  const symbol = asSymbol(input);
  const { code } = stripCode(symbol.body ?? '');
  const inner = code.slice(bodyStart(code));

  const lines = code.split('\n').filter((line) => line.trim() !== '').length;
  const cyclomatic =
    1 +
    countMatches(inner, BRANCH_KEYWORDS) +
    countMatches(inner, BRANCH_OPERATORS) +
    countMatches(inner, TERNARY);

  return {
    lines,
    params: paramCount(symbol.signature, code),
    nesting: maxNesting(inner),
    cyclomatic,
  };
}

/**
 * Why a function does or does not carry logic.
 *
 * @param {object|string} input
 * @returns {{
 *   logicBearing: boolean,
 *   reasons: string[],
 *   exempt: string|null,
 *   metrics: {lines: number, params: number, nesting: number, cyclomatic: number}
 * }}
 */
export function logicProfile(input) {
  const symbol = asSymbol(input);
  const metrics = computeMetrics(symbol);
  const name = String(symbol.name ?? '');
  const body = String(symbol.body ?? '');

  const verdict = (exempt) => ({ logicBearing: false, reasons: [], exempt, metrics });

  // Shapes that never need a unit test of their own.
  if (symbol.kind && !BEHAVIOUR_KINDS.has(symbol.kind)) return verdict(`kind:${symbol.kind}`);
  if (MIGRATION_PATH.test(String(symbol.path ?? ''))) return verdict('migration');
  if (DTO_PATH.test(String(symbol.path ?? ''))) return verdict('dto');

  const { code, regexLiterals } = stripCode(body);
  const inner = code.slice(bodyStart(code));

  if (DI_REGISTRATION.test(inner) && metrics.cyclomatic <= 2) return verdict('di-registration');

  const loop = LOOP.test(inner);
  const flat = metrics.cyclomatic === 1 && !loop;
  if (flat && GETTER.test(symbol.signature || body.split('\n')[0] || '')) return verdict('getter');
  if (flat && MAPPER_NAME.test(name)) return verdict('mapper');

  const reasons = [];
  if (metrics.cyclomatic >= 2) reasons.push('branches');
  if (loop) reasons.push('loop');
  if (hasArithmetic(inner)) reasons.push('arithmetic');
  if (DATE_OPS.test(inner)) reasons.push('date');
  if (regexLiterals > 0 || REGEX_OPS.test(inner)) reasons.push('regex');
  if (MATH_OPS.test(inner)) reasons.push('math');
  if (CURRENCY_OPS.test(inner)) reasons.push('currency');
  if (PARSE_OPS.test(inner)) reasons.push('parse');

  // Pure delegation — one call handed to another service — lands here with no
  // reason at all, which is the right answer for it.
  return { logicBearing: reasons.length > 0, reasons, exempt: null, metrics };
}

/**
 * Does this function carry logic a test should pin?
 *
 * Cyclomatic complexity of 2 or more, a loop, arithmetic, or a date, regular
 * expression, math, currency or parse operation. Exempt whatever the body
 * says: DTOs, records, interfaces, enums, migrations and DI registration;
 * exempt when flat (no branch, no loop): getters and mappers. Pure delegation
 * is exempt because it matches none of the above.
 *
 * @param {object|string} input a symbol `{name, kind, path, signature, body}` or a body
 */
export function isLogicBearing(input) {
  return logicProfile(input).logicBearing;
}
