// Public C# symbols, found with regular expressions.
//
// A real parser would be more accurate and would drag native binaries or wasm
// into a bundle that runs in other teams' CI. What these patterns miss produces
// FEWER findings, never false ones, and that is the right side to fail on: a
// missed symbol costs one observation, a hallucinated one costs the reader's
// trust in every other observation.

import { MAX_NAME_CHARS } from './limits.mjs';

/** Type declarations: class, record, interface, struct, enum. */
const TYPE =
  /^\s*(?:\[[^\]]*\]\s*)*(public|internal|protected)\s+(?:(?:abstract|sealed|static|partial|readonly|ref)\s+)*(class|record|interface|struct|enum)\s+([A-Za-z_]\w*)/;

/**
 * Method declarations. The trailing `(` is what separates them from fields and
 * properties, and the negative lookahead on `=>`/`{` after the parameter list
 * is not attempted: an expression-bodied method is still a method.
 */
const METHOD =
  /^\s*(?:\[[^\]]*\]\s*)*(public|internal|protected)\s+(?:(?:static|virtual|override|abstract|sealed|async|extern|new|partial|unsafe)\s+)*([A-Za-z_][\w<>,.\[\]?]*)\s+([A-Za-z_]\w*)\s*(\([^;]*)?$/;

/** `public string Name { get; set; }` is data, not behaviour worth a test. */
const PROPERTY = /^\s*(?:\[[^\]]*\]\s*)*(?:public|internal|protected)\b[^(;]*\{\s*get\b/;

const KIND_FOR = { class: 'class', record: 'class', struct: 'class', interface: 'interface', enum: 'enum' };

/**
 * @param {Array<{line: number, text: string}>} lines
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean}>}
 */
export function extract(lines) {
  const out = [];

  for (const { line, text } of lines) {
    if (PROPERTY.test(text)) continue;

    const type = text.match(TYPE);
    if (type) {
      out.push({
        name: type[3].slice(0, MAX_NAME_CHARS),
        kind: KIND_FOR[type[2]] ?? 'class',
        line,
        signature: text.trim().slice(0, 200),
        exported: type[1] === 'public',
      });
      continue;
    }

    const method = text.match(METHOD);
    // Group 4 is the parameter list. Without it this is a field declaration,
    // and a constructor has no return type so it never reaches here — which is
    // fine, a constructor is not the unit a test targets.
    if (method && method[4]) {
      out.push({
        name: method[3].slice(0, MAX_NAME_CHARS),
        kind: 'method',
        line,
        signature: text.trim().slice(0, 200),
        exported: method[1] === 'public',
      });
    }
  }

  return out;
}
