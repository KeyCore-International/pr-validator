// Bundle entry for the `resolve-checks` composite action.
// Kept separate from src/resolve-checks.mjs so that module stays importable by
// tests without executing anything.

import { main } from '../resolve-checks.mjs';

try {
  process.exit(main());
} catch (err) {
  // Reaching here means a bug in the validator itself.
  console.error(`::error::pr-validator crashed resolving checks: ${err?.stack ?? err}`);
  process.exit(2);
}
