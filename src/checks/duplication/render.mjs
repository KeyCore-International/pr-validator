// Duplication check: does this change reimplement something the repository has?
//
// Two passes, like `tests`, and for the same reason. The deterministic one
// indexes the repository and scores every new symbol against it; only pairs
// that clear the threshold reach the model. Without it, answering this question
// would mean shipping the whole repository to a model on every pull request.
//
// The prompt carries the paired bodies rather than the diff. The existing half
// of a pair is by definition NOT in the diff — it is the code that was already
// there — so the diff would be the one thing that cannot answer the question.

import promptTemplate from './prompt.md?raw';
import config from './config.json';
import { cell, codeFence, header, inlineValue, label, outputFormat, text, untrustedBlock } from '../shared.mjs';

export const meta = {
  name: 'duplication',
  title: 'Duplicación de lógica',
  contextNeeds: ['diff', 'duplication'],
  requiresCode: true,
};

export { config };

const JSON_SHAPE =
  '{"overall":"PASS"|"FAIL","summary":"...","findings":[{"symbol":"...","location":"path:line",' +
  '"existing":"...","existingLocation":"path:line","verdict":"duplicate"|"similar"|"unrelated","recommendation":"..."}]}';

const INSTRUCTION =
  'One entry per pair given below, keeping both names and both locations. Set overall "FAIL" if any ' +
  'pair is "duplicate", else "PASS".';

/** How much of a body to show. Enough to judge, bounded so a long method cannot eat the prompt. */
const MAX_BODY_CHARS = 1200;

/** Pairs per prompt. Beyond this the reader stops reading, and so does the model. */
const MAX_PAIRS = 8;

function bodyOf(symbol) {
  const body = String(symbol.body || symbol.signature || '').trim();
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n// [...truncated]` : body;
}

/** `name (kind) — path:line`, each part flattened to one line. */
function describe(symbol) {
  return (
    `${inlineValue(symbol.name, 120)} (${inlineValue(symbol.kind, 30)}) — ` +
    `${inlineValue(symbol.path, 200)}:${Number(symbol.line) || 0}`
  );
}

/** The shortlist, each pair with both bodies side by side. */
function pairsSection(findings) {
  const blocks = [];
  let index = 0;

  for (const finding of findings) {
    for (const match of finding.matches) {
      if (index >= MAX_PAIRS) break;
      index += 1;

      const origin = match.introducedHere
        ? 'Both symbols are introduced by THIS pull request.'
        : 'The second symbol already existed in the repository.';

      // Names, kinds and paths come out of the reviewed tree, so they are
      // author-written too: a newline in one would add lines to this enumeration
      // that read as the tool's own. The bodies get a fence long enough that no
      // backtick run inside them can close it.
      blocks.push(
        [
          `### Pair ${index} — similarity ${match.score.toFixed(2)} ` +
            `(name ${match.signals.name.toFixed(2)}, signature ${match.signals.signature.toFixed(2)}, body ${match.signals.body.toFixed(2)})`,
          origin,
          '',
          `New: ${describe(finding.symbol)}`,
          codeFence(bodyOf(finding.symbol)),
          '',
          `Existing: ${describe(match.candidate)}`,
          codeFence(bodyOf(match.candidate)),
        ].join('\n'),
      );
    }
  }

  return `## Candidate pairs\n\n${blocks.join('\n\n')}`;
}

export function buildPrompt(ctx) {
  const { diff, base, head, repo, taskId, duplication, task, taskRef } = ctx;

  if (!duplication?.findings?.length) {
    throw new Error('duplication check needs at least one candidate pair to judge');
  }

  const prompt = [
    header({ taskId, head, base, repo, task, source: taskRef?.source }),
    `Indexed symbols: ${duplication.indexed}${duplication.indexTruncated ? ' (index truncated)' : ''}. ` +
      `Introduced by this pull request: ${duplication.introduced}.`,
    '',
    pairsSection(duplication.findings),
    '',
    untrustedBlock(
      'Pull request title and description',
      [ctx.prTitle, ctx.prBody].filter(Boolean).join('\n\n'),
    ),
    '',
    `## Diff stat (${base}...${head})\n${diff?.stat || '(no changes)'}`,
    '',
    outputFormat(JSON_SHAPE, INSTRUCTION),
  ]
    .filter((part) => part !== '')
    .join('\n');

  return { system: promptTemplate, prompt };
}

export function accept(parsed) {
  return Array.isArray(parsed?.findings);
}

export function render(parsed, ctx = {}) {
  if (!accept(parsed)) return null;

  const items = parsed.findings;
  const failOn = ctx.config?.failOn ?? config.failOn;
  const duplicates = items.filter((item) => failOn.includes(item.verdict));

  const rows = items.map((item, index) => ({
    id: `D${index + 1}`,
    label: cell(`${item.symbol} ↔ ${item.existing}`, 70),
    verdict: label(item.verdict),
    evidence: cell(`${item.location} ↔ ${item.existingLocation}`, 90),
  }));

  // Only actual duplicates get prose. A pair the model cleared is information
  // the developer has no action for, and printing it invites arguing with the
  // ones it did flag.
  const details = duplicates.map((item, index) => ({
    id: `D${index + 1}`,
    heading: `${cell(item.symbol, 60)} (${cell(item.location, 60)}) ↔ ${cell(item.existing, 60)} (${cell(item.existingLocation, 60)})`,
    body: text(item.recommendation, 400),
  }));

  return {
    rows,
    details,
    overall: parsed.overall === 'FAIL' || duplicates.length > 0 ? 'FAIL' : 'PASS',
    counts: { total: items.length, duplicates: duplicates.length },
    emptyMessage: 'Nada de lo que introduce el PR replica lógica que ya exista en el repositorio.',
  };
}
