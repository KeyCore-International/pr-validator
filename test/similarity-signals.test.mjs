import { describe, expect, it } from 'vitest';
import { LEXICON_SIZE, nameSimilarity, tokenize } from '../src/similarity/name.mjs';
import {
  bodySimilarity,
  buildDocumentFrequency,
  IDF_MIN_DOCUMENTS,
  normalizeBody,
  shingleWeight,
  shingles,
  totalWeight,
  vocabulary,
  weightedJaccard,
} from '../src/similarity/body.mjs';
import {
  DEFAULT_THRESHOLD,
  documentFrequencyFor,
  findDuplicates,
  findHomonyms,
  bodyTail,
  hasEnoughBody,
  minTokensFor,
  scorePair,
} from '../src/similarity/score.mjs';
import { compileAllowPairs, isAllowedPair, isExcludedPath } from '../src/similarity/exclusions.mjs';

// ---------------------------------------------------------------------------
// Fixtures from real cases, inlined and anonymised.
// ---------------------------------------------------------------------------

// Two exported date helpers in one file that differ only in the separator of
// the template literal. Literals are erased from the skeleton, so the bodies
// are the same routine.
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

const DATE_SLASHED = DATE_DASHED.replace('formatDateToDDMMYYYY', 'formatDateWithSlash').replace(
  '`${day}-${month}-${year}`',
  '`${day}/${month}/${year}`',
);

// The same exported name in two helper files, doing different things: one
// formats through a date library with a configurable format, the other by hand
// with hours and minutes.
const FORMAT_DATE_LIBRARY = `export const formatDate = (date: string, withTime: boolean = false, format: string = 'DD/MM/YYYY'): string => {
  if (withTime) {
    return moment(date).format(\`\${format} HH:mm:ss\`)
  }
  return moment(date).format(format)
}`;

const FORMAT_DATE_MANUAL = `export const formatDate = (date: string | Date | null | undefined): string => {
  if (!date) return '-';

  try {
    const dateObj = date instanceof Date ? date : new Date(date);

    if (isNaN(dateObj.getTime())) {
      return '-';
    }

    const day = dateObj.getDate().toString().padStart(2, '0');
    const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const year = dateObj.getFullYear();
    const hours = dateObj.getHours().toString().padStart(2, '0');
    const minutes = dateObj.getMinutes().toString().padStart(2, '0');

    return \`\${day}-\${month}-\${year} \${hours}:\${minutes}\`;
  } catch (e) {
    console.error("Error formatting date:", e);
    return '-';
  }
};`;

// Inner functions of two composables, no semicolons: the same currency
// formatter, one with a null guard.
const CURRENCY_GUARDED = `  function formatCurrency(value: number | null): string {
    if (value == null) return '—'
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value)
  }`;

const CURRENCY_PLAIN = `  function formatCurrency(value: number): string {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value)
  }`;

// A C# private method copied into another class, renamed into Spanish.
const DISCOUNT_EN = `private static decimal ApplyDiscount(decimal subtotal, Customer customer)
{
    if (customer.IsPreferred && subtotal > customer.Threshold)
    {
        return Math.Round(subtotal * (1 - customer.DiscountRate), 2);
    }
    return subtotal;
}`;

const DISCOUNT_ES = `private static decimal AplicarDescuento(decimal monto, Customer cliente)
{
    if (cliente.IsPreferred && monto > cliente.Threshold)
    {
        return Math.Round(monto * (1 - cliente.DiscountRate), 2);
    }
    return monto;
}`;

// A NestJS service method copied into a second service.
const ACTIVE_BY_TENANT = `  async findActiveByTenant(tenantId: string): Promise<Listing[]> {
    const rows = await this.listingRepository.find({
      where: { tenantId, status: ListingStatus.Active },
      order: { updatedAt: 'DESC' },
    });
    return rows.filter((row) => row.publishedAt !== null);
  }`;

const ACTIVE_BY_AGENCY = `  async listActiveForAgency(agencyId: string): Promise<Listing[]> {
    const items = await this.listingRepository.find({
      where: { tenantId: agencyId, status: ListingStatus.Active },
      order: { updatedAt: 'DESC' },
    });
    return items.filter((item) => item.publishedAt !== null);
  }`;

const sym = (over) => ({ kind: 'function', line: 1, exported: true, signature: '', ...over });

/** The declaration line, which is what the extractors store as the signature. */
const firstLine = (body) => body.trim().split('\n')[0];

// ---------------------------------------------------------------------------

describe('the bilingual lexicon', () => {
  it('knows enough words to matter', () => {
    expect(LEXICON_SIZE).toBeGreaterThanOrEqual(150);
  });

  it.each([
    ['formatearFecha', ['format', 'date']],
    ['calcularTotales', ['compute', 'sum']],
    ['obtenerUsuarios', ['user']],
    ['validarCorreo', ['validate', 'email']],
    ['buscarDirecciones', ['search', 'address']],
    ['fechaDeInicio', ['date', 'start']],
    ['calcularÁreaDelLote', ['compute', 'area', 'lote']],
  ])('reads %s in canonical English', (name, expected) => {
    expect(tokenize(name)).toEqual(expected);
  });

  it.each([
    ['formatearFecha', 'formatDate'],
    ['obtenerUsuarios', 'getUsers'],
    ['calcularMontoTotal', 'computeTotalAmount'],
    ['eliminarArchivos', 'deleteFile'],
    ['enviarCorreo', 'sendEmail'],
  ])('matches %s with %s', (spanish, english) => {
    expect(nameSimilarity(spanish, english)).toBe(1);
  });

  // The stemmer promises one thing: both forms of a word get the same answer.
  it.each([
    ['direccion', 'direcciones'],
    ['ciudad', 'ciudades'],
    ['perfil', 'perfiles'],
    ['file', 'files'],
    ['store', 'stores'],
    ['role', 'roles'],
    ['rol', 'roles'],
    ['case', 'cases'],
    ['address', 'addresses'],
    ['status', 'statuses'],
    ['cause', 'causes'],
  ])('gives %s and %s the same stem', (singular, plural) => {
    expect(tokenize(singular)).toEqual(tokenize(plural));
  });

  it('drops Spanish stop-words like their English twins', () => {
    expect(tokenize('obtenerElNombreDelUsuario').sort()).toEqual(tokenize('getUserName').sort());
  });

  it('still keeps English names apart', () => {
    expect(nameSimilarity('SendInvoiceEmail', 'ParseCsvHeader')).toBe(0);
  });
});

describe('vocabulary', () => {
  it('collects members, callees, constructors and known globals', () => {
    const words = vocabulary(CURRENCY_PLAIN, { exclude: ['formatCurrency'] });

    expect([...words].sort()).toEqual(['format', 'intl', 'intl.numberformat', 'numberformat']);
  });

  it('leaves local variables and the symbol’s own name out', () => {
    const words = vocabulary(DATE_DASHED, { exclude: ['formatDateToDDMMYYYY'] });

    expect(words.has('dateobj')).toBe(false);
    expect(words.has('formatdatetoddmmyyyy')).toBe(false);
    expect(words.has('padstart')).toBe(true);
    expect(words.has('getfullyear')).toBe(true);
  });

  it('meets across C# and TypeScript casing', () => {
    expect(vocabulary('return string.Join(",", parts);').has('join')).toBe(true);
    expect(vocabulary('return parts.join(",");').has('join')).toBe(true);
    expect(vocabulary('return string.Join(",", parts);').has('string.join')).toBe(true);
  });

  it('ignores what is inside strings and comments', () => {
    expect([...vocabulary('// moment().format()\nreturn "Math.round(x)";')]).toEqual([]);
  });
});

describe('IDF weighting', () => {
  const boilerplate = 'if (a) { return b; } return c;';

  it('counts each function once per shingle', () => {
    const table = buildDocumentFrequency([{ body: LOOP }, { body: LOOP }, { body: '' }]);

    expect(table.documents).toBe(2);
    expect(Math.max(...table.counts.values())).toBe(2);
  });

  it('weighs every shingle 1 in a small index', () => {
    const table = buildDocumentFrequency(Array.from({ length: IDF_MIN_DOCUMENTS - 1 }, () => ({ body: LOOP })));
    const [first] = shingles(normalizeBody(LOOP));

    expect(shingleWeight(first, table)).toBe(1);
  });

  it('down-weighs a shingle most functions share, never one only the pair shares', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ body: `${boilerplate} x${i}();` }));
    const table = buildDocumentFrequency([...many, { body: LOOP }, { body: LOOP }]);
    const [common] = shingles(normalizeBody(boilerplate));
    const [rare] = shingles(normalizeBody(LOOP));

    expect(shingleWeight(common, table)).toBeLessThan(0.1);
    expect(shingleWeight(rare, table)).toBe(1);
  });

  it('lowers the score of two bodies alike only in boilerplate', () => {
    const left = `${boilerplate} if (q) { w(); }`;
    const right = `${boilerplate} while (z) { k = k + 1; }`;
    const many = Array.from({ length: 40 }, (_, i) => ({ body: `${boilerplate} x${i}();` }));
    const table = buildDocumentFrequency([...many, { body: left }, { body: right }]);

    expect(bodySimilarity(left, right, table)).toBeLessThan(bodySimilarity(left, right));
  });

  // The pre-filter relies on this bound; it has to hold for any table.
  it('stays under the ratio of the two total weights', () => {
    const random = mulberry32(7);
    const pool = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const pick = () => new Set(pool.filter(() => random() < 0.4));
    const docs = Array.from({ length: 60 }, pick);
    const table = { documents: docs.length, counts: new Map() };
    for (const doc of docs) for (const s of doc) table.counts.set(s, (table.counts.get(s) ?? 0) + 1);

    for (let i = 0; i < 200; i += 1) {
      const a = pick();
      const b = pick();
      if (!a.size || !b.size) continue;
      const wa = totalWeight(a, table);
      const wb = totalWeight(b, table);
      expect(weightedJaccard(a, b, table)).toBeLessThanOrEqual(Math.min(wa, wb) / Math.max(wa, wb) + 1e-12);
    }
  });
});

describe('the four-signal score', () => {
  it('scores formatearFecha against formatDate with the same body as a duplicate', () => {
    const english = sym({ name: 'formatDate', path: 'src/utils/date.ts', body: DATE_DASHED.replace('formatDateToDDMMYYYY', 'formatDate') });
    const spanish = sym({ name: 'formatearFecha', path: 'src/helpers/fechas.ts', body: DATE_DASHED.replace('formatDateToDDMMYYYY', 'formatearFecha') });
    english.signature = firstLine(english.body);
    spanish.signature = firstLine(spanish.body);

    const out = scorePair(spanish, english);

    expect(out.name).toBe(1);
    expect(out.body).toBe(1);
    expect(out.vocabulary).toBe(1);
    expect(out.score).toBe(1);
  });

  it('finds the separator-only pair', () => {
    const dashed = sym({ name: 'formatDateToDDMMYYYY', path: 'src/helpers/dateHelper.ts', body: DATE_DASHED, line: 4 });
    const slashed = sym({ name: 'formatDateWithSlash', path: 'src/helpers/dateHelper.ts', body: DATE_SLASHED, line: 54 });
    dashed.signature = firstLine(DATE_DASHED);
    slashed.signature = firstLine(DATE_SLASHED);

    const [finding] = findDuplicates({ symbols: [slashed], index: [dashed, slashed] });

    expect(finding.matches[0].candidate.name).toBe('formatDateToDDMMYYYY');
    expect(finding.matches[0].signals.body).toBe(1);
    expect(finding.matches[0].score).toBe(1);
  });

  it('finds the currency formatter copied between two composables', () => {
    const guarded = sym({
      name: 'formatCurrency',
      path: 'composables/usePropertyHelpers.ts',
      line: 17,
      exported: false,
      container: 'usePropertyHelpers',
      signature: firstLine(CURRENCY_GUARDED),
      body: CURRENCY_GUARDED,
    });
    const plain = sym({
      name: 'formatCurrency',
      path: 'composables/useSchemaOrg.ts',
      line: 152,
      exported: false,
      container: 'useSchemaOrgProperty',
      signature: firstLine(CURRENCY_PLAIN),
      body: CURRENCY_PLAIN,
    });

    const [finding] = findDuplicates({ symbols: [plain], index: [guarded, plain] });

    expect(finding.matches[0].candidate.path).toBe('composables/usePropertyHelpers.ts');
    expect(finding.matches[0].score).toBeGreaterThanOrEqual(0.7);
  });

  it('finds a C# private method copied and renamed into Spanish', () => {
    const original = sym({ name: 'ApplyDiscount', kind: 'method', exported: false, path: 'src/Pricing/OrderPricer.cs', signature: firstLine(DISCOUNT_EN), body: DISCOUNT_EN });
    const copy = sym({ name: 'AplicarDescuento', kind: 'method', exported: false, path: 'src/Billing/InvoiceBuilder.cs', signature: firstLine(DISCOUNT_ES), body: DISCOUNT_ES });

    const out = scorePair(copy, original);

    expect(out.name).toBe(1);
    expect(out.score).toBeGreaterThanOrEqual(0.9);
  });

  it('finds a service method copied into another service', () => {
    const original = sym({ name: 'findActiveByTenant', kind: 'method', path: 'src/listings/listings.service.ts', signature: firstLine(ACTIVE_BY_TENANT), body: ACTIVE_BY_TENANT });
    const copy = sym({ name: 'listActiveForAgency', kind: 'method', path: 'src/agencies/agencies.service.ts', signature: firstLine(ACTIVE_BY_AGENCY), body: ACTIVE_BY_AGENCY });

    const [finding] = findDuplicates({ symbols: [copy], index: [original, copy] });

    expect(finding.matches[0].candidate.name).toBe('findActiveByTenant');
  });

  // The floor needs the vocabulary to agree: the same control flow over
  // unrelated APIs is a coincidence of shape, not a copy.
  it('does not let a shared skeleton alone carry an unrelated pair', () => {
    const sums = sym({ name: 'sumLines', signature: 'sumLines(order, taxes)', body: LOOP, path: 'src/a.ts' });
    const retries = sym({ name: 'countRetries', signature: 'countRetries(job)', body: LOOP_OTHER_VOCABULARY, path: 'src/b.ts' });

    const out = scorePair(sums, retries);

    expect(out.body).toBeGreaterThanOrEqual(0.8);
    expect(out.vocabulary).toBe(0);
    expect(out.score).toBeLessThan(DEFAULT_THRESHOLD);
    expect(findDuplicates({ symbols: [sums], index: [retries] })).toEqual([]);
  });

  it('lets the skeleton carry a pair that calls nothing at all', () => {
    const body = (name) => `function ${name}(a, b) {\n  if (a > b) {\n    return a - b;\n  } else {\n    return b - a;\n  }\n}`;
    const left = sym({ name: 'distance', signature: 'distance(a, b)', body: body('distance'), path: 'src/a.ts' });
    const right = sym({ name: 'gap', signature: 'gap(x, y, z)', body: body('gap'), path: 'src/b.ts' });

    expect(scorePair(left, right).score).toBe(1);
  });

  it('needs a longer body from a private function than from an exported one', () => {
    // 14 skeleton tokens: above the exported minimum, below the private one.
    const short = 'function f(a) {\n  return a.b + 1;\n}';
    const exported = sym({ name: 'f', body: short, path: 'src/a.ts' });
    const inner = sym({ name: 'f', body: short, path: 'src/b.ts', exported: false });

    expect(scorePair(exported, { ...exported, path: 'src/c.ts' }).body).toBe(1);
    expect(scorePair(inner, { ...inner, path: 'src/c.ts' }).body).toBe(0);
  });

  // The scorer and the duplication context share one definition of public: a
  // public method is public whether or not it sits in a class.
  it('holds a public class method to the exported floor', () => {
    const body = 'public int Twice(int x) { return x * 2 + 1; }';
    const free = sym({ name: 'Twice', body, path: 'src/A.cs', scope: 'public', container: null });
    const member = sym({ name: 'Twice', body, path: 'src/B.cs', scope: 'public', container: 'Svc' });

    expect(scorePair(free, { ...free, path: 'src/C.cs' })).toMatchObject({ body: 1, score: 1 });
    expect(scorePair(member, { ...member, path: 'src/C.cs', container: 'Other' })).toMatchObject({ body: 1, score: 1 });
    expect(minTokensFor(member)).toBe(minTokensFor(free));
    expect(hasEnoughBody(member)).toBe(true);
  });

  it('measures the private floor past the declaration head', () => {
    const handler = sym({
      name: 'handleStatusFailed',
      body: 'const handleStatusFailed = (): void => { statusFailed.value = true; };',
      exported: false,
      scope: 'inner',
      container: 'useStatus',
    });
    expect(normalizeBody(handler.body).length).toBeGreaterThanOrEqual(16);
    expect(bodyTail(normalizeBody(handler.body)).length).toBeLessThan(16);
    expect(hasEnoughBody(handler)).toBe(false);
  });

  it('skips a pair the repository allowed', () => {
    const dashed = sym({ name: 'formatDateToDDMMYYYY', path: 'src/helpers/dateHelper.ts', body: DATE_DASHED, line: 4 });
    const slashed = sym({ name: 'formatDateWithSlash', path: 'src/helpers/dateHelper.ts', body: DATE_SLASHED, line: 54 });

    const out = findDuplicates({
      symbols: [slashed],
      index: [dashed, slashed],
      allow: [['src/helpers/*.ts#formatDateWithSlash', '#formatDateToDDMMYYYY']],
    });

    expect(out).toEqual([]);
  });
});

// The pre-filter must never change a result: everything it skips must be a
// pair that scoring would have rejected. Checked against brute force on a
// generated corpus large enough for IDF weighting to be active.
describe('the pre-filter stays sound under the new weights and IDF', () => {
  it('reports exactly what brute-force scoring reports', () => {
    const random = mulberry32(42);
    const verbs = ['load', 'save', 'format', 'compute', 'send', 'parse', 'check', 'build'];
    const nouns = ['Order', 'Invoice', 'Date', 'User', 'Total', 'Line', 'Price', 'Tax'];
    const statements = [
      'if (a > b) { return a; }',
      'for (const x of xs) { t += x.price * x.qty; }',
      'const d = new Date(v); return d.toISOString();',
      'return items.filter((i) => i.ok).map((i) => i.id);',
      'try { send(m); } catch (e) { log(e); }',
      'while (n > 0) { n = n - 1; }',
      'return Math.round(v * 100) / 100;',
      'const r = await repo.find({ where: { id } }); return r;',
    ];
    const pick = (list) => list[Math.floor(random() * list.length)];

    const index = Array.from({ length: 60 }, (_, i) => {
      const name = `${pick(verbs)}${pick(nouns)}${i % 3 ? pick(nouns) : ''}`;
      const arity = 1 + Math.floor(random() * 3);
      const params = Array.from({ length: arity }, (_, k) => `p${k}`).join(', ');
      const lines = Array.from({ length: 2 + Math.floor(random() * 4) }, () => pick(statements));
      return sym({
        name,
        path: `src/m${i}.ts`,
        line: 1,
        signature: `function ${name}(${params})`,
        body: `function ${name}(${params}) {\n  ${lines.join('\n  ')}\n}`,
      });
    });

    const threshold = DEFAULT_THRESHOLD;
    const table = documentFrequencyFor(index);
    const reported = findDuplicates({ symbols: index, index, maxCandidates: 1_000, threshold });

    const fromFilter = new Set();
    for (const finding of reported) {
      for (const match of finding.matches) fromFilter.add(`${finding.symbol.path}|${match.candidate.path}`);
    }

    const brute = new Set();
    for (const a of index) {
      for (const b of index) {
        if (a === b) continue;
        if (scorePair(a, b, undefined, { table }).score >= threshold) brute.add(`${a.path}|${b.path}`);
      }
    }

    expect(table.documents).toBeGreaterThanOrEqual(IDF_MIN_DOCUMENTS);
    expect(brute.size).toBeGreaterThan(0);
    expect([...fromFilter].sort()).toEqual([...brute].sort());
  });
});

describe('findHomonyms', () => {
  const library = sym({ name: 'formatDate', path: 'src/helpers/date.ts', line: 17, body: FORMAT_DATE_LIBRARY, signature: firstLine(FORMAT_DATE_LIBRARY) });
  const manual = sym({ name: 'formatDate', path: 'src/helpers/dateHelper.ts', line: 29, body: FORMAT_DATE_MANUAL, signature: firstLine(FORMAT_DATE_MANUAL) });

  it('flags the same exported name doing different things in two files', () => {
    const [homonym, ...rest] = findHomonyms([library, manual]);

    expect(rest).toEqual([]);
    expect(homonym.kind).toBe('homonym');
    expect(homonym.name).toBe('formatDate');
    expect(homonym.body).toBeLessThan(0.5);
    expect([homonym.symbol.path, homonym.candidate.path].sort()).toEqual(['src/helpers/date.ts', 'src/helpers/dateHelper.ts']);
  });

  it('puts the touched symbol first', () => {
    const [homonym] = findHomonyms([library, manual], { symbols: [manual] });

    expect(homonym.symbol.path).toBe('src/helpers/dateHelper.ts');
  });

  it('only reports pairs involving the touched symbols when given', () => {
    const other = sym({ name: 'slugify', path: 'src/a.ts', body: 'function slugify(s) {\n  return s.trim().toLowerCase().replace(/ /g, "-");\n}' });
    const otherCopy = sym({ name: 'slugify', path: 'src/b.ts', body: 'function slugify(s) {\n  if (!s) { return ""; }\n  return encodeURIComponent(s);\n}' });

    expect(findHomonyms([library, manual, other, otherCopy], { symbols: [other] }).map((h) => h.name)).toEqual(['slugify']);
  });

  it('does not call a duplicate a homonym', () => {
    const copy = { ...manual, path: 'src/legacy/dateHelper.ts' };

    expect(findHomonyms([manual, copy])).toEqual([]);
  });

  it.each([
    ['in the same file', { path: 'src/helpers/date.ts' }],
    ['in a test file', { path: 'src/helpers/date.spec.ts' }],
    ['private, outside an auto-import folder', { exported: false }],
    ['an inner function', { container: 'useDates' }],
    ['an instance method', { kind: 'method' }],
  ])('leaves out a second definition %s', (_, over) => {
    expect(findHomonyms([library, { ...manual, ...over }])).toEqual([]);
  });

  it('keeps a static helper method', () => {
    expect(findHomonyms([library, { ...manual, kind: 'method', signature: 'public static string formatDate(string d)' }])).toHaveLength(1);
  });

  // Auto-import shares exports only, and a Vite repository has no shared
  // namespace at all: two module-private helpers never meet at a call site,
  // whatever folder they sit in.
  it('leaves out a module-private function, in an auto-import folder too', () => {
    expect(findHomonyms([library, { ...manual, exported: false, path: 'composables/dates.ts' }])).toEqual([]);
    expect(
      findHomonyms([
        { ...library, exported: false, path: 'src/composables/useDashboard.ts' },
        { ...manual, exported: false, path: 'src/composables/useSync.ts' },
      ]),
    ).toEqual([]);
  });

  it('ignores names frameworks make every file export', () => {
    const get = (path, body) => sym({ name: 'GET', path, body });

    expect(findHomonyms([get('app/api/a/route.ts', FORMAT_DATE_LIBRARY), get('app/api/b/route.ts', FORMAT_DATE_MANUAL)])).toEqual([]);
  });

  it('caps what it returns', () => {
    const index = Array.from({ length: 6 }, (_, i) => ({ ...(i % 2 ? library : manual), path: `src/h${i}.ts` }));

    expect(findHomonyms(index, { max: 2 })).toHaveLength(2);
  });
});

describe('exclusions added for local mode', () => {
  it.each([
    'src/components/Button.stories.tsx',
    'src/stories/Button.ts',
    'src/__mocks__/api.ts',
    'src/mocks/handlers.ts',
    'src/services/api.mock.ts',
    'tests-e2e/fixtures/orders.ts',
    'src/__fixtures__/orders.ts',
    'src/locales/es.ts',
    'src/Infrastructure/Persistence/AppDbContextModelSnapshot.cs',
    '.claude/skills/crud-frontend/references/contractType-composable.ts',
    '.agents/skills/vue/references/useThing.ts',
    'packages/web/.cursor/rules/example.ts',
    '.github/scripts/release.js',
  ])('leaves %s out', (path) => {
    expect(isExcludedPath(path)).toBe(true);
  });

  it.each(['src/services/mockup-viewer.ts', 'src/utils/locale.ts', 'src/stores/orders.ts', 'src/claude/client.ts', 'src/github.ts'])('keeps %s in', (path) => {
    expect(isExcludedPath(path)).toBe(false);
  });
});

describe('allow-pairs', () => {
  const a = { name: 'isEmail', path: 'src/server/validate.ts' };
  const b = { name: 'isEmail', path: 'src/client/validate.ts' };
  const c = { name: 'isEmail', path: 'src/other/validate.ts' };

  it.each([
    ['an array', [['src/server/validate.ts#isEmail', 'src/client/validate.ts#isEmail']]],
    ['an object with a and b', [{ a: 'src/server/**', b: 'src/client/**', reason: 'kept apart on purpose' }]],
    ['an object with a pair', [{ pair: ['src/server/*.ts', 'src/client/*.ts'] }]],
    ['a string', ['src/server/validate.ts#isEmail <-> src/client/validate.ts#isEmail']],
    ['names only', [['isEmail', '#isEmail']]],
  ])('reads %s, in either order', (_, entries) => {
    const allowed = compileAllowPairs(entries);

    expect(allowed(a, b)).toBe(true);
    expect(allowed(b, a)).toBe(true);
  });

  it('allows nothing it was not told about', () => {
    expect(isAllowedPair(a, c, [['src/server/**', 'src/client/**']])).toBe(false);
    expect(isAllowedPair(a, b, [])).toBe(false);
  });

  it('ignores entries it cannot read instead of failing', () => {
    expect(compileAllowPairs([null, 42, ['only-one'], {}, 'no separator'])(a, b)).toBe(false);
    expect(compileAllowPairs('not a list')(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const LOOP = `function sumLines(order, taxes) {
  let total = 0;
  for (const line of order.lines) {
    total += line.price * line.quantity;
  }
  return total;
}`;

// The same control flow over a different set of APIs.
const LOOP_OTHER_VOCABULARY = `function countRetries(job) {
  let attempts = 0;
  for (const run of job.history) {
    attempts += run.failures * run.weight;
  }
  return attempts;
}`;

/** Small deterministic PRNG, so generated cases are the same on every run. */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
