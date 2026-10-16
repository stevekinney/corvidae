import { outcomeOf, rethrow } from '@lostgradient/testing';
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

/** A scenario that has been started at module scope, and what it recorded. */
export type Scenario = {
  readonly name: string;
  /** Resolves with what the body recorded: `undefined` when it passed, the error when it did not. */
  readonly outcome: Promise<unknown>;
  /** Whether the body and its cleanup have finished. */
  readonly settled: () => boolean;
};

/** The test files whose `settleScenarios` has returned, by path: module evaluation of each is over. */
const settledFiles = new Set<string>();

/** The path of the first stack frame outside this module, which is the test file calling in. */
function callingFile(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  const paths = frames.map(
    (frame) => /\(?((?:file:\/\/)?\/[^():]+?)(?::\d+){1,2}\)?$/.exec(frame.trim())?.[1],
  );
  return (
    paths.find((path) => path !== undefined && !path.endsWith('bun-process.test-support.ts')) ?? ''
  );
}

/**
 * Start a scenario: a body that starts real processes. Bun gives a test body five seconds, and a
 * child's boot spends that on a loaded host, so the body runs at module scope, where no per-test
 * clock applies, and its test (`scenarioResult`) only reports what it recorded. `outcomeOf` fails a
 * body that never settles after `SCENARIO_HANG_GUARD_MILLISECONDS`. Scenarios run one after another
 * in definition order, and every session and process the body tracked is cleaned up when it ends.
 *
 * It must be called at module scope, before the file's `await settleScenarios()`. Bun runs a
 * `describe` callback after the module body, so a scenario started inside one would start after
 * that `await` returned and run while its test was already waiting on Bun's clock. That is refused:
 * start the scenario at module scope and register its test inside the `describe`.
 */
export function scenario(name: string, body: () => Promise<void> | void): Scenario {
  const file = callingFile();
  if (settledFiles.has(file)) {
    throw new Error(
      `scenario "${name}" was started after settleScenarios() returned (inside a describe callback?): ` +
        'start scenarios at module scope and register their tests inside the describe with scenarioResult',
    );
  }
  let finished = false;
  const outcome = scenarioQueue.then(() =>
    outcomeOf(async () => {
      try {
        await body();
      } finally {
        await disposeTracked();
        finished = true;
      }
    }),
  );
  scenarioQueue = outcome;
  return { name, outcome, settled: () => finished };
}

/** Fail loudly if a scenario is still running: its test must never be the one waiting for it. */
export function expectSettled(started: Scenario): void {
  if (!started.settled()) {
    throw new Error(`scenario "${started.name}" had not settled when its test began`);
  }
}

/**
 * Register the test that reports a scenario. It runs after every module-scope scenario of its file
 * has settled, so it waits on nothing and the per-test clock covers no process work; it fails
 * loudly if that ever stops being true.
 */
export function scenarioResult(name: string, started: Scenario): void {
  test(name, async () => {
    expectSettled(started);
    rethrow(await started.outcome);
  });
}

/** A scenario and its test together, for a file that defines both at module scope. */
export function scenarioTest(name: string, body: () => Promise<void> | void): void {
  scenarioResult(name, scenario(name, body));
}

/** Wait until the queue stops growing: a scenario can be defined while an earlier one runs. */
async function drainScenarios(): Promise<void> {
  let last: Promise<unknown>;
  do {
    last = scenarioQueue;
    await last;
  } while (last !== scenarioQueue);
}

/**
 * Wait for every scenario defined so far; `await` it at module scope after the last definition. It
 * ends the file's module-scope phase: a scenario started afterwards is refused. A file hook also
 * waits for the whole queue, so no run, however its tests are selected, ends with a scenario in flight.
 */
export async function settleScenarios(): Promise<void> {
  settledFiles.add(callingFile());
  afterAll(drainScenarios);
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
