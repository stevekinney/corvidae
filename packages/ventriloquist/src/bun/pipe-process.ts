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
 * Close the child's stdin. When input is still held in the sink because the child never read it,
 * ending the sink fails with `EPIPE` once the child is gone: the pipe is closed and the held input
 * is discarded, which is what cleanup is for, so that is not a failure to close.
 */
async function closeInput(sink: InputSink | undefined): Promise<void> {
  try {
    await sink?.end();
  } catch (error) {
    if ((error as { readonly code?: string }).code !== 'EPIPE') throw error;
  }
}

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
  /** Cleanup has begun: a write it ends is lost with the process, not a failure of the write itself. */
  let cleaningUp = false;
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
    write: async (bytes, hold) => {
      if (input === undefined) throw new Error('the process has no open input');
      // Bun answers with a number while the pipe takes the bytes at once and with a promise while
      // the child is not reading and the sink is waiting for the pipe to drain: that wait is a hold.
      try {
        const written = input.write(bytes);
        if (written instanceof Promise) hold?.held();
        await written;
        const flushed = input.flush();
        if (flushed instanceof Promise) hold?.held();
        await flushed;
      } catch (error) {
        if (!cleaningUp) throw error;
        // Cleanup killed the child this write was waiting on, which rejects it. Whether any of it
        // arrived cannot be known, so it stays unsettled and the session reports unknown delivery,
        // exactly as it does for a terminal that hung up.
        await new Promise<never>(() => undefined);
      }
    },
    cleanup: async () => {
      // Termination starts first and runs alongside the close of stdin: closing flushes buffered
      // input, which waits on a child that has stopped reading, and must not hold the signal back.
      cleaningUp = true;
      const terminating = owned.terminate();
      const sink = input;
      input = undefined;
      const closing = attempt(() => closeInput(sink));
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
