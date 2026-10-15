import type { ProcessBackend } from '../session/session-types.ts';
import { attempt, combineOutcomes } from '../session/settle.ts';
import { createDeferredByteStream } from './deferred-byte-stream.ts';
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

/**
 * Create a pipe process: `Bun.spawn` with piped stdio, run as its own process group. Standard
 * output and standard error are two separate owned sources tagged `stdout` and `stderr`, so
 * partial escape sequences from one channel can never be spliced into the other, and nothing is
 * decoded or split on the way. Output is pull-based and the process is never read ahead of the
 * session, which is what lets the session pause it. Standard input exists only when `acceptsInput` is set; otherwise
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
  // Neither channel is buffered here: each is read only when the session asks, so a child nobody
  // reads blocks on its pipe, and the session's one output budget bounds both channels together.
  const outputs = { stdout: createDeferredByteStream(), stderr: createDeferredByteStream() };
  const releaseOutputs = async (): Promise<void> => {
    await Promise.all([outputs.stdout.cancel(), outputs.stderr.cancel()]);
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
      // No `await` may come between the spawn and these two calls: see `DeferredByteStream.attach`.
      outputs.stdout.attach(child.stdout as ReadableStream<Uint8Array>);
      outputs.stderr.attach(child.stderr as ReadableStream<Uint8Array>);
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
      const released = await attempt(releaseOutputs);
      return combineOutcomes([terminated, closed && released ? 'complete' : 'incomplete']);
    },
  };

  return assembleHostedProcess({
    mode: 'pipe',
    backend,
    sources: [
      { kind: 'stream', channel: 'stdout', stream: outputs.stdout.stream },
      { kind: 'stream', channel: 'stderr', stream: outputs.stderr.stream },
    ],
    owned,
    startFailure: () => startFailure,
  });
}
