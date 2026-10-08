// Just enough lexing to tell structure from text.
//
// The extractors are regular expressions over lines, and a regular expression
// cannot tell a brace that opens a body from one inside a string, a comment or a
// regex literal. Counting those as structure is what made a body window run on
// into the next declaration, or stop half way through the one it was reading.
//
// So the source is MASKED first: every character inside a string, a comment or
// a regex literal becomes a space, the delimiters of strings stay, and every
// line keeps its length. Whatever reads the masked text sees only code, at the
// same columns as the original.
//
// This is a lexer for the purpose of counting, not a parser. What it gets wrong
// on exotic input (a raw C# string, a regex after a keyword it does not know)
// costs a window that is slightly off, never an invented symbol.

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Keywords after which a `/` starts a regex literal. */
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|yield|await|delete|void|throw)$/;

/**
 * Mask strings, comments and regex literals out of a source, line by line.
 *
 * @param {string[]} texts the source lines
 * @param {object} [opts]
 * @param {boolean} [opts.regex] whether `/…/` can be a regex literal (JS/TS)
 * @param {boolean} [opts.verbatim] whether `@"…"` and `"""…"""` are multi-line strings (C#)
 * @returns {string[]} the masked lines, each the same length as the original
 */
export function maskSource(texts, { regex = true, verbatim = false } = {}) {
  const out = [];

  // What the scanner is inside of when a line ends. Strings in quotes end with
  // their line (an unterminated one is a typo, not a reason to mask the rest of
  // the file); block comments, template literals and verbatim strings do not.
  let mode = 'code';
  // Template literals nest through `${…}`: each entry is the brace depth of an
  // open interpolation, so its closing `}` can be told from an inner one.
  const templates = [];
  // The last significant code character, for the regex-or-division question.
  let previous = '';
  let previousWord = '';
  // The length of the quote run that opened the current C# raw string.
  let rawQuotes = 0;

  for (const text of texts) {
    const chars = String(text ?? '').split('');
    const line = chars.length;

    let i = 0;
    while (i < line) {
      const c = chars[i];
      const next = chars[i + 1];

      if (mode === 'block') {
        if (c === '*' && next === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          mode = 'code';
          continue;
        }
        chars[i] = ' ';
        i += 1;
        continue;
      }

      if (mode === 'raw') {
        if (c === '"') {
          let run = 0;
          while (chars[i + run] === '"') run += 1;
          if (run >= rawQuotes) {
            mode = 'code';
            previous = '"';
            i += run;
            continue;
          }
        }
        chars[i] = ' ';
        i += 1;
        continue;
      }

      if (mode === 'verbatim') {
        if (c === '"' && next === '"') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === '"') {
          mode = 'code';
          previous = '"';
          i += 1;
          continue;
        }
        chars[i] = ' ';
        i += 1;
        continue;
      }

      if (mode === 'template') {
        if (c === '\\') {
          chars[i] = ' ';
          if (i + 1 < line) chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === '`') {
          mode = 'code';
          previous = '`';
          i += 1;
          continue;
        }
        if (c === '$' && next === '{') {
          // The interpolation is code again. Its own delimiters are masked: they
          // belong to the string, and a `${` read as a brace would open a body.
          chars[i] = ' ';
          chars[i + 1] = ' ';
          templates.push(0);
          mode = 'code';
          i += 2;
          previous = '{';
          continue;
        }
        chars[i] = ' ';
        i += 1;
        continue;
      }

      // mode === 'code'
      if (c === '/' && next === '/') {
        for (let k = i; k < line; k += 1) chars[k] = ' ';
        break;
      }

      if (c === '/' && next === '*') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        mode = 'block';
        continue;
      }

      // C# 11 raw strings: three or more quotes open one, and the same run
      // closes it, across lines. SQL inside one reads like declarations.
      if (c === '"' && verbatim && next === '"' && chars[i + 2] === '"') {
        let run = 0;
        while (chars[i + run] === '"') run += 1;
        rawQuotes = run;
        mode = 'raw';
        i += run;
        continue;
      }

      if (c === '"' && verbatim && (chars[i - 1] === '@' || (chars[i - 1] === '$' && chars[i - 2] === '@'))) {
        mode = 'verbatim';
        i += 1;
        continue;
      }

      if (c === '"' || c === "'") {
        i = maskQuoted(chars, i, c);
        previous = c;
        previousWord = '';
        continue;
      }

      if (c === '`') {
        mode = 'template';
        i += 1;
        continue;
      }

      if (c === '/' && regex && startsRegex(previous, previousWord)) {
        i = maskRegex(chars, i);
        previous = '/';
        previousWord = '';
        continue;
      }

      if (templates.length) {
        if (c === '{') templates[templates.length - 1] += 1;
        else if (c === '}') {
          if (templates[templates.length - 1] === 0) {
            chars[i] = ' ';
            templates.pop();
            mode = 'template';
            i += 1;
            continue;
          }
          templates[templates.length - 1] -= 1;
        }
      }

      if (/[\w$]/.test(c)) {
        previousWord = /[\w$]/.test(chars[i - 1] ?? '') ? previousWord + c : c;
        previous = c;
      } else if (!/\s/.test(c)) {
        previous = c;
        previousWord = '';
      }
      i += 1;
    }

    out.push(chars.join(''));
  }

  return out;
}

function startsRegex(previous, previousWord) {
  if (previous === '') return true;
  if (REGEX_PRECEDERS.has(previous)) return true;
  return previousWord !== '' && REGEX_KEYWORDS.test(previousWord);
}

/** Mask a quoted string that starts at `start`; returns the index after it. */
function maskQuoted(chars, start, quote) {
  let i = start + 1;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\') {
      chars[i] = ' ';
      if (i + 1 < chars.length) chars[i + 1] = ' ';
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    chars[i] = ' ';
    i += 1;
  }
  return i;
}

/** Mask a regex literal that starts at `start`; returns the index after its flags. */
function maskRegex(chars, start) {
  let i = start + 1;
  let inClass = false;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\') {
      chars[i] = ' ';
      if (i + 1 < chars.length) chars[i + 1] = ' ';
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i += 1;
      while (i < chars.length && /[a-z]/i.test(chars[i])) i += 1;
      return i;
    }
    chars[i] = ' ';
    i += 1;
  }
  return i;
}

/**
 * Brace depth at the START of each masked line.
 *
 * @param {string[]} masked
 * @returns {number[]}
 */
export function braceDepths(masked) {
  const depths = [];
  let depth = 0;
  for (const line of masked) {
    depths.push(depth);
    for (const c of line) {
      if (c === '{') depth += 1;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }
  }
  return depths;
}

/**
 * A line that cannot end an expression: the next one must carry it on.
 *
 * A trailing comma is not one of them. At depth 0 it ends a property of the
 * object literal the arrow sits in (`state: () => ({}),`), not the arrow.
 */
const ENDS_OPEN = /(?:=>|&&|\|\||\?\?|(?<![+-])[+-]|[*/%&|^?:=<.([{])$/;

/** A line that continues the expression of the line before it. */
const STARTS_CONTINUING = /^(?:\?\.|\.(?!\.\.)|\?\?|&&|\|\||[-+*/%&|^?:<>=,]|(?:as|satisfies|instanceof)\b)/;

/**
 * The index of the line on which a declaration starting at `start` ends.
 *
 * Three shapes, decided as the scan goes:
 *
 *  - An arrow at depth 0 (`=> expr`, `=> {`, C#'s `=> expr;`) ends where the
 *    bracket depth is back to 0 and the next line does not carry the expression
 *    on with a `.` or an operator. Without this, an expression-bodied arrow in
 *    code that writes no semicolons ran on into whatever was declared next.
 *  - A body in braces ends where the depth of every bracket kind returns to 0
 *    after the first `{`. Counting parentheses too is what keeps a type literal
 *    in a parameter list (`(a: { x: number }) {`) from closing the window early.
 *  - No body yet: a statement end (`;`) or a blank line at depth 0 means there
 *    is none — an abstract member, an interface member, a field.
 *
 * @param {string[]} masked lines from `maskSource`
 * @param {number} start
 * @param {object} [opts]
 * @param {number} [opts.maxLines] stop looking after this many lines
 * @param {string[]} [opts.raw] the unmasked lines, to tell a comment line from a blank one
 * @returns {number}
 */
export function bodyEnd(masked, start, { maxLines = 5000, raw = null } = {}) {
  const last = Math.min(masked.length, start + maxLines) - 1;
  let depth = 0;
  let opened = false;
  let arrow = false;
  let afterArrow = false;

  for (let i = start; i <= last; i += 1) {
    const code = masked[i] ?? '';

    for (let k = 0; k < code.length; k += 1) {
      const c = code[k];
      if (c === '(' || c === '[' || c === '{') {
        depth += 1;
        if (c === '{') opened = true;
        if (arrow) afterArrow = true;
      } else if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
      } else if (c === '=' && code[k + 1] === '>' && depth === 0 && !arrow) {
        arrow = true;
        k += 1;
      } else if (arrow && !/\s/.test(c)) {
        afterArrow = true;
      }
    }

    const trimmed = code.trim();

    if (arrow) {
      // Below 0 the line closed a bracket the declaration sits inside — the
      // call or the object it was an argument or a property of.
      if (depth < 0) return i;
      if (depth <= 0 && trimmed.endsWith(';')) return i;
      if (afterArrow && depth <= 0 && !ENDS_OPEN.test(trimmed)) {
        const following = nextCodeLine(masked, raw, i + 1, last);
        if (following === null || !STARTS_CONTINUING.test(following)) return i;
      }
      continue;
    }

    if (opened) {
      if (depth <= 0) return i;
      continue;
    }

    if (depth <= 0 && (trimmed.endsWith(';') || trimmed === '')) return i;
  }

  return Math.max(start, last);
}

/**
 * The next line with code on it, skipping lines that hold only a comment.
 *
 * A blank line ends the search: an expression does not continue across one in
 * any code anybody formats.
 */
function nextCodeLine(masked, raw, from, last) {
  for (let i = from; i <= last; i += 1) {
    const code = (masked[i] ?? '').trim();
    if (code) return code;
    const original = raw ? String(raw[i] ?? '').trim() : '';
    if (!original) return null;
  }
  return null;
}

/**
 * The index just past the bracket that closes the one at `open`, or -1.
 *
 * @param {string} text masked text
 * @param {number} open index of `(`, `[` or `{`
 */
export function closingIndex(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
