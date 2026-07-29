import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDuplicationContext } from '../src/context/duplication.mjs';
import { makeRepo } from './fixtures/repo.mjs';

let repo;
afterEach(() => repo?.cleanup());

const EXISTING = `namespace App;

public class InvoiceService
{
    public decimal ComputeSum(Invoice invoice)
    {
        decimal acumulado = 0;
        foreach (var item in invoice.Items)
        {
            acumulado += item.Amount * item.Count;
        }
        return acumulado;
    }
}
`;

const COPY = `namespace App;

public class OrderService
{
    public decimal CalculateTotal(Order order)
    {
        decimal total = 0;
        foreach (var line in order.Lines)
        {
            total += line.Price * line.Quantity;
        }
        return total;
    }
}
`;

const UNRELATED = `namespace App;

public class TextService
{
    public string Slugify(string input)
    {
        if (input == null)
        {
            throw new ArgumentNullException(nameof(input));
        }
        return input.ToLower().Replace(" ", "-");
    }
}
`;

function diffOf(dir) {
  return execFileSync('git', ['-C', dir, 'diff', 'base...feature'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe('buildDuplicationContext', () => {
  it('pairs a new symbol with the existing one it replicates', () => {
    repo = makeRepo({
      baseFiles: { 'src/InvoiceService.cs': EXISTING },
      featureFiles: { 'src/OrderService.cs': COPY },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.introduced).toBeGreaterThan(0);
    const finding = out.findings.find((f) => f.symbol.name === 'CalculateTotal');
    expect(finding).toBeDefined();
    expect(finding.matches[0].candidate.name).toBe('ComputeSum');
    expect(finding.matches[0].candidate.path).toBe('src/InvoiceService.cs');
  });

  it('finds nothing when the new code does different work', () => {
    repo = makeRepo({
      baseFiles: { 'src/InvoiceService.cs': EXISTING },
      featureFiles: { 'src/TextService.cs': UNRELATED },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.findings).toEqual([]);
  });

  // Both halves live in the same pull request. The index contains both, so the
  // pair falls out for free — what must not fall out is reporting it twice.
  it('reports an intra-PR pair once, marked as such', () => {
    repo = makeRepo({
      featureFiles: { 'src/OrderService.cs': COPY, 'src/InvoiceService.cs': EXISTING },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    const pairs = out.findings.flatMap((f) => f.matches);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].introducedHere).toBe(true);
  });

  // A migration looks like every other migration, and that IS the job.
  it('leaves migrations out of the comparison', () => {
    const migration = COPY.replace('OrderService', 'AddOrders').replace(
      'CalculateTotal',
      'Up',
    );

    repo = makeRepo({
      baseFiles: { 'src/Migrations/20240101_Init.cs': EXISTING },
      featureFiles: { 'src/Migrations/20240202_AddOrders.cs': migration },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.findings).toEqual([]);
  });

  it('has nothing to compare when the change adds no public symbols', () => {
    repo = makeRepo({
      baseFiles: { 'src/InvoiceService.cs': EXISTING },
      featureFiles: { 'README.md': '# fixture\n\nnota\n' },
    });

    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(out.introduced).toBe(0);
    expect(out.findings).toEqual([]);
  });
});
