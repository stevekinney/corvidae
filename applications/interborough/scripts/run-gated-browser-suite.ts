/**
 * Runs Interborough's end-to-end Playwright suite (`tests/e2e`, the `chromium` project) the way the
 * batch validate gates it (`bun run test:browser:interborough` at the repository root, the last step
 * of `validate:batch`).
 *
 * Playwright reuses a server already listening on the end-to-end port outside CI, and on a shared
 * host that is often another checkout's build, or a design-review capture's, on the default port
 * 7399. A gate that screenshots someone else's tree proves nothing, so this script picks a block of
 * free consecutive ports (the suite holds seven, from `endToEndPort()`), exports the first as
 * `INTERBOROUGH_E2E_PORT`, and sets `INTERBOROUGH_E2E_FRESH_SERVER`, which makes
 * `playwright.config.ts` refuse to reuse a server at all. `INTERBOROUGH_E2E_PORT` set by the caller
 * is honored, but only when its whole block is free; otherwise the run exits 2 instead of
 * substituting another.
 *
 * Every argument is passed on to `playwright test`, so `--grep` narrows a run. The exit code is
 * Playwright's, so a failing case fails the batch. 2 means no free block of ports.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exitCodeOnMemoryRefusal, withHostSlots } from '../../../scripts/host-slots.ts';
import { portIsFree, underHostSlots } from './design-review-capture.ts';
import { END_TO_END_PORT_COUNT, endToEndPortOverride } from './environment-configuration.ts';

const applicationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Ports below this are for well-known services, and the operating system hands ephemeral ports from 49152. */
const SEARCH_START = 20_000;
const SEARCH_END = 45_000;
const SEARCH_ATTEMPTS = 50;

/** Whether `count` consecutive ports from `first` are all free. */
export function blockIsFree(
  first: number,
  count: number,
  isFree: (port: number) => boolean,
): boolean {
  for (let offset = 0; offset < count; offset += 1) {
    if (!isFree(first + offset)) return false;
  }
  return true;
}

/**
 * The first port of a block of `count` free consecutive ports, or `undefined` after
 * `SEARCH_ATTEMPTS` random tries. `random` answers a number in [0, 1).
 */
export function findFreePortBlock(
  count: number,
  isFree: (port: number) => boolean,
  random: () => number = Math.random,
): number | undefined {
  const span = SEARCH_END - SEARCH_START - count;
  for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt += 1) {
    const first = SEARCH_START + Math.floor(random() * span);
    if (blockIsFree(first, count, isFree)) return first;
  }
  return undefined;
}

/** What the run needs from the host, so a test can stand in for Playwright and the port probe. */
export interface GatedRunEnvironment {
  readonly standardError: (text: string) => void;
  readonly portIsFree: (port: number) => boolean;
  readonly requestedPort: number | undefined;
  /** Runs the command with the variables added to the process environment and answers its exit code. */
  readonly run: (command: readonly string[], variables: Record<string, string>) => Promise<number>;
}

/** The host the command line runs on: the real port probe and a real child process. */
export const hostEnvironment: GatedRunEnvironment = {
  standardError: process.stderr.write.bind(process.stderr),
  portIsFree,
  get requestedPort() {
    return endToEndPortOverride();
  },
  async run(command, variables) {
    const child = Bun.spawn([...command], {
      cwd: applicationDirectory,
      env: { ...process.env, ...variables },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    return child.exited;
  },
};

/** Runs the suite on a free port block and answers the exit code. */
export async function runGatedBrowserSuite(
  argv: readonly string[] = process.argv.slice(2),
  environment: GatedRunEnvironment = hostEnvironment,
): Promise<number> {
  let first = environment.requestedPort;
  if (first === undefined) {
    first = findFreePortBlock(END_TO_END_PORT_COUNT, environment.portIsFree);
    if (first === undefined) {
      environment.standardError(
        `gated browser suite: no block of ${END_TO_END_PORT_COUNT} free consecutive ports found in ${SEARCH_START}-${SEARCH_END}.\n`,
      );
      return 2;
    }
  } else if (!blockIsFree(first, END_TO_END_PORT_COUNT, environment.portIsFree)) {
    environment.standardError(
      `gated browser suite: INTERBOROUGH_E2E_PORT=${first} is not a free block of ${END_TO_END_PORT_COUNT} consecutive ports, and the gate never reuses a server on them.\n`,
    );
    return 2;
  }
  return environment.run(
    [
      'bun',
      '--bun',
      'playwright',
      'test',
      '--config',
      'playwright.config.ts',
      '--project=chromium',
      ...argv,
    ],
    { INTERBOROUGH_E2E_PORT: String(first), INTERBOROUGH_E2E_FRESH_SERVER: '1' },
  );
}

// The suite runs one Playwright worker (`playwright.config.ts`), so one browser at a time: one host
// slot, taken whether this script runs under the host lock (`test:browser:interborough`) or
// directly, as an agent runs one end-to-end spec, after the host is checked for memory.
if (import.meta.main) {
  process.exitCode = await exitCodeOnMemoryRefusal(
    withHostSlots(1, (slots) =>
      runGatedBrowserSuite(process.argv.slice(2), underHostSlots(hostEnvironment, slots)),
    ),
  );
}
