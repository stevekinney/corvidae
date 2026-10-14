import type { ProcessBackend } from '../session/session-types.ts';
import { attempt, combineOutcomes } from '../session/settle.ts';
import { BoundedByteFeed } from './bounded-byte-feed.ts';
import {
  assembleHostedProcess,
  createOwnedProcess,
  resolveHostSettings,
  spawnOwnedProcess,
} from './hosted-process.ts';
import { ProcessStartFailure } from './process-start-failure.ts';
import type { HostedProcess, PipeProcessOptions } from './process-types.ts';
import { validateProcessProfile } from './process-validation.ts';

/** The writable end of a child's stdin, as Bun's `FileSink` offers it. */
type InputSink = {
  write(bytes: Uint8Array): number | Promise<number>;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
};

type OutputReader = ReadableStreamDefaultReader<Uint8Array>;

/**
 * Read a child's output pipe into a feed until it ends. The pipe exposes no pause or resume, so
 * the feed's bound is what limits unread output. The returned function stops reading and releases
 * the pipe; it is safe to call any number of times.
 */
function pumpPipe(stream: ReadableStream<Uint8Array>, feed: BoundedByteFeed): () => Promise<void> {
  const reader: OutputReader = stream.getReader();
  void (async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        feed.push(result.value);
      }
      feed.end();
    } catch (error) {
      feed.fail(error);
    }
  })();
  let stopped: Promise<void> | undefined;
  return () => (stopped ??= reader.cancel());
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
  validateProcessProfile(options.profile);
  const settings = resolveHostSettings(options);
  const { profile } = options;
  const acceptsInput = options.acceptsInput === true;
  const owned = createOwnedProcess(settings);
  let startFailure: ProcessStartFailure | undefined;
  let input: InputSink | undefined;
  const stops: (() => Promise<void>)[] = [];
  const stopPumps = async (): Promise<void> => {
    await Promise.all(stops.map((stop) => stop()));
  };
  const feeds = {
    stdout: new BoundedByteFeed(settings.maximumBufferedOutputBytes, stopPumps),
    stderr: new BoundedByteFeed(settings.maximumBufferedOutputBytes, stopPumps),
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
      stops.push(
        pumpPipe(child.stdout as ReadableStream<Uint8Array>, feeds.stdout),
        pumpPipe(child.stderr as ReadableStream<Uint8Array>, feeds.stderr),
      );
    },
    write: async (bytes) => {
      if (input === undefined) throw new Error('the process has no open input');
      await input.write(bytes);
      await input.flush();
    },
    cleanup: async () => {
      const closed = await attempt(() => input?.end());
      input = undefined;
      const terminated = await owned.terminate();
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
