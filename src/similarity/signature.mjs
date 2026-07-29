// Do two symbols take and give back the same things?
//
// Two functions with the same shape — same arity, same parameter types, same
// return type — are candidates for duplication in a way that two functions with
// different shapes are not. It is the cheapest of the three signals and the one
// that most often rules a pair OUT, which is what keeps model calls down.
//
// Types are compared as written. `IEnumerable<Order>` and `List<Order>` score as
// different, and that is the honest answer from a regex: guessing they are
// interchangeable would take a type system this deliberately does not carry.

/** Modifiers that say nothing about the shape of the call. */
const MODIFIERS =
  /\b(public|private|protected|internal|static|virtual|override|abstract|sealed|async|export|default|function|const|let|var|readonly|final|new|partial|unsafe|extern)\b/g;

/** Everything from the parameter list of a declaration, or '' when there is none. */
function paramText(signature) {
  const open = signature.indexOf('(');
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < signature.length; i += 1) {
    if (signature[i] === '(') depth += 1;
    else if (signature[i] === ')') {
      depth -= 1;
      if (depth === 0) return signature.slice(open + 1, i);
    }
  }

  // An unbalanced signature: the declaration wrapped across lines and the
  // extractor kept the first one. What we have is still usable.
  return signature.slice(open + 1);
}

/** Split a parameter list on top-level commas, so `Dictionary<a, b> x` stays one. */
function splitParams(text) {
  const parts = [];
  let depth = 0;
  let current = '';

  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') depth += 1;
    else if (char === '>' || char === ')' || char === ']') depth -= 1;

    if (char === ',' && depth <= 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * The comparable shape of a declaration.
 *
 * `arity` is null when the declaration has no parameter list at all — a class,
 * an interface, a constant. That is an absence of evidence, not a shape of
 * zero: treating it as "arity 0" made any two type declarations in the
 * repository score alike, purely because neither takes arguments.
 *
 * @param {string} signature
 * @returns {{arity: number|null, types: string[], returns: string}}
 */
export function normalizeSignature(signature) {
  const raw = String(signature || '')
    .replace(/\[[^\]]*\]/g, ' ') // attributes and decorators
    .replace(/=>.*$/, '')
    .replace(/\{.*$/, '')
    .replace(MODIFIERS, ' ')
    .trim();

  const params = paramText(raw);
  const before = params === null ? raw : raw.slice(0, raw.indexOf('('));

  const types = params === null ? [] : splitParams(params).map(paramType);

  // What comes before the name: a return type in C#, a `:` annotation in
  // TypeScript, nothing in plain JavaScript.
  const annotated = raw.match(/\)\s*:\s*([A-Za-z_][\w<>,.\[\]?| ]*)/);
  const leading = before.trim().split(/\s+/).filter(Boolean);
  const returns = annotated
    ? clean(annotated[1])
    : leading.length > 1
      ? clean(leading[leading.length - 2])
      : '';

  return { arity: params === null ? null : types.length, types, returns };
}

/** A single parameter reduced to its type, whichever side the language writes it on. */
function paramType(param) {
  const stripped = param.replace(/=.*$/, '').trim(); // default values

  const annotated = stripped.match(/:\s*(.+)$/); // TypeScript, PHP 8 promoted
  if (annotated) return clean(annotated[1]);

  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return clean(words[words.length - 2]); // C#, PHP: type then name

  return ''; // untyped JavaScript — no signal, not a mismatch
}

function clean(type) {
  return String(type).replace(/[?\s]/g, '').replace(/^\$/, '').toLowerCase();
}

/**
 * Shape similarity between two declarations, 0..1.
 *
 * Arity dominates: different arity is a different call site, whatever the types
 * say.
 */
export function signatureSimilarity(a, b) {
  const left = normalizeSignature(a);
  const right = normalizeSignature(b);

  // No parameter list on either side means there is no shape to compare. Zero
  // here says "this signal has nothing to add", and the other two decide.
  if (left.arity === null || right.arity === null) return 0;
  if (left.arity !== right.arity) return 0;

  let score = 0.4; // same arity is already a real signal

  if (left.arity > 0) {
    let matched = 0;
    for (let i = 0; i < left.arity; i += 1) {
      // An untyped parameter neither confirms nor denies. Counting it as a
      // mismatch would make every JavaScript pair score zero.
      if (!left.types[i] || !right.types[i]) matched += 0.5;
      else if (left.types[i] === right.types[i]) matched += 1;
    }
    score += 0.4 * (matched / left.arity);
  } else {
    score += 0.4;
  }

  if (left.returns && right.returns && left.returns === right.returns) score += 0.2;
  else if (!left.returns || !right.returns) score += 0.1;

  return Math.min(1, score);
}
