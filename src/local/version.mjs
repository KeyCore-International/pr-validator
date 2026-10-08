// The engine version, read from package.json at build time. A named import, so
// the bundle carries this one field and not the whole manifest.

import { version } from '../../package.json';

export const ENGINE_VERSION = version;
