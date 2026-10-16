import { writeSync } from 'node:fs';

import type { ProcessBackend } from '../session/session-types.ts';
import { attempt, combineOutcomes } from '../session/settle.ts';
import { createDeferredByteStream } from './deferred-byte-stream.ts';
import {
  assembleHostedProcess,
  createOwnedProcess,
  resolveHostSettings,
  spawnOwnedProcess,
} from './hosted-process.ts';
import { createInputWriter, type DescriptorWrite, type InputWriter } from './input-writer.ts';
import { loadPipeDevice, type PipeDevice, type PipePair } from './pipe-device.ts';
import { ProcessStartFailure } from './process-start-failure.ts';
import type { HostedProcess, PipeProcessOptions } from './process-types.ts';
import { snapshotProfile, validateProcessProfile } from './process-validation.ts';

/** Write to a descriptor without blocking, the way `fs.writeSync` does. */
const writeDescriptor: DescriptorWrite = (descriptor, bytes, offset) =>
  writeSync(descriptor, bytes, offset, bytes.length - offset, null);

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
  let device: PipeDevice | undefined;
  let inputEnd: PipePair | undefined;
  let input: InputWriter | undefined;
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
      // The child's input is a pipe this process holds the write end of, not Bun's stdin sink: the
      // sink buffers without a bound the session can see, so a child that never reads would hold
      // half a mebibyte. With the descriptor, the kernel's pipe buffer is the only buffer.
      let pipe: PipePair | undefined;
      if (acceptsInput) {
        try {
          device = (options.loadDevice ?? loadPipeDevice)();
        } catch (cause) {
          startFailure = new ProcessStartFailure(
            'unsupported-runtime',
            'this host cannot open a pipe through libc and the bundled C helper',
            { cause },
          );
          throw startFailure;
        }
        try {
          pipe = device.open();
        } catch (cause) {
          startFailure = new ProcessStartFailure('spawn-failed', 'could not open an input pipe', {
            cause,
          });
          throw startFailure;
        }
      }
      let child;
      try {
        child = spawnOwnedProcess(settings, [profile.executable, ...profile.argumentList], {
          cwd: profile.workingDirectory,
          env: { ...profile.environment },
          stdin: pipe === undefined ? 'ignore' : pipe.readFd,
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true,
        });
      } catch (error) {
        startFailure = error as ProcessStartFailure;
        if (pipe !== undefined) {
          device?.close(pipe.readFd);
          device?.close(pipe.writeFd);
        }
        throw error;
      } finally {
        // The child holds its own copy of the read end. Keeping this one would leave a reader on
        // the pipe after the child is gone, so a write would never see EPIPE.
        if (pipe !== undefined) device?.close(pipe.readFd);
      }
      owned.adopt(child);
      if (pipe !== undefined) {
        inputEnd = pipe;
        input = createInputWriter({
          descriptor: pipe.writeFd,
          write: options.writeInput ?? writeDescriptor,
          // A closed reader is an ordinary failure of the write: the child is gone.
          isHungUp: () => false,
        });
      }
      // No `await` may come between the spawn and these two calls: see `DeferredByteStream.attach`.
      outputs.stdout.attach(child.stdout as ReadableStream<Uint8Array>);
      outputs.stderr.attach(child.stderr as ReadableStream<Uint8Array>);
    },
    write: (bytes, hold) => {
      if (input === undefined) return Promise.reject(new Error('the process has no open input'));
      return input.write(bytes, hold);
    },
    cleanup: async () => {
      // What is queued is dropped before the child is signaled: whether any of it arrived cannot be
      // known, so the write stays unsettled and the session reports unknown delivery.
      input?.abandon();
      const terminating = owned.terminate();
      const end = inputEnd;
      input = undefined;
      inputEnd = undefined;
      // Closing the write end is the child's end of file, and releases the descriptor.
      const closing = attempt(() => (end === undefined ? undefined : device?.close(end.writeFd)));
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
