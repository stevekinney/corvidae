import type { BungalowEnvironment } from '@lostgradient/bungalow';

/** The port the host listens on when `INTERBOROUGH_PORT` is not set. */
export const DEFAULT_PORT = 7234;

/** The environment variable that overrides {@link DEFAULT_PORT}. */
export const PORT_VARIABLE = 'INTERBOROUGH_PORT';

/**
 * The process environment, which the host reads for `INTERBOROUGH_HOME` (through Bungalow) and
 * for `INTERBOROUGH_PORT`. This is the only module in the application's source that touches
 * `process.env`; everything else receives an environment as a value, which is also how tests
 * inject one.
 */
export function processEnvironment(): BungalowEnvironment {
  return process.env;
}

/**
 * The port named by `INTERBOROUGH_PORT`, or {@link DEFAULT_PORT} when it is unset or empty. `0`
 * asks the operating system for a free port. Anything that is not a whole number from 0 to 65535
 * is an error rather than a silent fallback: a mistyped port that quietly became the default would
 * leave a second host on the wrong port.
 */
export function resolvePort(environment: BungalowEnvironment): number {
  const raw = environment[PORT_VARIABLE];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port > 65_535) {
    throw new Error(`${PORT_VARIABLE} must be a whole number from 0 to 65535 (got "${raw}").`);
  }
  return port;
}
