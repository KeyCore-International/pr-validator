// Bundle entry for the local mode (`dist/local/pr-local.mjs`).
//
// One file, two uses: run it with node and it is the CLI; import it and it is a
// library of the engine's deterministic functions. The CLI only starts when this
// file is the script node was asked to run.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../local/cli.mjs';

export * from '../local/lib.mjs';

/** Compared case-insensitively on Windows, where the drive letter's case varies. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(process.argv[1]);
    return process.platform === 'win32'
      ? self.toLowerCase() === invoked.toLowerCase()
      : self === invoked;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // Reaching here means a bug in the CLI itself; `main` maps every known failure.
      console.error(`pr-local crashed: ${err?.stack ?? err}`);
      process.exitCode = 1;
    });
}
