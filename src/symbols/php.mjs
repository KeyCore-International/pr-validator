// Public PHP symbols, found with regular expressions.
//
// Same trade as the other extractors: no parser, no dependency, and a missed
// symbol is cheaper than an invented one.
//
// PHP methods are public by default when no visibility is written, so the
// absence of a modifier means public — the opposite of C#, and the easiest
// thing to get wrong here.

/** `class Foo`, `final class Foo`, `abstract class Foo`, `interface`, `trait`, `enum`. */
const TYPE =
  /^\s*(?:(?:final|abstract|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/;

/** `public function foo(`, `function foo(`, `public static function foo(`. */
const METHOD =
  /^\s*(?:(?:final|abstract|static)\s+)*(?:(public|protected|private)\s+)?(?:(?:final|abstract|static)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/;

const KIND_FOR = { class: 'class', interface: 'interface', trait: 'class', enum: 'enum' };

/** Magic methods are framework plumbing, not units anybody targets with a test. */
const MAGIC = /^__/;

/**
 * @param {Array<{line: number, text: string}>} lines
 * @returns {Array<{name: string, kind: string, line: number, signature: string, exported: boolean}>}
 */
export function extract(lines) {
  const out = [];

  for (const { line, text } of lines) {
    const type = text.match(TYPE);
    if (type) {
      out.push({
        name: type[2],
        kind: KIND_FOR[type[1]] ?? 'class',
        line,
        signature: text.trim().slice(0, 200),
        exported: true,
      });
      continue;
    }

    const method = text.match(METHOD);
    if (!method || MAGIC.test(method[2])) continue;

    // No visibility keyword means public in PHP.
    const visibility = method[1] ?? 'public';
    if (visibility === 'private') continue;

    out.push({
      name: method[2],
      kind: 'method',
      line,
      signature: text.trim().slice(0, 200),
      exported: visibility === 'public',
    });
  }

  return out;
}
