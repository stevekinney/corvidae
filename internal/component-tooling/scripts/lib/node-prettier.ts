/**
 * Prettier's Node build, whatever conditions the process runs under.
 *
 * Cinder's unit tests run with `--conditions browser`, under which `import 'prettier'` resolves to
 * the standalone browser build: it has no `resolveConfig` and no plugin loading, so a generator a
 * test calls cannot format the way the checked-in files are formatted. Prettier's `exports` lists
 * `require` before `browser`, so requiring it always reaches `index.cjs`, the full Node build.
 */

import { createRequire } from 'node:module';

import type * as Prettier from 'prettier';

const require = createRequire(import.meta.url);

export const prettier = require('prettier') as typeof Prettier;
