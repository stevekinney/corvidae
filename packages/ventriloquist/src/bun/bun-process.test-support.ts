import { outcomeOf, rethrow, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import { afterAll, test } from 'bun:test';

import { systemClock } from '../session/session-clock.ts';
import type {
  AttachmentGrant,
  SessionAttachment,
  SessionBudgets,
} from '../session/session-types.ts';
import { expectAttached, Recorder, SESSION_ID } from '../session/session.test-support.ts';
import { Session } from '../session/session.ts';
import type { OutputMode } from './fixtures/terminal-output.ts';
import { createPipeProcess } from './pipe-process.ts';
import type { HostedProcess, ProcessHostOptions, ProcessProfile } from './process-types.ts';
import type { MasterWrite } from './pty-master.ts';
import { createPtyProcess } from './pty-process.ts';

type Channel = 'pty' | 'stdout' | 'stderr';

type OutputWatcher = {
  readonly channel: Channel;
  readonly needle: string | RegExp;
  readonly resolve: () => void;
};

export type HostedRun = {
  readonly session: Session;
  readonly recorder: Recorder;
  readonly attachment: SessionAttachment;
  /** Resolves when the session has started the process, the same promise the exit report waits on. */
  readonly started: Promise<void>;
  /** Resolves when the process exit has been reported to the session. */
  readonly exitReported: Promise<void>;
  /** Resolves once the text of `channel` so far contains or matches `needle`. It never polls and never sleeps. */
  waitForOutput(channel: Channel, needle: string | RegExp): Promise<void>;
};

const sessions: Session[] = [];
const hostedProcesses: HostedProcess[] = [];

async function disposeTracked(): Promise<void> {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(hostedProcesses.splice(0).map((hosted) => hosted.backend.cleanup()));
}

/** The scenarios run one after another, so the sessions and processes they track never overlap. */
let scenarioQueue: Promise<unknown> = Promise.resolve();

/**
 * Define a test whose body starts real processes. Bun gives a test body five seconds, and a child's
 * boot spends that on a loaded host, so the body runs at module scope instead, where no per-test
 * clock applies, and the test only rethrows what it recorded (`outcomeOf` fails a body that never
 * settles after `SCENARIO_HANG_GUARD_MILLISECONDS`). Scenarios run in definition order, and every
 * session and process the body tracked is cleaned up when it ends. Call `settleScenarios` with
 * top-level `await` at the end of the file.
 *
 * Bun runs a `describe` callback after the module body, so a scenario defined inside one starts
 * after that `await` has returned, and its test begins while the scenario is still running. The
 * test therefore waits for its scenario, and that wait is bounded by the hang guard (the scenario is
 * itself abandoned after it), not by Bun's five seconds: the five seconds are for work done in the
 * test, and none is. The scenarios of tests a name filter did not select still run, so
 * `settleScenarios` also registers a file hook that waits for all of them and their cleanup before
 * the run may end.
 */
export function scenarioTest(name: string, body: () => Promise<void> | void): void {
  const outcome = scenarioQueue.then(() =>
    outcomeOf(async () => {
      try {
        await body();
      } finally {
        await disposeTracked();
      }
    }),
  );
  scenarioQueue = outcome;
  test(name, async () => rethrow(await outcome), SCENARIO_TEST_TIMEOUT_MILLISECONDS);
}

/** The hang guard plus the turns the rethrow needs, so the guard, not Bun's clock, ends a hung scenario. */
const SCENARIO_TEST_TIMEOUT_MILLISECONDS = SCENARIO_HANG_GUARD_MILLISECONDS + 10_000;

/** Wait until the queue stops growing: a scenario can be defined while an earlier one runs. */
async function drainScenarios(): Promise<void> {
  let last: Promise<unknown>;
  do {
    last = scenarioQueue;
    await last;
  } while (last !== scenarioQueue);
}

/** Wait for every scenario defined so far; `await` it at module scope after the last definition. */
export async function settleScenarios(): Promise<void> {
  afterAll(drainScenarios, SCENARIO_TEST_TIMEOUT_MILLISECONDS);
  await scenarioQueue;
}

/** Make sure a process a test drives by hand, without a session, is cleaned up when the test ends. */
export function trackHostedProcess(hosted: HostedProcess): HostedProcess {
  hostedProcesses.push(hosted);
  return hosted;
}

/** The bytes the session delivered on one channel, in order, with nothing decoded. */
export function bytesOnChannel(recorder: Recorder, channel: Channel): Uint8Array {
  const chunks = recorder
    .ofType('output')
    .filter((event) => event.channel === channel)
    .map((event) => event.bytes);
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** The channel a mode's output arrives on. */
export function channelOf(mode: OutputMode): Channel {
  return mode === 'pipe' ? 'stdout' : 'pty';
}

/** Create the process for `mode`. The grace is short so a test that needs KILL does not wait for it. */
export function hostFor(
  mode: OutputMode,
  profile: ProcessProfile,
  extra: ProcessHostOptions & {
    acceptsInput?: boolean;
    columns?: number;
    rows?: number;
    writeMaster?: MasterWrite;
  } = {},
): HostedProcess {
  const { acceptsInput, columns, rows, writeMaster, ...hostOptions } = extra;
  const options = { terminationGraceMilliseconds: 100, ...hostOptions };
  return mode === 'pipe'
    ? createPipeProcess({ profile, acceptsInput: acceptsInput === true, ...options })
    : createPtyProcess({
        profile,
        dimensions: { columns: columns ?? 80, rows: rows ?? 24 },
        ...(writeMaster === undefined ? {} : { writeMaster }),
        ...options,
      });
}

/** Connect a hosted process to a real session and attach to it, the way a host would. */
export function runHosted(
  hosted: HostedProcess,
  options: {
    readonly columns?: number;
    readonly rows?: number;
    readonly grant?: AttachmentGrant;
    readonly budgets?: Partial<SessionBudgets>;
    /** Report each chunk parsed as it arrives. Turn it off to model a consumer that never parses. */
    readonly parseOutput?: boolean;
  } = {},
): HostedRun {
  const session = new Session({
    sessionId: SESSION_ID,
    profile: { profileId: 'bun-fixture' },
    dimensions: { columns: options.columns ?? 80, rows: options.rows ?? 24 },
    clock: systemClock,
    sources: hosted.sources,
    backend: hosted.backend,
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
  });
  sessions.push(session);
  const recorder = new Recorder();
  const watchers: OutputWatcher[] = [];
  const settleWatchers = (): void => {
    for (const watcher of watchers.splice(0)) {
      const text = textOf(bytesOnChannel(recorder, watcher.channel));
      if (
        typeof watcher.needle === 'string'
          ? text.includes(watcher.needle)
          : watcher.needle.test(text)
      ) {
        watcher.resolve();
      } else {
        watchers.push(watcher);
      }
    }
  };
  let attachment: SessionAttachment | undefined;
  attachment = expectAttached(
    session.attach({
      requestedMode: 'interactive',
      grant: options.grant ?? 'interactive',
      listener: (event) => {
        void recorder.listener(event);
        if (event.type !== 'output') return;
        if (options.parseOutput !== false) attachment?.outputParsed(event.chunkId);
        settleWatchers();
      },
    }),
  );
  return {
    session,
    recorder,
    attachment,
    started: session.start(),
    exitReported: hosted.reportExitTo(session),
    waitForOutput: (channel, needle) =>
      new Promise((resolve) => {
        watchers.push({ channel, needle, resolve });
        settleWatchers();
      }),
  };
}

/** Whether a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a process that something else is ending to disappear. */
export async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400 && isAlive(pid); attempt += 1) await Bun.sleep(5);
  if (isAlive(pid)) throw new Error(`process ${pid} is still running`);
}
