import { describe, expect, it } from 'vitest';
import { computeMetrics, isLogicBearing, logicProfile } from '../src/similarity/metrics.mjs';
import { stripCode } from '../src/similarity/body.mjs';

// A date formatter with a guard, a ternary, a try/catch and arithmetic on the
// month: the shape of the helpers this measure exists for.
const DATE_DASHED = `export const formatDateToDDMMYYYY = (date: string | Date | null | undefined): string => {
  if (!date) return '-';

  try {
    const dateObj = date instanceof Date ? date : new Date(date);

    if (isNaN(dateObj.getTime())) {
      return '-';
    }

    const day = dateObj.getDate().toString().padStart(2, '0');
    const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const year = dateObj.getFullYear();

    return \`\${day}-\${month}-\${year}\`;
  } catch (e) {
    console.error("Error formatting date:", e);
    return '-';
  }
};`;

const fn = (body, over = {}) => ({ name: 'subject', kind: 'function', path: 'src/a.ts', signature: '', body, ...over });

describe('stripCode', () => {
  it('drops comments and strings but keeps the line count', () => {
    const { code } = stripCode('a(); // if (x && y)\n/* while\n */ b("c && d");');

    expect(code).not.toMatch(/if|while|&&/);
    expect(code.split('\n')).toHaveLength(3);
  });

  it('reads a regular-expression literal as one, not as division', () => {
    expect(stripCode('const ok = /^\\d+\\/\\d+$/.test(s);').regexLiterals).toBe(1);
    expect(stripCode('const half = total / count / 2;').regexLiterals).toBe(0);
  });

  it('does not mistake a JSX closing tag for a regular expression', () => {
    expect(stripCode('return <div><b>x</b></div>;').regexLiterals).toBe(0);
  });

  it('keeps a C# verbatim string whole, doubled quotes included', () => {
    const { code } = stripCode('var p = @"C:\\dir ""quoted"" && more"; if (x) y();');

    expect(code).not.toContain('&&');
    expect(code).toContain('if (x)');
  });

  // A body is somebody else's source: an unclosed comment or a run of escaped
  // quotes must cost one walk over the text, not one per start offset.
  it('finishes promptly on hostile input', () => {
    const started = Date.now();
    stripCode('/* '.repeat(100_000));
    stripCode('\\"'.repeat(100_000));
    stripCode('/'.repeat(100_000));

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('computeMetrics', () => {
  it('measures a real helper', () => {
    expect(computeMetrics(fn(DATE_DASHED))).toEqual({ lines: 16, params: 1, nesting: 2, cyclomatic: 5 });
  });

  it.each([
    ['if / else if', 'function f(a) {\n if (a > 1) { x(); } else if (a < 0) { y(); } else { z(); }\n}', 3],
    ['switch cases, not default', 'function f(a) {\n switch (a) { case 1: return 1; case 2: return 2; default: return 0; }\n}', 3],
    ['loops', 'function f(a) {\n for (const x of a) {} while (a.length) {} do {} while (b);\n}', 4],
    ['catch', 'function f() {\n try { x(); } catch (e) { y(); }\n}', 2],
    ['logical operators', 'function f(a, b) {\n return (a && b) || (a ?? b);\n}', 4],
    ['a ternary', 'function f(a) {\n return a ? 1 : 2;\n}', 2],
    ['a multi-line ternary', 'function f(a) {\n return a\n  ? 1\n  : 2;\n}', 2],
  ])('counts %s', (_, body, expected) => {
    expect(computeMetrics(fn(body)).cyclomatic).toBe(expected);
  });

  it.each([
    ['optional chaining', 'function f(a) {\n return a?.b?.c;\n}'],
    ['a TypeScript optional parameter', 'function f(a?: string, b?: number): string {\n return x(a, b);\n}'],
    ['a C# nullable type', 'public int? F(int? a)\n{\n int? b = a;\n return b;\n}'],
    ['branch words inside strings and comments', 'function f() {\n // if (a && b)\n return "if || while";\n}'],
  ])('does not count %s as a branch', (_, body) => {
    expect(computeMetrics(fn(body)).cyclomatic).toBe(1);
  });

  it('counts nesting of control blocks only', () => {
    const body = `function f(items) {
  const config = { a: { b: 1 } };
  for (const item of items) {
    if (item.ok) {
      items.forEach((x) => { if (x) { y(); } });
    }
  }
}`;

    // for > if > (callback block: not control) > if
    expect(computeMetrics(fn(body)).nesting).toBe(3);
  });

  it('reads parameters from the signature, or from the declaration when there is none', () => {
    expect(computeMetrics(fn('x', { signature: 'public void F(int a, string b, Dictionary<string, int> c)' })).params).toBe(3);
    expect(computeMetrics(fn('function f(a, b) {\n return a;\n}')).params).toBe(2);
  });

  it('counts code lines, not blanks or comments', () => {
    expect(computeMetrics(fn('function f() {\n\n  // note\n  return 1;\n}')).lines).toBe(3);
  });
});

describe('isLogicBearing', () => {
  it.each([
    ['branches, a date and arithmetic', DATE_DASHED, ['branches', 'arithmetic', 'date']],
    ['arithmetic between operands', 'function total(o) {\n return o.price * o.quantity;\n}', ['arithmetic']],
    ['a compound assignment', 'function f(o) {\n let t = 0;\n t += o.amount;\n return t;\n}', ['arithmetic']],
    ['a loop', 'function f(xs) {\n xs.forEach((x) => send(x));\n}', ['loop']],
    ['a regular expression', 'function isCode(s) {\n return /^[A-Z]{3}-\\d+$/.test(s);\n}', ['regex']],
    ['a currency format', "function money(v) {\n return new Intl.NumberFormat('es-CO', { style: 'currency' }).format(v);\n}", ['currency']],
    ['a parse', 'function n(s) {\n return parseInt(s, 10);\n}', ['parse']],
    ['a C# date operation', 'public DateTime Next(DateTime d)\n{\n return d.AddDays(1);\n}', ['date']],
    ['a math operation', 'function r(v) {\n return Math.round(v);\n}', ['math']],
  ])('holds for %s', (_, body, reasons) => {
    const profile = logicProfile(fn(body));

    expect(profile.logicBearing).toBe(true);
    expect(profile.reasons).toEqual(reasons);
  });

  it.each([
    ['pure delegation', 'async getAll() {\n  return this.repo.findAll()\n}'],
    ['a constant expression', 'function ttl() {\n return 60 * 1000;\n}'],
    ['string concatenation', "function url(id) {\n return '/items/' + id;\n}"],
    ['a negative literal after return', 'function f(a) {\n log(a);\n return -1;\n}'],
    ['a date type only in the parameters', 'public Task Save(DateTime when)\n{\n return _repo.Save(when);\n}'],
  ])('does not hold for %s', (_, body) => {
    expect(isLogicBearing(fn(body))).toBe(false);
  });

  it.each([
    ['an interface', { kind: 'interface' }, 'kind:interface'],
    ['an enum', { kind: 'enum' }, 'kind:enum'],
    ['a class (its methods are judged instead)', { kind: 'class' }, 'kind:class'],
    ['a migration', { path: 'src/Migrations/20240101_Init.cs' }, 'migration'],
    ['the model snapshot', { path: 'src/Data/AppDbContextModelSnapshot.cs' }, 'migration'],
    ['a DTO file', { path: 'src/Application/DTOs/OrderDto.cs' }, 'dto'],
  ])('exempts %s whatever the body says', (_, over, exempt) => {
    const profile = logicProfile(fn(DATE_DASHED, over));

    expect(profile.logicBearing).toBe(false);
    expect(profile.exempt).toBe(exempt);
  });

  it('exempts DI registration', () => {
    const body = `public static IServiceCollection AddInfrastructure(this IServiceCollection services)
{
    services.AddScoped<IOrderRepository, OrderRepository>();
    services.AddSingleton<IClock, SystemClock>();
    return services;
}`;

    expect(logicProfile(fn(body, { kind: 'method', name: 'AddInfrastructure' })).exempt).toBe('di-registration');
  });

  it('exempts a flat getter and a flat mapper, even with arithmetic', () => {
    expect(logicProfile(fn('get total() {\n return this.price * this.qty;\n}', { name: 'total' })).exempt).toBe('getter');
    expect(
      logicProfile(fn('export const toRow = (o) => ({\n id: o.id,\n total: o.price * o.qty,\n})', { name: 'toRow' })).exempt,
    ).toBe('mapper');
  });

  it('does not exempt a mapper that branches', () => {
    const body = 'export const toRow = (o) => ({\n id: o.id,\n label: o.active ? x() : y(),\n})';

    expect(isLogicBearing(fn(body, { name: 'toRow' }))).toBe(true);
  });

  // A name that ends like a DTO says nothing about a function's body.
  it('judges a function named like a request on its body', () => {
    expect(isLogicBearing(fn('function validateRequest(r) {\n if (!r.id) throw x();\n}', { name: 'validateRequest' }))).toBe(true);
  });

  it('accepts a bare body', () => {
    expect(isLogicBearing('function f(a) {\n return a > 1 ? x() : y();\n}')).toBe(true);
  });
});
