// The reusable workflow calls this repository's own composite actions, and it
// pins them by major tag. That pin has to match the major this release ships
// under.
//
// It did not once. The workflow was about to be published as v3 while still
// calling `actions/run-check@v2`, which would have run the previous release's
// bundles for every consumer — a whole major's worth of changes invisible, with
// nothing in the logs to say so. A stale pin is not a broken build; it is a
// working build of the wrong code, which is why it needs a gate rather than a
// note in the documentation.

import { readFileSync } from 'node:fs';

const WORKFLOW = '.github/workflows/pr-validation.yml';
const PIN = /uses:\s*KeyCore-International\/pr-validator\/([^@\s]+)@v(\d+)/g;

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const major = version.split('.')[0];
const workflow = readFileSync(WORKFLOW, 'utf8');

const problems = [];
let found = 0;

for (const [, path, pinned] of workflow.matchAll(PIN)) {
  found += 1;
  if (pinned !== major) {
    problems.push(`  ${path}@v${pinned}  ->  debería ser @v${major}`);
  }
}

if (!found) {
  console.error(`::error::${WORKFLOW} no referencia ninguna action propia. ¿Se renombraron?`);
  process.exit(1);
}

if (problems.length) {
  console.error(
    `::error::${WORKFLOW} fija actions de un major distinto al de package.json (${version}):\n${problems.join('\n')}\n` +
      'Publicado así, el consumidor ejecutaría los bundles del major anterior.',
  );
  process.exit(1);
}

console.log(`Pins correctos: ${found} referencia(s) a @v${major}.`);
