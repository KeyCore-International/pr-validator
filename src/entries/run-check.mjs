// Bundle entry for the `run-check` composite action.
// Kept separate from src/run-check.mjs so that module stays importable by
// tests without executing anything.

import { main } from '../run-check.mjs';

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Reaching here means a bug in the validator itself, not a check failure.
    console.error(`::error::pr-validator crashed: ${err?.stack ?? err}`);
    process.exit(2);
  });
