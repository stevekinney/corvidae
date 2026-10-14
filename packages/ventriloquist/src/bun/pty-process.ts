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
import type { HostedProcess, PtyProcessOptions } from './process-types.ts';
import { validateDimensions, validateProcessProfile } from './process-validation.ts';

/** The master side of a child's pseudo-terminal, as `Bun.Terminal` offers it. */
type PtyTerminal = {
  write(bytes: Uint8Array): number;
  resize(columns: number, rows: number): void;
  close(): void;
};

/**
 * Create a PTY process: `Bun.spawn({ terminal })`, which makes the child the leader of its own
 * session and process group. All of the process's output arrives as one combined stream, tagged
 * `pty`, and the helper decodes, splits and echoes nothing: the line discipline in the kernel is the
 * only thing between the process and the consumer. Input is written to the terminal as given and
 * resize changes its window size.
 *
 * The terminal's data callback cannot be paused, and a write that Bun has accepted says nothing
 * about the output, so neither is used to infer the other. Output the session has not yet read is
 * bounded, and exceeding the bound fails the source visibly.
 *
 * End of file on the terminal ends the output source; the process exit is reported separately and in
 * either order. If this Bun does not return a terminal, the process is killed and the start fails as
 * `unsupported-runtime`; a PTY never degrades to a pipe.
 *
 * Nothing is spawned until the session starts the backend.
 */
export function createPtyProcess(options: PtyProcessOptions): HostedProcess {
  validateProcessProfile(options.profile);
  validateDimensions(options.dimensions);
  const settings = resolveHostSettings(options);
  const { profile, dimensions } = options;
  const owned = createOwnedProcess(settings);
  let startFailure: ProcessStartFailure | undefined;
  let terminal: PtyTerminal | undefined;
  const feed = new BoundedByteFeed(settings.maximumBufferedOutputBytes, () => undefined);

  const backend: ProcessBackend = {
    mode: 'pty',
    start: async () => {
      let child;
      try {
        child = spawnOwnedProcess(settings, [profile.executable, ...profile.argumentList], {
          cwd: profile.workingDirectory,
          env: { ...profile.environment },
          terminal: {
            cols: dimensions.columns,
            rows: dimensions.rows,
            data: (_terminal: unknown, bytes: Uint8Array) => feed.push(bytes),
            exit: (_terminal: unknown, status: number) =>
              status === 0
                ? feed.end()
                : feed.fail(new Error(`the terminal closed with status ${status}`)),
          },
        });
        if (child.terminal === undefined) {
          // Not adopted: without a terminal the child is not a group leader, so it is ended directly.
          child.kill('SIGKILL');
          throw new ProcessStartFailure(
            'unsupported-runtime',
            'this Bun did not provide a terminal for the process',
          );
        }
      } catch (error) {
        startFailure = error as ProcessStartFailure;
        throw error;
      }
      owned.adopt(child);
      terminal = child.terminal as PtyTerminal;
    },
    write: async (bytes) => {
      if (terminal === undefined) throw new Error('the process has no open terminal');
      terminal.write(bytes);
    },
    resize: async (columns, rows) => {
      if (terminal === undefined) throw new Error('the process has no open terminal');
      terminal.resize(columns, rows);
    },
    cleanup: async () => {
      const terminated = await owned.terminate();
      const closed = await attempt(() => terminal?.close());
      terminal = undefined;
      return combineOutcomes([terminated, closed ? 'complete' : 'incomplete']);
    },
  };

  return assembleHostedProcess({
    mode: 'pty',
    backend,
    sources: [{ kind: 'stream', channel: 'pty', stream: feed.stream }],
    owned,
    startFailure: () => startFailure,
  });
}
