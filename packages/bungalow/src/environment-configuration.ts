import type { BungalowEnvironment } from './resolve-root.ts';

/**
 * The process environment, which `openBungalow` reads by default for `<NAME>_HOME` and for
 * `NODE_ENV`. This is the only module in the package that touches `process.env`; everything else
 * receives an environment as a value, which is also how tests inject one.
 */
export function processEnvironment(): BungalowEnvironment {
  return process.env;
}
