import { describe, expect, it } from 'vitest';
import { nameSimilarity, tokenize } from '../src/similarity/name.mjs';
import { normalizeSignature, signatureSimilarity } from '../src/similarity/signature.mjs';
import { bodySimilarity, normalizeBody } from '../src/similarity/body.mjs';
import { DEFAULT_THRESHOLD, findDuplicates, scorePair } from '../src/similarity/score.mjs';
import { applyExclusions, isExcludedPath, isExcludedSymbol } from '../src/similarity/exclusions.mjs';

describe('tokenize', () => {
  it.each([
    ['CalculateOrderTotal', ['compute', 'order', 'sum']],
    ['calculate_order_totals', ['compute', 'order', 'sum']],
    ['getOrderTotal', ['order', 'sum']],
    ['HTTPClientFactory', ['http', 'client', 'factory']],
  ])('reduces %s to its meaning', (name, expected) => {
    expect(tokenize(name)).toEqual(expected);
  });
});

// Acronym runs are where the split rule earns its keep, and where a change to
// it would show first. Pinned so the tokens cannot drift unnoticed.
describe('tokenize across acronym runs', () => {
  it.each([
    ['getHTTPResponseCode', ['http', 'response', 'code']],
    ['parseURLFromXMLHTTPRequest', ['map', 'url', 'xmlhttp', 'request']],
    ['IOError', ['io', 'error']],
    ['ABCd', ['ab', 'cd']],
  ])('splits %s where it always did', (name, expected) => {
    expect(tokenize(name)).toEqual(expected);
  });
});

// A name reaches the tokeniser straight from a regex capture on a line of
// somebody else's pull request, and is tokenised again for every candidate it
// is compared against. Unbounded, a run of capitals held a runner CPU for the
// whole job — the fork case needs no permissions and no secrets.
describe('tokenize under hostile input', () => {
  it('reads a bounded prefix of an enormous name', () => {
    expect(tokenize('A'.repeat(400_000))).toEqual(['a'.repeat(200)]);
  });

  it('bounds the tokens it returns for a long identifier-shaped name', () => {
    expect(tokenize('GetOrderTotal'.repeat(5_000)).join('').length).toBeLessThanOrEqual(200);
  });

  // Wall clock, deliberately generous: what matters is that the work stopped
  // growing with the length of the name, not how loaded this machine is.
  it('finishes promptly on a long run of capitals', () => {
    const started = Date.now();
    tokenize('A'.repeat(400_000));

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('nameSimilarity', () => {
  // The pair this check exists to catch: the same idea, two authors.
  it('sees through casing, verbs and plurals', () => {
    expect(nameSimilarity('CalculateOrderTotal', 'computeOrderTotals')).toBe(1);
  });

  it('scores unrelated names at zero', () => {
    expect(nameSimilarity('SendInvoiceEmail', 'ParseCsvHeader')).toBe(0);
  });

  // Overlap, not Jaccard: one name containing the other's meaning is a strong
  // signal that Jaccard would punish for the extra word.
  it('rewards one name containing the other', () => {
    expect(nameSimilarity('SendInvoiceEmail', 'DispatchEmail')).toBeGreaterThan(0.9);
  });

  it('returns zero when a name reduces to nothing', () => {
    expect(nameSimilarity('get', 'set')).toBe(0);
  });
});

describe('normalizeSignature', () => {
  it('reads a C# declaration', () => {
    const out = normalizeSignature('public async Task<decimal> Total(Order order, bool taxes)');

    expect(out.arity).toBe(2);
    expect(out.types).toEqual(['order', 'bool']);
    expect(out.returns).toBe('task<decimal>');
  });

  it('reads a TypeScript declaration', () => {
    const out = normalizeSignature('export function total(order: Order, taxes: boolean): number');

    expect(out.arity).toBe(2);
    expect(out.types).toEqual(['order', 'boolean']);
    expect(out.returns).toBe('number');
  });

  it('keeps a generic argument list as one parameter', () => {
    expect(normalizeSignature('void Go(Dictionary<string, int> map)').arity).toBe(1);
  });
});

describe('signatureSimilarity', () => {
  it('rules out a different arity outright', () => {
    expect(signatureSimilarity('int A(int x)', 'int B(int x, int y)')).toBe(0);
  });

  it('scores an identical shape at one', () => {
    expect(signatureSimilarity('public decimal A(Order o)', 'public decimal B(Order o)')).toBe(1);
  });

  // An untyped JavaScript parameter is an absence of evidence, not evidence of
  // difference. Scoring it as a mismatch would zero out every JS pair.
  it('does not punish untyped parameters', () => {
    expect(signatureSimilarity('function a(x)', 'function b(y)')).toBeGreaterThan(0.5);
  });
});

const LOOP_A = `public decimal CalculateTotal(Order order)
{
    decimal total = 0;
    foreach (var line in order.Lines)
    {
        total += line.Price * line.Quantity;
    }
    return total;
}`;

const LOOP_B = `public decimal ComputeSum(Invoice invoice)
{
    decimal acumulado = 0;
    foreach (var item in invoice.Items)
    {
        acumulado += item.Amount * item.Count;
    }
    return acumulado;
}`;

const UNRELATED = `public string Slugify(string input)
{
    if (input == null) { throw new ArgumentNullException(); }
    return input.ToLower().Replace(" ", "-");
}`;

describe('normalizeBody', () => {
  it('erases identifiers, literals and comments but keeps control flow', () => {
    const tokens = normalizeBody('// comentario\nif (miVariable > 42) { return "texto"; }');

    expect(tokens).toContain('if');
    expect(tokens).toContain('return');
    expect(tokens).not.toContain('miVariable');
    expect(tokens.join(' ')).not.toContain('42');
    expect(tokens.join(' ')).not.toContain('comentario');
  });
});

// The strippers are not linear on hostile input: a comment opener with nothing
// closing it scans to the end of the string, and so does every escaped quote.
// A body is other people's source, so its size is theirs to choose.
describe('normalizeBody under hostile input', () => {
  it('reads a bounded prefix of one enormous line', () => {
    const tokens = normalizeBody('/* '.repeat(200_000));

    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.length).toBeLessThanOrEqual(20_000);
  });

  it('finishes promptly on a body full of unclosed quotes', () => {
    const started = Date.now();
    normalizeBody('\\"'.repeat(200_000));

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('bodySimilarity', () => {
  // The finding the other two signals cannot make: renamed everything, same work.
  it('sees the same routine under different names', () => {
    expect(bodySimilarity(LOOP_A, LOOP_B)).toBeGreaterThan(0.8);
  });

  it('separates genuinely different work', () => {
    expect(bodySimilarity(LOOP_A, UNRELATED)).toBeLessThan(0.3);
  });

  // A two-line accessor matches every other two-line accessor in the repository.
  it('refuses to judge bodies too short to have a shape', () => {
    expect(bodySimilarity('return x;', 'return y;')).toBe(0);
  });
});

const symbol = (over = {}) => ({
  name: 'CalculateTotal',
  kind: 'method',
  path: 'src/New.cs',
  line: 10,
  signature: 'public decimal CalculateTotal(Order order)',
  body: LOOP_A,
  ...over,
});

describe('scorePair', () => {
  it('clears the threshold for a renamed copy', () => {
    const out = scorePair(
      symbol(),
      symbol({
        name: 'ComputeSum',
        path: 'src/Old.cs',
        line: 5,
        signature: 'public decimal ComputeSum(Invoice invoice)',
        body: LOOP_B,
      }),
    );

    expect(out.score).toBeGreaterThan(DEFAULT_THRESHOLD);
  });

  // The length bounds must not move a single number. These are the four this
  // pair produced before they existed.
  it('scores a realistic pair exactly as it did before the bounds', () => {
    const out = scorePair(
      symbol(),
      symbol({
        name: 'ComputeSum',
        path: 'src/Old.cs',
        line: 5,
        signature: 'public decimal ComputeSum(Invoice invoice)',
        body: LOOP_B,
      }),
    );

    expect(out.name).toBe(1);
    expect(out.body).toBe(1);
    expect(out.signature).toBeCloseTo(0.6, 10);
    expect(out.score).toBe(1);
  });

  it('stays below the threshold for unrelated work', () => {
    const out = scorePair(
      symbol(),
      symbol({
        name: 'Slugify',
        path: 'src/Text.cs',
        line: 3,
        signature: 'public string Slugify(string input)',
        body: UNRELATED,
      }),
    );

    expect(out.score).toBeLessThan(DEFAULT_THRESHOLD);
  });
});

describe('findDuplicates', () => {
  it('does not match a symbol against itself', () => {
    const me = symbol();

    expect(findDuplicates({ symbols: [me], index: [me] })).toEqual([]);
  });

  it('reports the existing symbol a new one replicates', () => {
    const existing = symbol({
      name: 'ComputeSum',
      path: 'src/Old.cs',
      line: 5,
      signature: 'public decimal ComputeSum(Invoice invoice)',
      body: LOOP_B,
    });

    const [finding] = findDuplicates({ symbols: [symbol()], index: [symbol(), existing] });

    expect(finding.symbol.name).toBe('CalculateTotal');
    expect(finding.matches[0].candidate.path).toBe('src/Old.cs');
  });

  it('caps the candidates it offers per symbol', () => {
    const index = Array.from({ length: 12 }, (_, i) =>
      symbol({ name: `ComputeSum${i}`, path: `src/Old${i}.cs`, line: i + 1, body: LOOP_B }),
    );

    const [finding] = findDuplicates({ symbols: [symbol()], index, maxCandidates: 5 });

    expect(finding.matches).toHaveLength(5);
  });
});

describe('exclusions', () => {
  it.each([
    'src/Migrations/20240101_Init.cs',
    'database/migrations/2024_01_01_create.php',
    'src/api.generated.ts',
    'src/Model.Designer.cs',
    'dist/bundle.js',
    'types/global.d.ts',
  ])('leaves %s out', (path) => {
    expect(isExcludedPath(path)).toBe(true);
  });

  it.each(['src/Service.cs', 'app/Http/Controllers/OrderController.php'])(
    'keeps %s in',
    (path) => {
      expect(isExcludedPath(path)).toBe(false);
    },
  );

  // Named with kind 'method' on purpose: otherwise the kind rule below would
  // exclude them anyway and these name patterns would go untested.
  it.each([
    { name: 'OrderDto', kind: 'method', path: 'src/Dtos.cs' },
    { name: 'OrderMapper', kind: 'method', path: 'src/Map.cs' },
    { name: 'CreateOrderRequest', kind: 'method', path: 'src/Requests.cs' },
    { name: 'AppSettings', kind: 'method', path: 'src/Config.cs' },
  ])('leaves $name out: repetition there is the pattern', (sym) => {
    expect(isExcludedSymbol(sym)).toBe(true);
  });

  // A class is compared through a bounded window of its first lines, so two
  // service classes look alike whatever they do. When one genuinely duplicates
  // another, its methods say so — with a body each and an actionable location.
  it.each(['class', 'interface', 'enum', 'component'])('does not compare a %s', (kind) => {
    expect(isExcludedSymbol({ name: 'OrderService', kind, path: 'src/A.cs' })).toBe(true);
  });

  it.each(['method', 'function'])('compares a %s', (kind) => {
    expect(isExcludedSymbol({ name: 'CalculateTotal', kind, path: 'src/A.cs' })).toBe(false);
  });

  it('filters a list from both sides of the comparison', () => {
    const kept = applyExclusions([symbol(), { name: 'OrderDto', kind: 'method', path: 'src/D.cs' }]);

    expect(kept.map((s) => s.name)).toEqual(['CalculateTotal']);
  });
});

// The pre-filter exists so the pair loop is not quadratic over the whole index.
// It has to be arithmetic rather than a heuristic: the finding this check exists
// to make is the renamed copy, where the name and signature signals are both 0
// and only the body says anything.
describe('the pre-filter never costs a real finding', () => {
  it('still finds a renamed copy with nothing else in common', () => {
    const introduced = symbol({
      name: 'CalculateOrderTotal',
      path: 'src/New.cs',
      signature: 'public decimal CalculateOrderTotal(Order order)',
      body: LOOP_A,
    });
    // Different name, different parameter type, same routine.
    const existing = symbol({
      name: 'Slugificar',
      path: 'src/Old.cs',
      line: 5,
      signature: 'public decimal Slugificar(Invoice invoice)',
      body: LOOP_B,
    });

    const [finding] = findDuplicates({ symbols: [introduced], index: [existing] });

    expect(finding?.matches[0].candidate.path).toBe('src/Old.cs');
  });

  it('keeps a pair that shares only a name token', () => {
    const introduced = symbol({ name: 'SendInvoiceEmail', body: 'a();', signature: 'void SendInvoiceEmail()' });
    const existing = symbol({
      name: 'SendEmail',
      path: 'src/Old.cs',
      line: 9,
      body: 'a();',
      signature: 'void SendEmail()',
    });

    expect(scorePair(introduced, existing).name).toBeGreaterThan(0.9);
  });

  it('drops a pair no scoring could have saved', () => {
    const introduced = symbol({
      name: 'CalculateTotal',
      signature: 'decimal CalculateTotal(Order o)',
      body: LOOP_A,
    });
    // No shared token, different arity, and a body far too small for the ratio to
    // reach the body-only floor.
    const tiny = symbol({
      name: 'Slugify',
      path: 'src/Text.cs',
      line: 3,
      signature: 'string Slugify(string a, string b)',
      body: 'return 1;',
    });

    expect(findDuplicates({ symbols: [introduced], index: [tiny] })).toEqual([]);
  });
});
