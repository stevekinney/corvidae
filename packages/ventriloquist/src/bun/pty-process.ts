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
import type { HostedProcess, ProcessProfile, PtyProcessOptions } from './process-types.ts';
import {
  snapshotDimensions,
  snapshotProfile,
  validateDimensions,
  validateProcessProfile,
} from './process-validation.ts';
import { GATE_STDIO, abandonGate, gatedCommand, releaseGate } from './pty-start-gate.ts';

/**
 * Why the profile's executable cannot be run, or `undefined` when it can. A bare name is looked up on
 * the profile's own `PATH`, a path is taken relative to the working directory, and a file that is
 * missing, a directory, or a file without the executable bit is not runnable.
 */
function notRunnable(profile: ProcessProfile): string | undefined {
  const path = profile.environment['PATH'];
  const found = Bun.which(profile.executable, {
    cwd: profile.workingDirectory,
    ...(path === undefined ? {} : { PATH: path }),
  });
  return found === null ? 'no executable file was found' : undefined;
}

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
 * Input is backpressured: `Terminal.write` accepts every byte and buffers what the process has not
 * read, and its `drain` callback reports the buffer flushed (Bun's `TerminalOptions.drain` and
 * `Terminal.write` documentation), so a write settles only when `drain` fires and the session's
 * input budget bounds what is buffered. If a terminal never drains, the session's acknowledgement
 * deadline ends the session. The terminal's data callback cannot be paused, and a write that Bun
 * has accepted says nothing about the output, so neither is used to infer the other. Output the session has not yet read is
 * bounded, and exceeding the bound fails the source visibly.
 *
 * The child does not run its command until `Bun.spawn` has returned (see `pty-start-gate.ts`, which
 * works around a Bun hang). So a missing or non-executable command is found after the spawn, before
 * the gate is released, and fails the start as `spawn-failed` exactly as a refused spawn does.
 *
 * End of file on the terminal ends the output source; the process exit is reported separately and in
 * either order. If this Bun does not return a terminal, the process is killed and reaped, and the start fails as
 * `unsupported-runtime`; a PTY never degrades to a pipe.
 *
 * Nothing is spawned until the session starts the backend.
 */
export function createPtyProcess(options: PtyProcessOptions): HostedProcess {
  // The copies are what is validated and what later spawns, whatever the caller does to its objects.
  const profile = snapshotProfile(options.profile);
  const dimensions = snapshotDimensions(options.dimensions);
  validateProcessProfile(profile);
  validateDimensions(dimensions);
  const settings = resolveHostSettings(options);
  const owned = createOwnedProcess(settings);
  let startFailure: ProcessStartFailure | undefined;
  let terminal: PtyTerminal | undefined;
  const feed = new BoundedByteFeed(
    settings.maximumBufferedOutputBytes,
    () => undefined,
    // Output nothing is reading is no longer kept, so the process producing it is ended.
    () => void owned.terminate(),
  );
  /** Writes the terminal accepted but has not yet reported flushed, oldest first. */
  const unflushed: { resolve(): void }[] = [];
  const flushed = (): void => {
    for (const write of unflushed.splice(0)) write.resolve();
  };
  // Closing the terminal flushes nothing, so a write still waiting is neither done nor failed: it
  // is left unsettled, and the session reports it as unknown when it closes.
  const abandonUnflushed = (): void => {
    unflushed.length = 0;
  };

  const backend: ProcessBackend = {
    mode: 'pty',
    start: async () => {
      let child;
      try {
        child = spawnOwnedProcess(
          settings,
          gatedCommand([profile.executable, ...profile.argumentList]),
          {
            stdio: GATE_STDIO,
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
              drain: () => flushed(),
            },
          },
        );
      } catch (error) {
        startFailure = error as ProcessStartFailure;
        throw error;
      }
      if (child.terminal === undefined) {
        // Without a terminal the child is not a group leader, so it is killed directly. It stays
        // owned until it has been reaped and its group swept, so cleanup cannot report a process
        // that is still alive as gone.
        owned.adopt(child);
        child.kill('SIGKILL');
        await child.exited;
        await owned.terminate();
        startFailure = new ProcessStartFailure(
          'unsupported-runtime',
          'this Bun did not provide a terminal for the process',
        );
        throw startFailure;
      }
      owned.adopt(child);
      // The child is held until the gate is released, so it cannot have run before `Bun.spawn`
      // returned. A command that cannot be run is found here, before the release, and the child
      // ends without having run anything.
      const unrunnable = notRunnable(profile);
      const hasChannel = unrunnable === undefined ? releaseGate(child) : abandonGate(child);
      if (hasChannel && unrunnable === undefined) {
        terminal = child.terminal as PtyTerminal;
        return;
      }
      child.kill('SIGKILL');
      await child.exited;
      await owned.terminate();
      await attempt(() => (child.terminal as PtyTerminal).close());
      startFailure = hasChannel
        ? new ProcessStartFailure(
            'spawn-failed',
            `could not spawn ${profile.executable}: ${unrunnable}`,
          )
        : new ProcessStartFailure(
            'unsupported-runtime',
            'this Bun did not provide the channel that releases a terminal process',
          );
      throw startFailure;
    },
    write: async (bytes) => {
      if (terminal === undefined) throw new Error('the process has no open terminal');
      // Bun need not report a flush for no bytes, so an empty write would wait for a `drain` that
      // may never come and be reported unknown at the acknowledgement deadline. There is nothing
      // to flush, so it is done.
      if (bytes.length === 0) return;
      // The terminal accepts every byte and buffers what the process has not read, so accepting
      // says nothing about how much is buffered. The operation stays unsettled until the terminal
      // reports the buffer flushed, which keeps the session's input budget counting those bytes.
      const flush = new Promise<void>((resolve) => unflushed.push({ resolve }));
      terminal.write(bytes);
      await flush;
    },
    resize: async (columns, rows) => {
      if (terminal === undefined) throw new Error('the process has no open terminal');
      terminal.resize(columns, rows);
    },
    cleanup: async () => {
      const terminated = await owned.terminate();
      const closed = await attempt(() => terminal?.close());
      terminal = undefined;
      abandonUnflushed();
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
