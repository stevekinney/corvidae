/**
 * Runs Interborough's end-to-end Playwright suite (`tests/e2e`, the `chromium` project) the way a
 * browser gate runs it (`bun run test:browser:interborough` at the repository root).
 *
 * Playwright reuses a server already listening on the end-to-end port outside CI, and on a shared
 * host that is often another checkout's build, or a design-review capture's, on the default port
 * 7399. A gate that screenshots someone else's tree proves nothing, so this script picks a block of
 * free consecutive ports (the suite holds eight, from `endToEndPort()`), exports the first as
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

import { withHostSlots, withMemoryAdmission } from '../../../scripts/host-slots.ts';
import { portIsFree, underHostSlots } from './design-review-capture.ts';
import { END_TO_END_PORT_COUNT, endToEndPortOverride } from './environment-configuration.ts';

const applicationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ports below this are for well-known services. The search stays under 32768, where Linux starts
 * handing out ephemeral ports (macOS starts at 49152): a block chosen above it can lose a port to an
 * outgoing connection between the probe and the server's listen (COR-2412, EADDRINUSE on CI).
 */
const SEARCH_START = 20_000;
const SEARCH_END = 32_000;
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
  attempt = 0,
): Promise<number> {
  const argumentsList = [...argv];
  const requestedPort = environment.requestedPort;
  let first = requestedPort;
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
  environment.standardError(
    `gated browser suite: starting on ports ${String(first)}-${String(first + END_TO_END_PORT_COUNT - 1)}.\n`,
  );
  const result = await environment.run(
    ['bun', 'scripts/run-gated-browser-suite.ts', '--playwright-child', ...argumentsList],
    { INTERBOROUGH_E2E_PORT: String(first), INTERBOROUGH_E2E_FRESH_SERVER: '1' },
  );
  if (result === 73 && requestedPort === undefined && attempt + 1 < SEARCH_ATTEMPTS) {
    environment.standardError(
      'gated browser suite: a port was occupied during startup; retrying with a fresh block.\n',
    );
    return runGatedBrowserSuite(argumentsList, environment, attempt + 1);
  }
  if (result === 73) {
    environment.standardError(
      'gated browser suite: a port was occupied during startup; release the occupied port or choose another INTERBOROUGH_E2E_PORT.\n',
    );
  }
  return result;
}

export function scanCollisionOutput(
  tail: string,
  text: string,
): { tail: string; collision: boolean } {
  const combined = tail + text;
  return {
    tail: combined.slice(-512),
    collision: combined.includes('INTERBOROUGH_E2E_STARTUP_BIND_COLLISION'),
  };
}

async function runPlaywrightChild(argv: readonly string[]): Promise<number> {
  const child = Bun.spawn(
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
    { cwd: applicationDirectory, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let collision = false;
  const forward = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    let tail = '';
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      const scanned = scanCollisionOutput(tail, text);
      tail = scanned.tail;
      collision ||= scanned.collision;
      target.write(text);
    }
  };
  const [code] = await Promise.all([
    child.exited,
    forward(child.stdout, process.stdout),
    forward(child.stderr, process.stderr),
  ]);
  return code !== 0 && collision ? 73 : code;
}

// The suite runs one Playwright worker (`playwright.config.ts`), so one browser at a time: one host
// slot, taken whether this script runs under the host lock (`test:browser:interborough`) or
// directly, as an agent runs one end-to-end spec, after the host is checked for memory.
if (import.meta.main) {
  process.exitCode =
    process.argv[2] === '--playwright-child'
      ? await runPlaywrightChild(process.argv.slice(3))
      : await withMemoryAdmission(() =>
          withHostSlots(1, (slots) =>
            runGatedBrowserSuite(process.argv.slice(2), underHostSlots(hostEnvironment, slots)),
          ),
        );
}
