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

/**
 * Only this file is excluded — it necessarily contains every term it hunts for.
 *
 * The bundles under actions/*&#47;dist are deliberately NOT excluded. They are
 * published content like any other file, and an earlier version of the build
 * embedded the author's absolute path into them; excluding generated output is
 * exactly how that reached a public repository unnoticed.
 */
const EXCLUDED = [':!scripts/neutrality.mjs'];

/** The committed bundles — the file class where the leak already happened once. */
const BUNDLE_GLOB = 'actions/*/dist/index.mjs';

/**
 * How git grep is told to treat files it considers binary.
 *
 * `.gitattributes` marks the committed bundles `-diff`, and git maps an unset
 * diff attribute to its built-in binary userdiff driver, so git grep skips them
 * as binary even though they hold no NUL byte. `--text` is what makes the scan
 * read them; `-I` would skip them again, and -I wins over -a whatever the order
 * on the command line, so it must not come back.
 *
 * The scan and the coverage probe below share this on purpose: drop `--text`
 * here and the probe stops seeing the bundles too, so the guard fails loudly
 * instead of the scan going quietly blind.
 */
const BINARY_POLICY = ['--text'];

/**
 * Prove the scan reached the committed bundles instead of assuming it did.
 *
 * Two independent mechanisms can drop exactly those files, and both are silent:
 * a pathspec exclusion takes them out of scope, and the binary handling above
 * makes git skip them. The second one is why this gate once printed
 * "Neutralidad OK" over a bundle carrying the author's absolute path.
 *
 * The probe reuses the scan's own pathspec and flags and matches any non-empty
 * line, so a bundle absent from its output was not scanned, whatever the cause.
 */
function assertBundlesScanned() {
  let listed = '';
  try {
    listed = execFileSync('git', ['ls-files', '--', BUNDLE_GLOB], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`::error::no se pudo listar los bundles commiteados: ${err.message}`);
    process.exit(2);
  }

  const bundles = listed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!bundles.length) {
    console.error(`::error::el escaneo de neutralidad no encontró ningún bundle en ${BUNDLE_GLOB}.`);
    console.error(
      'Este gate garantiza que los bundles commiteados se escanean. Si cambiaron de ' +
        'ruta, actualiza BUNDLE_GLOB en este script para que vuelva a comprobarlos.',
    );
    process.exit(2);
  }

  let probe = '';
  try {
    probe = execFileSync('git', ['grep', ...BINARY_POLICY, '-l', '-E', '.', '--', '.', ...EXCLUDED], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Exit 1 means the probe reached no file at all, which is itself a coverage
    // failure and is reported below. Any other status is a real git error.
    if (err.status !== 1) {
      console.error(`::error::no se pudo verificar la cobertura del escaneo: ${err.message}`);
      process.exit(2);
    }
    probe = err.stdout ?? '';
  }

  const covered = new Set(probe.split('\n').map((line) => line.trim()).filter(Boolean));
  const missing = bundles.filter((bundle) => !covered.has(bundle));
  if (missing.length) {
    console.error('::error::el escaneo de neutralidad no alcanzó estos bundles commiteados:');
    console.error(missing.join('\n'));
    console.error(
      'Son contenido publicado y tienen que escanearse. Causas habituales: se quitó ' +
        '--text de la llamada a git grep (git da los bundles por binarios debido al ' +
        '-diff de .gitattributes, aunque sean texto), o una exclusión nueva los dejó ' +
        'fuera. La solución es devolverles la cobertura, nunca excluirlos.',
    );
    process.exit(2);
  }
}

const pattern = FORBIDDEN.join('|');

// Verify the instrument before trusting its reading.
assertBundlesScanned();

let output = '';
try {
  // See BINARY_POLICY: without it the committed bundles are skipped as binary.
  output = execFileSync('git', ['grep', '-n', ...BINARY_POLICY, '-iE', pattern, '--', '.', ...EXCLUDED], {
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
