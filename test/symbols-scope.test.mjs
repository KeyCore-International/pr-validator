import { describe, expect, it } from 'vitest';
import { extract as csharp } from '../src/symbols/csharp.mjs';
import { extract as typescript } from '../src/symbols/typescript.mjs';
import { extract as vue, scriptBlocks, templateSkeleton } from '../src/symbols/vue.mjs';
import { bodyEnd, maskSource } from '../src/symbols/scan.mjs';
import { bodyLines } from '../src/context/symbol-index.mjs';

/** Turn a source snippet into the shape the extractors consume. */
const lines = (src) => src.split('\n').map((text, i) => ({ line: i + 1, text }));
const byName = (symbols, name) => symbols.find((s) => s.name === name);

describe('maskSource', () => {
  it('blanks strings, comments and regex literals and keeps every column', () => {
    const src = [
      "const a = '{' + \"}\" // { comment",
      'const r = /[{(]/g; /* { */ const b = `x ${y} {`',
    ];
    const masked = maskSource(src);

    expect(masked.map((l) => l.length)).toEqual(src.map((l) => l.length));
    expect(masked.join('\n')).not.toMatch(/[{}]/);
    // The interpolation is code: its `y` survives, the template text does not.
    expect(masked[1]).toContain('y');
    expect(masked[1]).not.toContain('x ');
  });

  it('carries a block comment across lines', () => {
    const masked = maskSource(['/* start {', 'still } comment */ code()']);
    expect(masked[0].trim()).toBe('');
    expect(masked[1]).toContain('code()');
    expect(masked[1]).not.toContain('}');
  });

  it('reads a C# verbatim string as one string across lines', () => {
    const masked = maskSource(['var s = @"line {', 'more "" } text";', 'Call();'], { regex: false, verbatim: true });
    expect(masked[0]).not.toContain('{');
    expect(masked[1]).not.toContain('}');
    expect(masked[2]).toContain('Call();');
  });
});

describe('bodyEnd', () => {
  const end = (src) => {
    const raw = src.split('\n');
    return bodyEnd(maskSource(raw), 0, { raw });
  };

  // The bug this exists for: an expression-bodied arrow in code that writes no
  // semicolons ran on into whatever was declared next.
  it('stops a no-semicolon arrow where the expression ends', () => {
    expect(end(['const add = (a, b) => a + b', 'const sub = (a, b) => a - b'].join('\n'))).toBe(0);
  });

  it('follows a chained expression across lines', () => {
    const src = [
      'const names = (rows) => rows',
      '  .filter(Boolean)',
      '  // a comment between links',
      '  .map((r) => r.name)',
      'const next = 1',
    ].join('\n');
    expect(end(src)).toBe(3);
  });

  it('follows an arrow whose body opens on the next line and closes with a call', () => {
    const src = [
      'export const formatCurrency = (value: number): string =>',
      "  new Intl.NumberFormat('es-CO', {",
      "    style: 'currency',",
      '  }).format(value)',
      'export const other = () => 1',
    ].join('\n');
    expect(end(src)).toBe(3);
  });

  it('keeps a type literal in the parameter list from closing the body', () => {
    const src = ['function pick(a: { x: number }) {', '  return a.x', '}', 'function next() {}'].join('\n');
    expect(end(src)).toBe(2);
  });

  it('ignores braces inside strings', () => {
    const src = ["function wrap(v) {", "  return '{' + v", '}', 'function next() {}'].join('\n');
    expect(end(src)).toBe(2);
  });

  it('ends a C# expression-bodied member at its semicolon', () => {
    const src = ['public decimal Total(Order o) =>', '    o.Lines.Sum(l => l.Price);', 'public void Next() { }'].join('\n');
    expect(end(src)).toBe(1);
  });

  it('is what bodyLines uses for a no-semicolon arrow', () => {
    expect(bodyLines(['const add = (a, b) => a + b', 'const sub = (a, b) => a - b'], 0)).toEqual([
      'const add = (a, b) => a + b',
    ]);
  });
});

describe('csharp scopes', () => {
  const found = csharp(
    lines(
      [
        'namespace App;',
        '',
        'public class OrderService',
        '{',
        '    public decimal Total(Order order)',
        '    {',
        '        return Sum(order.Lines);',
        '',
        '        static decimal Sum(IEnumerable<Line> lines)',
        '        {',
        '            decimal acc = 0;',
        '            foreach (var l in lines) acc += l.Price;',
        '            return acc;',
        '        }',
        '    }',
        '',
        '    decimal Round(decimal value)',
        '    {',
        '        return Math.Round(value, 2);',
        '    }',
        '',
        '    private protected int Narrow(int x) => x * 2;',
        '',
        '    internal async Task<int> LoadAsync(',
        '        int id,',
        '        CancellationToken ct)',
        '    {',
        '        return await _repo.CountAsync(id, ct);',
        '    }',
        '',
        '    public OrderService(IRepo repo) { _repo = repo; }',
        '}',
        '',
        'internal readonly record struct Point(int X, int Y);',
      ].join('\n'),
    ),
  );

  it('reads a member with no modifier as private', () => {
    expect(byName(found, 'Round')).toMatchObject({ scope: 'private', exported: false, container: 'OrderService' });
  });

  it('reads a local function inside its method', () => {
    expect(byName(found, 'Sum')).toMatchObject({
      scope: 'local',
      exported: false,
      container: 'OrderService.Total',
      span: [9, 14],
    });
  });

  it('reports the narrower half of a compound modifier', () => {
    expect(byName(found, 'Narrow')).toMatchObject({ scope: 'private', span: [22, 22] });
  });

  it('joins a parameter list wrapped across lines into the signature', () => {
    const load = byName(found, 'LoadAsync');
    expect(load.scope).toBe('internal');
    expect(load.signature).toBe('internal async Task<int> LoadAsync( int id, CancellationToken ct)');
    expect(load.span).toEqual([24, 29]);
  });

  it('keeps the public method exported and spans its body', () => {
    expect(byName(found, 'Total')).toMatchObject({ scope: 'public', exported: true, span: [5, 15] });
  });

  it('leaves constructors and statements out', () => {
    const names = found.map((s) => s.name);
    expect(names).not.toContain('OrderService(');
    expect(found.filter((s) => s.name === 'OrderService')).toHaveLength(1);
    expect(names).not.toContain('CountAsync');
  });

  it('names a record struct after itself, not after the keyword', () => {
    expect(byName(found, 'Point')).toMatchObject({ kind: 'class', scope: 'internal' });
    expect(found.map((s) => s.name)).not.toContain('struct');
  });

  it('does not read SQL inside a raw string, or a generic call, as local functions', () => {
    const out = csharp(
      lines(
        [
          'public class Repo',
          '{',
          '    public IQueryable<Row> Missing(string field)',
          '    {',
          '        var rows = _context.Rows.FromSql($"""',
          '            SELECT * FROM Rows AS l',
          '            WHERE ISJSON(l.Findings) = 1 AND EXISTS (',
          '                SELECT 1 FROM OPENJSON(l.Findings)',
          '            """);',
          '        return _mapper.Map<List<Row>, List<RowDto>>(',
          '            rows);',
          '    }',
          '}',
        ].join('\n'),
      ),
    );
    expect(out.map((s) => s.name)).toEqual(['Repo', 'Missing']);
    expect(byName(out, 'Missing').span).toEqual([3, 12]);
  });

  it('leaves out interface members whose parameter list wraps', () => {
    const out = csharp(
      lines(
        [
          'public interface IMailer',
          '{',
          '    Task<bool> SendAsync(',
          '        string to,',
          '        string body);',
          '}',
        ].join('\n'),
      ),
    );
    expect(out.map((s) => s.name)).toEqual(['IMailer']);
  });

  it('reads a CRLF file like any other', () => {
    const out = csharp(lines('public class A\r\n{\r\n    private int Twice(int x) => x * 2;\r\n}\r\n'));
    expect(byName(out, 'Twice')).toMatchObject({ scope: 'private', span: [3, 3] });
  });

  // A diff carries only added lines, so a method whose body was not touched
  // never closes. A member with an access modifier must not be swallowed by it.
  it('recovers when only the declaration of a method is in the lines read', () => {
    const partial = csharp([
      { line: 10, text: '    public void Changed(int x)' },
      { line: 40, text: '    public void Added(int y)' },
      { line: 50, text: 'public class NewType' },
    ]);
    expect(partial.map((s) => `${s.name}:${s.exported}`)).toEqual([
      'Changed:true',
      'Added:true',
      'NewType:true',
    ]);
  });
});

describe('typescript scopes', () => {
  const src = [
    "import { ref } from 'vue'", //                                    1
    '',
    'function slugify(value: string): string {', //                    3
    "  return value.toLowerCase().replace(/[^a-z]+/g, '-')",
    '}',
    '',
    'const clamp = (n: number, min: number, max: number) =>', //       7
    '  Math.min(max, Math.max(min, n))',
    '',
    'export function useMoney(locale: string) {', //                  10
    '  const total = ref(0)',
    '',
    '  function formatCurrency(value: number): string {', //          13
    '    return new Intl.NumberFormat(locale, {',
    "      style: 'currency',",
    '    }).format(value)',
    '  }',
    '',
    '  const formatPercent = (value: number) =>', //                  19
    '    `${(value * 100).toFixed(1)} %`',
    '',
    '  return { total, formatCurrency, formatPercent }',
    '}',
    '',
    'export class PriceService {', //                                 25
    '  private readonly rate = 2',
    '',
    '  async convert(amount: number): Promise<number> {', //          28
    '    if (amount < 0) {',
    '      return 0',
    '    }',
    '    return amount * this.rate',
    '  }',
    '',
    '  private round(value: number) {', //                            35
    '    return Math.round(value)',
    '  }',
    '',
    '  #secret() {', //                                               39
    '    return 1',
    '  }',
    '',
    '  onChange = (event: Event) => {', //                            43
    '    this.convert(1)',
    '  }',
    '}',
    '',
    'const api = {', //                                               48
    '  list(page: number) {',
    '    return fetch(`/items?page=${page}`)',
    '  },',
    '  remove: async (id: string) => {',
    '    await fetch(`/items/${id}`)',
    '  },',
    '  label: compute(',
    '    1,',
    '  ),',
    '}',
    '',
    'export const parse = (', //                                      60
    '  raw: string,',
    '  fallback = 0,',
    '): number => {',
    '  const n = Number(raw)',
    '  return Number.isNaN(n) ? fallback : n',
    '}',
    '',
    'export { slugify }', //                                          68
  ].join('\n');

  const found = typescript(lines(src));

  it('reads a top-level function nobody exports as module scope', () => {
    expect(byName(found, 'clamp')).toMatchObject({ scope: 'module', exported: false, span: [7, 8] });
  });

  it('marks a declaration exported by a later `export { … }` list', () => {
    expect(byName(found, 'slugify')).toMatchObject({ scope: 'exported', exported: true, span: [3, 5] });
  });

  it('reads the helpers of a composable as inner, contained by it', () => {
    expect(byName(found, 'formatCurrency')).toMatchObject({
      scope: 'inner',
      exported: false,
      container: 'useMoney',
      span: [13, 17],
    });
    expect(byName(found, 'formatPercent')).toMatchObject({ scope: 'inner', container: 'useMoney', span: [19, 20] });
  });

  it('reads class members with the scope their modifiers give', () => {
    expect(byName(found, 'convert')).toMatchObject({ kind: 'method', scope: 'public', container: 'PriceService', span: [28, 33] });
    expect(byName(found, 'round')).toMatchObject({ scope: 'private', container: 'PriceService' });
    expect(byName(found, 'secret')).toMatchObject({ scope: 'private' });
    expect(byName(found, 'onChange')).toMatchObject({ kind: 'method', scope: 'public', span: [43, 45] });
  });

  it('does not read a class field holding data as a method', () => {
    expect(byName(found, 'rate')).toBeUndefined();
  });

  it('reads the methods of an object literal, and not the calls inside it', () => {
    expect(byName(found, 'list')).toMatchObject({ kind: 'method', scope: 'member', container: 'api', span: [49, 51] });
    expect(byName(found, 'remove')).toMatchObject({ kind: 'method', scope: 'member', container: 'api' });
    expect(byName(found, 'compute')).toBeUndefined();
    expect(byName(found, 'label')).toBeUndefined();
  });

  it('reads an arrow whose parameter list wraps across lines', () => {
    const parse = byName(found, 'parse');
    expect(parse).toMatchObject({ scope: 'exported', exported: true, span: [60, 66] });
    expect(parse.signature).toBe('export const parse = ( raw: string, fallback = 0, ): number => {');
  });

  it('leaves statements out', () => {
    const names = found.map((s) => s.name);
    expect(names).not.toContain('total');
    expect(names).not.toContain('fetch');
  });

  it('ignores a re-export list', () => {
    const reexport = typescript(lines("function local() {\n  return 1\n}\nexport { local } from './other'"));
    expect(byName(reexport, 'local').exported).toBe(false);
  });

  it('reads `export default name` as exporting that declaration', () => {
    const out = typescript(lines('const handler = (req) => req.body\nexport default handler'));
    expect(byName(out, 'handler')).toMatchObject({ exported: true, scope: 'exported' });
  });

  it('reads a React component and the handlers it declares', () => {
    const out = typescript(
      lines(
        [
          'export default function PriceTag({ amount }: Props) {',
          '  const handleClick = () => {',
          '    track(amount)',
          '  }',
          '  return <button onClick={handleClick}>{amount}</button>',
          '}',
        ].join('\n'),
      ),
    );
    expect(byName(out, 'PriceTag')).toMatchObject({ exported: true, span: [1, 6] });
    expect(byName(out, 'handleClick')).toMatchObject({ scope: 'inner', container: 'PriceTag', span: [2, 4] });
  });

  it('reads the actions of an options store as members of it', () => {
    const out = typescript(
      lines(
        [
          "export const useCart = defineStore('cart', {",
          '  state: () => ({ items: [] }),',
          '  actions: {',
          '    add(item) {',
          '      this.items.push(item)',
          '    },',
          '  },',
          '})',
        ].join('\n'),
      ),
    );
    expect(byName(out, 'useCart')).toMatchObject({ exported: true, kind: 'function' });
    expect(byName(out, 'add')).toMatchObject({ scope: 'member', container: 'useCart.actions', span: [4, 6] });
    expect(byName(out, 'state')).toMatchObject({ scope: 'member', container: 'useCart' });
  });

  it('reads the inner functions of a setup store', () => {
    const out = typescript(
      lines(
        [
          "export const useAuth = defineStore('auth', () => {",
          '  function logout() {',
          '    token.value = null',
          '  }',
          '  return { logout }',
          '})',
        ].join('\n'),
      ),
    );
    expect(byName(out, 'logout')).toMatchObject({ scope: 'inner', container: 'useAuth' });
  });

  it('reads a NestJS service method behind its decorators', () => {
    const out = typescript(
      lines(
        [
          '@Injectable()',
          'export class OrdersService {',
          '  constructor(private readonly repo: Repo) {}',
          '',
          "  @Get(':id')",
          "  async findOne(@Param('id') id: string): Promise<Order> {",
          '    return this.repo.findOne(id)',
          '  }',
          '}',
        ].join('\n'),
      ),
    );
    expect(byName(out, 'findOne')).toMatchObject({ scope: 'public', container: 'OrdersService', span: [6, 8] });
    expect(byName(out, 'constructor')).toBeUndefined();
  });

  it('reads an arrow whose return type is an object literal', () => {
    const out = typescript(
      lines(
        [
          'export const useLabels = (): {',
          '  label: (key: string) => string;',
          '} => {',
          '  const label = (key: string): string => key.toUpperCase()',
          '  return { label }',
          '}',
        ].join('\n'),
      ),
    );
    expect(out.map((s) => `${s.name}:${s.scope}`)).toEqual(['useLabels:exported', 'label:inner']);
  });

  // A regression: a `{` after `&` or `|` in the return type was read as the
  // body, so type guards and intersection/union return types vanished.
  it('reads arrows whose return type is an intersection or union with an object type', () => {
    const out = typescript(
      lines(
        [
          'export const isProjectRow = (r: Row): r is Row & { data: Project } =>', //  1
          "  r.kind === 'project'", //                                                 2
          'export const pick = (a: A): A | { empty: true } => {', //                    3
          '  return a', //                                                              4
          '}', //                                                                       5
          'export function useRows() {', //                                             6
          '  const asError = (e: unknown): Error & { status: number } => e as never', //7
          '  return { asError }', //                                                    8
          '}', //                                                                       9
          'const guards = {', //                                                       10
          '  isItem: (r: Row): r is Row & { item: true } => r.item === true,', //       11
          '}', //                                                                      12
          'class Repo {', //                                                           13
          '  find(): Row & { id: string } {', //                                       14
          '    return null', //                                                        15
          '  }', //                                                                    16
          '}', //                                                                      17
        ].join('\n'),
      ),
    );
    const names = out.map((s) => `${s.name}:${s.scope}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'isProjectRow:exported',
        'pick:exported',
        'asError:inner',
        'isItem:member',
        'find:public',
      ]),
    );
    expect(byName(out, 'pick').span).toEqual([3, 5]);
    expect(byName(out, 'find').span).toEqual([14, 16]);
  });

  it('ignores declarations inside comments and strings', () => {
    const out = typescript(lines("// function ghost() {}\nconst s = 'function nope() {}'\n/*\nfunction gone() {}\n*/"));
    expect(out).toEqual([]);
  });
});

describe('vue scopes', () => {
  const sfc = [
    '<template>', //                                        1
    '  <div class="card" v-if="a > b">',
    '    <!-- a comment <span> -->',
    '    <h2>{{ title }}</h2>',
    '    <AppButton @click="save" />',
    '  </div>',
    '</template>',
    '',
    '<script setup lang="ts">', //                          9
    "import { ref } from 'vue'",
    '',
    'const title = ref(\'\')', //                           12
    '',
    'function formatDate(value: string) {', //              14
    "  return new Date(value).toLocaleDateString('es-CO')",
    '}',
    '',
    'const save = async () => {', //                         18
    '  await api.save(title.value)',
    '}',
    '</script>',
    '',
    '<style scoped>',
    '.card { color: red; }',
    '</style>',
  ].join('\n');

  const found = vue(lines(sfc), 'src/components/price-card.vue');

  it('reads only the script block, at the lines it has in the file', () => {
    expect(byName(found, 'formatDate')).toMatchObject({ line: 14, span: [14, 16] });
    expect(byName(found, 'save')).toMatchObject({ line: 18, span: [18, 20] });
  });

  it('marks the functions of <script setup> private to the component', () => {
    expect(byName(found, 'formatDate')).toMatchObject({ scope: 'private', exported: false, container: 'PriceCard' });
  });

  it('gives the component a skeleton of its template', () => {
    const component = byName(found, 'PriceCard');
    expect(component.kind).toBe('component');
    expect(component.templateSkeleton).toBe('div h2 /h2 AppButton/ /div');
  });

  it('does not read the style block as script', () => {
    expect(found.map((s) => s.name)).toEqual(['PriceCard', 'formatDate', 'save']);
  });

  it('names the container of an options-API method after the component', () => {
    const options = vue(
      lines(
        [
          '<script>',
          'export default {',
          '  methods: {',
          '    total(items) {',
          '      return items.reduce((a, b) => a + b, 0)',
          '    },',
          '  },',
          '}',
          '</script>',
        ].join('\n'),
      ),
      'Cart.vue',
    );
    expect(byName(options, 'total')).toMatchObject({ scope: 'member', container: 'Cart.methods', line: 4 });
  });

  it('splits the script blocks and says which one is setup', () => {
    const blocks = scriptBlocks(lines('<script lang="ts">\nexport const a = 1\n</script>\n<script setup>\nconst b = 2\n</script>'));
    expect(blocks.map((b) => [b.setup, b.lines.map((l) => l.line)])).toEqual([
      [false, [2]],
      [true, [5]],
    ]);
  });

  it('finds the script block of a CRLF file', () => {
    const crlf = vue(lines('<script setup lang="ts">\r\nfunction go() {\r\n  return 1\r\n}\r\n</script>\r\n'), 'Go.vue');
    expect(byName(crlf, 'go')).toMatchObject({ scope: 'private', container: 'Go', span: [2, 4] });
  });

  it('has no skeleton when the template is not among the lines', () => {
    expect(templateSkeleton(lines('<script setup>\n</script>'))).toBeNull();
  });
});
