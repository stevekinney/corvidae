import { afterEach } from 'bun:test';

import { systemClock } from '../session/session-clock.ts';
import type {
  AttachmentGrant,
  SessionAttachment,
  SessionBudgets,
} from '../session/session-types.ts';
import { Recorder, SESSION_ID, expectAttached } from '../session/session.test-support.ts';
import { Session } from '../session/session.ts';
import type { OutputMode } from './fixtures/terminal-output.ts';
import { createPipeProcess } from './pipe-process.ts';
import type { HostedProcess, ProcessHostOptions, ProcessProfile } from './process-types.ts';
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

/** Register once per file: after each test, end every session and clean up every process it opened. */
export function registerSessionCleanup(): void {
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.dispose()));
    await Promise.all(hostedProcesses.splice(0).map((hosted) => hosted.backend.cleanup()));
  });
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
  extra: ProcessHostOptions & { acceptsInput?: boolean; columns?: number; rows?: number } = {},
): HostedProcess {
  const { acceptsInput, columns, rows, ...hostOptions } = extra;
  const options = { terminationGraceMilliseconds: 100, ...hostOptions };
  return mode === 'pipe'
    ? createPipeProcess({ profile, acceptsInput: acceptsInput === true, ...options })
    : createPtyProcess({
        profile,
        dimensions: { columns: columns ?? 80, rows: rows ?? 24 },
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
