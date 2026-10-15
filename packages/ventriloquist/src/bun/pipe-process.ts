import type { ProcessBackend } from '../session/session-types.ts';
import { attempt, combineOutcomes } from '../session/settle.ts';
import { BoundedByteFeed, ByteBudget } from './bounded-byte-feed.ts';
import {
  assembleHostedProcess,
  createOwnedProcess,
  resolveHostSettings,
  spawnOwnedProcess,
} from './hosted-process.ts';
import { ProcessStartFailure } from './process-start-failure.ts';
import type { HostedProcess, PipeProcessOptions } from './process-types.ts';
import { snapshotProfile, validateProcessProfile } from './process-validation.ts';

/** The writable end of a child's stdin, as Bun's `FileSink` offers it. */
type InputSink = {
  write(bytes: Uint8Array): number | Promise<number>;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
};

type OutputReader = ReadableStreamDefaultReader<Uint8Array>;

/**
 * Read a child's output pipe into a feed until it ends. The pipe exposes no pause or resume, so
 * the feed's bound is what limits unread output. The reader's lock is released as soon as pumping
 * ends, whether the pipe ended, failed or was canceled. While it is pumping, the returned stop
 * function is held in `active`, so it can be stopped from outside; once pumping has ended it is
 * dropped from there, and calling it later does nothing. Stopping cancels the pipe and waits for
 * the pump to finish, and is safe to call any number of times.
 */
function pumpPipe(
  stream: ReadableStream<Uint8Array>,
  feed: BoundedByteFeed,
  active: Set<() => Promise<void>>,
): void {
  const reader: OutputReader = stream.getReader();
  let ended = false;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      if (ended) return;
      // A cancel that fails leaves the read pending, and the lock with it: that is reported, not waited out.
      await reader.cancel();
      await pumping;
    })());
  active.add(stop);
  const pumping: Promise<void> = (async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        feed.push(result.value);
      }
      feed.end();
    } catch (error) {
      feed.fail(error);
    } finally {
      ended = true;
      reader.releaseLock();
      active.delete(stop);
    }
  })();
}

/**
 * Create a pipe process: `Bun.spawn` with piped stdio, run as its own process group. Standard
 * output and standard error are two separate owned sources tagged `stdout` and `stderr`, so
 * partial escape sequences from one channel can never be spliced into the other, and nothing is
 * decoded or split on the way. Standard input exists only when `acceptsInput` is set; otherwise
 * the process reads an empty input and the session advertises none. A pipe has no terminal: it
 * offers no resize, and it never becomes a PTY.
 *
 * Nothing is spawned until the session starts the backend.
 */
export function createPipeProcess(options: PipeProcessOptions): HostedProcess {
  // The copy is what is validated and what later spawns, whatever the caller does to its own object.
  const profile = snapshotProfile(options.profile);
  validateProcessProfile(profile);
  const settings = resolveHostSettings(options);
  const acceptsInput = options.acceptsInput === true;
  const owned = createOwnedProcess(settings);
  let startFailure: ProcessStartFailure | undefined;
  let input: InputSink | undefined;
  const pumps = new Set<() => Promise<void>>();
  const stopPumps = async (): Promise<void> => {
    await Promise.all([...pumps].map((stop) => stop()));
  };
  // Output that overflowed while nothing was reading it is no longer being kept, so the child that
  // produces it is ended rather than left to run on with its output discarded.
  const onOverflow = (): void => {
    void attempt(stopPumps);
    void owned.terminate();
  };
  // One budget for both channels, so the cap is per process and not per channel.
  const budget = new ByteBudget(settings.maximumBufferedOutputBytes);
  const feeds = {
    stdout: new BoundedByteFeed(budget, stopPumps, onOverflow),
    stderr: new BoundedByteFeed(budget, stopPumps, onOverflow),
  };

  const backend: ProcessBackend = {
    mode: 'pipe',
    acceptsInput,
    start: async () => {
      let child;
      try {
        child = spawnOwnedProcess(settings, [profile.executable, ...profile.argumentList], {
          cwd: profile.workingDirectory,
          env: { ...profile.environment },
          stdin: acceptsInput ? 'pipe' : 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
        });
      } catch (error) {
        startFailure = error as ProcessStartFailure;
        throw error;
      }
      owned.adopt(child);
      input = acceptsInput ? (child.stdin as InputSink) : undefined;
      pumpPipe(child.stdout as ReadableStream<Uint8Array>, feeds.stdout, pumps);
      pumpPipe(child.stderr as ReadableStream<Uint8Array>, feeds.stderr, pumps);
    },
    write: async (bytes) => {
      if (input === undefined) throw new Error('the process has no open input');
      await input.write(bytes);
      await input.flush();
    },
    cleanup: async () => {
      // Termination starts first and runs alongside the close of stdin: closing flushes buffered
      // input, which waits on a child that has stopped reading, and must not hold the signal back.
      const terminating = owned.terminate();
      const sink = input;
      input = undefined;
      const closing = attempt(() => sink?.end());
      const terminated = await terminating;
      const closed = await closing;
      const released = await attempt(stopPumps);
      return combineOutcomes([terminated, closed && released ? 'complete' : 'incomplete']);
    },
  };

  return assembleHostedProcess({
    mode: 'pipe',
    backend,
    sources: [
      { kind: 'stream', channel: 'stdout', stream: feeds.stdout.stream },
      { kind: 'stream', channel: 'stderr', stream: feeds.stderr.stream },
    ],
    owned,
    startFailure: () => startFailure,
  });
}
