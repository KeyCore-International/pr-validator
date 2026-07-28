// Bundle entry for the `report` composite action.

import { main } from '../report.mjs';

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`::error::pr-validator report crashed: ${err?.stack ?? err}`);
    process.exit(1);
  });
