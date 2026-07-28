// Fail the build when a customer name, an internal product name or a local
// developer path reaches the tree.
//
// This tool was extracted from a private client repository into a public one.
// A leaked name here is public forever and cannot be taken back by deleting a
// commit, so this is a permanent gate rather than a one-time review.
//
// This file is excluded from its own scan: it necessarily contains every term
// it looks for. It is covered by CODEOWNERS instead.

import { execFileSync } from 'node:child_process';

/** Terms that must never appear in the public tree. */
const FORBIDDEN = [
  // Client and internal product names.
  'seguros',
  'segven',
  'venezuela',
  'corebit',
  'ApiDocManager',
  // Internal domains and package scopes.
  'key-core\\.',
  '@key-core',
  // Local developer paths that leak a machine layout.
  'C:\\\\Users',
  '/Users/[A-Za-z]',
  '/home/[a-z]+/',
];

/** Paths that legitimately cannot satisfy the rule, or are generated. */
const EXCLUDED = [
  ':!scripts/neutrality.mjs',
  ':!package-lock.json',
  ':!actions/*/dist/*',
];

const pattern = FORBIDDEN.join('|');

let output = '';
try {
  output = execFileSync('git', ['grep', '-nIiE', pattern, '--', '.', ...EXCLUDED], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  // git grep exits 1 with no output when there are no matches — the good case.
  if (err.status === 1 && !err.stdout) {
    console.log('Neutralidad OK: sin nombres de cliente ni rutas locales.');
    process.exit(0);
  }
  if (err.status !== 1) {
    console.error(`::error::no se pudo ejecutar git grep: ${err.message}`);
    process.exit(2);
  }
  output = err.stdout ?? '';
}

if (output.trim()) {
  console.error('::error::Referencias no neutrales en un repositorio público:');
  console.error(output.trim());
  process.exit(1);
}

console.log('Neutralidad OK: sin nombres de cliente ni rutas locales.');
