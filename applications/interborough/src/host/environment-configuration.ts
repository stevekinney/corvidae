import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BungalowEnvironment } from '@lostgradient/bungalow';

/** The port the host listens on when `INTERBOROUGH_PORT` is not set. */
export const DEFAULT_PORT = 7234;

/** The environment variable that overrides {@link DEFAULT_PORT}. */
export const PORT_VARIABLE = 'INTERBOROUGH_PORT';

/** Where `bun scripts/build.ts` writes the application: `build/` at the package root. */
export const DEFAULT_BUILD_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'build',
);

/** The environment variable that names the directory holding the built application, in place of `build/`. */
export const BUILD_DIRECTORY_VARIABLE = 'INTERBOROUGH_BUILD_DIRECTORY';

/**
 * The process environment, which the host reads for `INTERBOROUGH_HOME` (through Bungalow), for
 * `INTERBOROUGH_PORT`, for `INTERBOROUGH_BUILD_DIRECTORY`, and for `INTERBOROUGH_A2A_PUBLIC_ORIGIN`. This is the only module in the application's source that touches
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

/**
 * The directory the built application is served from: the one `INTERBOROUGH_BUILD_DIRECTORY` names
 * (a relative path is taken from the working directory), or {@link DEFAULT_BUILD_DIRECTORY} when
 * it is unset or empty. The entries (`serve.ts`, `dev.ts`) and the supervisor read the same
 * variable, so `start` checks for the build it will serve.
 */
export function resolveBuildDirectory(environment: BungalowEnvironment): string {
  const raw = environment[BUILD_DIRECTORY_VARIABLE];
  return raw === undefined || raw === '' ? DEFAULT_BUILD_DIRECTORY : resolve(raw);
}

/**
 * The environment variable that names the public origin a reverse proxy serves A2A at, such as
 * `https://agents.example.com` (COR-1904). Unset, A2A is reachable on loopback only.
 */
export const A2A_PUBLIC_ORIGIN_VARIABLE = 'INTERBOROUGH_A2A_PUBLIC_ORIGIN';

/**
 * The public origin `INTERBOROUGH_A2A_PUBLIC_ORIGIN` names, or `undefined` when it is unset or
 * empty. It must be an `https` origin and nothing more (no path, query, fragment, or user name),
 * because a remote A2A caller sends its key to it: a plain `http` origin would carry the key in
 * the clear, and a path would name an address the host does not serve. Anything else stops the
 * host rather than falling back to loopback in silence.
 */
export function resolveA2aPublicOrigin(environment: BungalowEnvironment): URL | undefined {
  const raw = environment[A2A_PUBLIC_ORIGIN_VARIABLE];
  if (raw === undefined || raw === '') return undefined;
  let parsed: URL | undefined;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = undefined;
  }
  if (
    parsed === undefined ||
    parsed.protocol !== 'https:' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(
      // The value is not echoed: unlike a port, a URL can carry a credential.
      `${A2A_PUBLIC_ORIGIN_VARIABLE} must be an https origin with no path, user name, or password, such as https://agents.example.com.`,
    );
  }
  return new URL(parsed.origin);
}
