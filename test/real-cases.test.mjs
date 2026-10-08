// Real cases, end to end.
//
// Every fixture under `fixtures/real-cases/` is a minimal reproduction of a
// shape found in a real repository or missed by a real review: only the shape
// under test is kept, with neutral names and no source copied from anyone. They are stored as `.txt` so no
// tool that walks this repository mistakes them for its own source, and they
// are written into a throwaway git repository under their real extension, so
// what runs is the same diff → index → score path a pull request takes.
//
// The precision numbers asserted here are the reason the 4.5.0 scorer looks the
// way it does: if a weight or a floor moves, these are the cases that say
// whether it moved in the right direction.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { shortCircuit } from '../src/checks/short-circuit.mjs';
import { buildDuplicationContext } from '../src/context/duplication.mjs';
import { loadRules } from '../src/context/rules.mjs';
import { buildSymbolIndex } from '../src/context/symbol-index.mjs';
import { computeFacts } from '../src/local/facts.mjs';
import { makeRepo } from './fixtures/repo.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/real-cases/', import.meta.url));

/** A fixture as committed: LF line endings, whatever the checkout did to it. */
function fixture(path, { crlf = false } = {}) {
  const text = readFileSync(`${FIXTURES}${path}`, 'utf8').replace(/\r\n/g, '\n');
  return crlf ? text.replace(/\n/g, '\r\n') : text;
}

let repo;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function diffOf(dir) {
  return execFileSync('git', ['-C', dir, 'diff', 'base...feature'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Every reported pair, as `introduced->existing`. */
const pairsOf = (out) =>
  out.findings.flatMap((f) => f.matches.map((m) => `${f.symbol.name}->${m.candidate.name}`));

/** The match between two named symbols, in either direction. */
function matchBetween(out, a, b) {
  for (const finding of out.findings) {
    for (const match of finding.matches) {
      const names = [finding.symbol.name, match.candidate.name];
      if (names.includes(a) && names.includes(b) && a !== b) return { finding, match };
      if (a === b && names[0] === a && names[1] === b) return { finding, match };
    }
  }
  return null;
}

describe('date helpers: a separator-only copy and a homonym', () => {
  // `date.ts` existed; the change adds `dateHelper.ts`, which brings both a
  // second `formatDate` that formats differently and two functions that differ
  // only in the separator they join with.
  function dateRepo({ crlf = false } = {}) {
    return makeRepo({
      baseFiles: { 'src/helpers/date.ts': fixture('date-helpers/date.ts.txt', { crlf }) },
      featureFiles: { 'src/helpers/dateHelper.ts': fixture('date-helpers/dateHelper.ts.txt', { crlf }) },
    });
  }

  it('pairs formatDateToDDMMYYYY with formatDateWithSlash as duplicates', () => {
    repo = dateRepo();
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    const hit = matchBetween(out, 'formatDateToDDMMYYYY', 'formatDateWithSlash');
    expect(hit, pairsOf(out).join(', ')).not.toBeNull();
    expect(hit.match.score).toBeGreaterThanOrEqual(0.8);
    // Both sides arrive in the same change: the report says so.
    expect(hit.match.introducedHere).toBe(true);
  });

  it('reports the two formatDate helpers as a homonym, not as a duplicate', () => {
    repo = dateRepo();
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    const homonym = out.homonyms.find((pair) => pair.name === 'formatDate');
    expect(homonym).toBeDefined();
    expect(homonym.kind).toBe('homonym');
    // The touched one first: "yours vs the one that was already there".
    expect(homonym.symbol.path).toBe('src/helpers/dateHelper.ts');
    expect(homonym.candidate.path).toBe('src/helpers/date.ts');
    expect(homonym.body).toBeLessThan(0.5);

    const crossFile = out.findings.some(
      (f) =>
        f.symbol.name === 'formatDate' &&
        f.matches.some((m) => m.candidate.name === 'formatDate' && m.candidate.path !== f.symbol.path),
    );
    expect(crossFile).toBe(false);
  });

  it('finds the same pair and the homonym in a CRLF working tree', () => {
    repo = dateRepo({ crlf: true });
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(matchBetween(out, 'formatDateToDDMMYYYY', 'formatDateWithSlash')).not.toBeNull();
    expect(out.homonyms.map((pair) => pair.name)).toContain('formatDate');
  });
});

describe('currency formatter copied between two composables', () => {
  function currencyRepo() {
    return makeRepo({
      baseFiles: { 'composables/useStructuredData.ts': fixture('currency-composables/useStructuredData.ts.txt') },
      featureFiles: {
        'composables/useCatalogHelpers.ts': fixture('currency-composables/useCatalogHelpers.ts.txt'),
      },
    });
  }

  it('scores the inner formatCurrency copy at 0.7 or more', () => {
    repo = currencyRepo();
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    const finding = out.findings.find(
      (f) => f.symbol.name === 'formatCurrency' && f.symbol.path === 'composables/useCatalogHelpers.ts',
    );
    expect(finding, pairsOf(out).join(', ')).toBeDefined();
    expect(finding.symbol).toMatchObject({ scope: 'inner', container: 'useCatalogHelpers' });

    const top = finding.matches[0];
    expect(top.candidate).toMatchObject({ name: 'formatCurrency', path: 'composables/useStructuredData.ts' });
    expect(top.score).toBeGreaterThanOrEqual(0.7);
  });

  it('also finds the image resolver the change copied a third time', () => {
    repo = currencyRepo();
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toContain('resolveImage->resolveImage');
  });
});

describe('synthetic shapes a review missed', () => {
  it('pairs a Spanish rename with the English helper it copies', () => {
    repo = makeRepo({
      baseFiles: { 'src/utils/date.ts': fixture('spanish-rename/date.ts.txt') },
      featureFiles: { 'src/utils/fecha.ts': fixture('spanish-rename/fecha.ts.txt') },
    });
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    const hit = matchBetween(out, 'formatearFecha', 'formatDate');
    expect(hit, pairsOf(out).join(', ')).not.toBeNull();
    expect(hit.match.signals.name).toBeGreaterThan(0);
  });

  it('pairs a private C# method copied into another service', () => {
    repo = makeRepo({
      baseFiles: { 'src/Shop.Application/Services/OrderService.cs': fixture('csharp-private/OrderService.cs.txt') },
      featureFiles: {
        'src/Shop.Application/Services/QuoteService.cs': fixture('csharp-private/QuoteService.cs.txt'),
      },
    });
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    const finding = out.findings.find((f) => f.symbol.name === 'SumWithDiscount');
    expect(finding, pairsOf(out).join(', ')).toBeDefined();
    expect(finding.symbol.scope).toBe('private');
    expect(finding.matches[0].candidate.name).toBe('ApplyDiscounts');
  });

  it('pairs a NestJS service method copied into another service', () => {
    repo = makeRepo({
      baseFiles: { 'src/catalog/catalog.service.ts': fixture('nest-service/catalog.service.ts.txt') },
      featureFiles: { 'src/inventory/inventory.service.ts': fixture('nest-service/inventory.service.ts.txt') },
    });
    const out = buildDuplicationContext({ diffText: diffOf(repo.dir), repo: repo.dir });

    expect(pairsOf(out)).toContain('pageOfActive->listActive');
  });

  it('ends a no-semicolon arrow where its expression ends', () => {
    repo = makeRepo({ baseFiles: { 'src/money.ts': fixture('no-semicolon/money.ts.txt') } });
    const { symbols } = buildSymbolIndex({ repo: repo.dir });
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));

    expect(byName.toCents.span).toEqual([1, 2]);
    expect(byName.toCents.body).not.toContain('formatAmount');
    expect(byName.formatAmount.span).toEqual([4, 7]);
    expect(byName.formatAmount.body).toContain('.replace(');
    expect(byName.formatAmount.body).not.toContain('isNegative');
    expect(byName.isNegative.span).toEqual([9, 9]);
  });

  it('applies a paths: rule only to the files it names', () => {
    repo = makeRepo({ baseFiles: { '.claude/rules/frontend.md': fixture('paths-rule/frontend.md') } });
    const loaded = (touched) => loadRules({ repo: repo.dir, touched }).sources.map((s) => s.path);

    expect(loaded(['src/composables/useCart.ts'])).toContain('frontend.md');
    expect(loaded(['src/views/Home.vue'])).toContain('frontend.md');
    expect(loaded(['Api/Controllers/CartController.cs'])).not.toContain('frontend.md');
  });
});

// Each `facts` run builds the index, the duplication pass and the coverage
// cross over a real git repository; several in one test outgrow the default
// timeout when the whole suite runs in parallel.
describe('local facts carry the real cases', { timeout: 60_000 }, () => {
  // One branch with both real cases and a test suite, run through `facts` as a
  // developer would before pushing.
  function factsRepo() {
    return makeRepo({
      baseFiles: {
        'src/helpers/date.ts': fixture('date-helpers/date.ts.txt'),
        'composables/useStructuredData.ts': fixture('currency-composables/useStructuredData.ts.txt'),
        'src/components/PriceTag.vue': '<template>\n  <span class="price">{{ value }}</span>\n</template>\n',
        'tests/date.test.ts': "import { currentDate } from '../src/helpers/date'\n\ntest('today', () => currentDate())\n",
      },
      featureFiles: {
        'src/helpers/dateHelper.ts': fixture('date-helpers/dateHelper.ts.txt'),
        'composables/useCatalogHelpers.ts': fixture('currency-composables/useCatalogHelpers.ts.txt'),
        // Same markup as an existing component: a markup scanner's job, not this one's.
        'src/components/AmountTag.vue': '<template>\n  <span class="price">{{ value }}</span>\n</template>\n',
      },
    });
  }

  it('lists duplicates, homonyms and untested logic, with no source text and no markup', () => {
    repo = factsRepo();
    const { facts } = computeFacts({ repo: repo.dir, base: 'base' });

    const dup = facts.duplication;
    expect(dup.error).toBeUndefined();

    const pairs = dup.findings.flatMap((f) => f.matches.map((m) => [f.symbol.name, m.candidate.name].sort().join('~')));
    expect(pairs).toContain('formatDateToDDMMYYYY~formatDateWithSlash');
    expect(pairs).toContain('formatCurrency~formatCurrency');
    expect(dup.homonyms.map((pair) => pair.name)).toContain('formatDate');

    // Code only: no component pairs, no bodies or template skeletons.
    const kinds = dup.findings.flatMap((f) => [f.symbol.kind, ...f.matches.map((m) => m.candidate.kind)]);
    expect(kinds).not.toContain('component');
    const text = JSON.stringify(dup);
    expect(text).not.toContain('"body":"');
    expect(text).not.toContain('templateSkeleton');
    expect(text).not.toContain('padStart');

    const untested = facts.coverage.untestedLogic;
    expect(facts.coverage.orphans).toEqual(untested);
    const slash = untested.find((u) => u.name === 'formatDateWithSlash');
    expect(slash).toMatchObject({ path: 'src/helpers/dateHelper.ts', change: 'added' });
    expect(slash.endLine).toBeGreaterThan(slash.line);
    expect(slash.reasons.length).toBeGreaterThan(0);
  });

  it('writes the same facts twice', () => {
    repo = factsRepo();
    const first = JSON.stringify(computeFacts({ repo: repo.dir, base: 'base' }).facts);
    const second = JSON.stringify(computeFacts({ repo: repo.dir, base: 'base' }).facts);
    expect(second).toBe(first);
  });

  it('honours duplication.allow from the base branch and ignores one the branch adds', () => {
    const allow = JSON.stringify({
      checks: { duplication: { allow: ['src/helpers/dateHelper.ts#formatDateToDDMMYYYY <-> #formatDateWithSlash'] } },
    });
    const pairFound = (facts) =>
      facts.duplication.findings.some((f) =>
        f.matches.some(
          (m) =>
            [f.symbol.name, m.candidate.name].sort().join('~') === 'formatDateToDDMMYYYY~formatDateWithSlash',
        ),
      );

    repo = makeRepo({
      baseFiles: { 'src/helpers/date.ts': fixture('date-helpers/date.ts.txt') },
      featureFiles: {
        'src/helpers/dateHelper.ts': fixture('date-helpers/dateHelper.ts.txt'),
        '.pr-validator.json': allow,
      },
    });
    const fromHead = computeFacts({ repo: repo.dir, base: 'base' }).facts;
    expect(fromHead.duplication.allowPairs).toBe(0);
    expect(pairFound(fromHead)).toBe(true);
    repo.cleanup();

    repo = makeRepo({
      baseFiles: { 'src/helpers/date.ts': fixture('date-helpers/date.ts.txt'), '.pr-validator.json': allow },
      featureFiles: { 'src/helpers/dateHelper.ts': fixture('date-helpers/dateHelper.ts.txt') },
    });
    const fromBase = computeFacts({ repo: repo.dir, base: 'base' }).facts;
    expect(fromBase.duplication.allowPairs).toBe(1);
    expect(pairFound(fromBase)).toBe(false);
  });
});

describe('the tests check skip says why nothing was crossed', () => {
  const check = { meta: { title: 'Tests' } };
  const skip = (coverage) =>
    shortCircuit({ name: 'tests', check, inputs: {}, ctx: { coverage } }).notes[0];

  it('keeps the old reason when every symbol is mentioned', () => {
    expect(skip({ hasTestSuite: true, testFileCount: 3, orphans: [], covered: [{}], exempt: [] })).toContain(
      'ya aparecen en la suite',
    );
  });

  it('names the exempt symbols instead of claiming the suite mentions them', () => {
    const reason = skip({ hasTestSuite: true, testFileCount: 3, orphans: [], covered: [], exempt: [{}, {}] });
    expect(reason).not.toContain('ya aparecen en la suite');
    expect(reason).toContain('2 no tienen lógica');
  });
});
