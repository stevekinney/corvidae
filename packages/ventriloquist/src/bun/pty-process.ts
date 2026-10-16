import type { ProcessBackend } from '../session/session-types.ts';
import { attempt, combineOutcomes } from '../session/settle.ts';
import { createDeferredByteStream } from './deferred-byte-stream.ts';
import {
  assembleHostedProcess,
  createOwnedProcess,
  requireSupportedHost,
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
import { loadPtyDevice, type PtyDevice, type PtyPair } from './pty-device.ts';
import { createPtyMaster, type PtyMaster } from './pty-master.ts';
import { abandonGate, gateStdio, gatedCommand, releaseGate } from './pty-start-gate.ts';

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

/**
 * Create a PTY process. The helper opens the pseudo-terminal itself (libc through `bun:ffi`, see
 * `pty-device.ts`) and spawns the child on its slave as its own session leader and process group.
 * Bun's `terminal` option cannot be used because its reader cannot be paused: a producer such as
 * `yes` overflowed the output budget however fast the consumer acknowledged. Here a worker thread
 * reads the master only while the session is taking output (`pty-master.ts`), so a producer the
 * session is not reading blocks in the kernel and host memory stays flat.
 *
 * All of the process's output arrives as one combined stream, tagged `pty`, and the helper decodes,
 * splits and echoes nothing: the line discipline in the kernel is the only thing between the
 * process and the consumer. Input is written to the master as given and resize changes its window
 * size.
 *
 * Input is backpressured: the master is non-blocking, so what the child has not read is queued and
 * retried, and a write settles only when the kernel has taken every byte. The session's input
 * budget bounds what is queued, and its acknowledgement deadline ends a session whose terminal
 * never takes it.
 *
 * The child does not run its command until `Bun.spawn` has returned (see `pty-start-gate.ts`, which
 * works around a Bun hang and gives the child its controlling terminal). So a missing or
 * non-executable command is found after the spawn, before the gate is released, and fails the
 * start as `spawn-failed` exactly as a refused spawn does.
 *
 * Cleanup ends the whole session, not only the shell's process group (see `process-session.ts`): the
 * shell is hung up first, then every process still in the session is sent TERM and, after the
 * grace, KILL. A job that left the session with `setsid` is out of reach and is reported `unknown`.
 *
 * End of output ends the output source; the process exit is reported separately and in either
 * order. A host that cannot open a terminal this way (no libc binding, no C compiler, no worker
 * thread) fails the start as `unsupported-runtime`; a PTY never degrades to a pipe.
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
  const owned = createOwnedProcess(settings, 'session');
  const output = createDeferredByteStream();
  let startFailure: ProcessStartFailure | undefined;
  let device: PtyDevice | undefined;
  let pair: PtyPair | undefined;
  let master: PtyMaster | undefined;

  /** Record why the start failed, release whatever it had acquired, and throw. */
  const failStart = async (
    failure: ProcessStartFailure,
    release: () => void | Promise<void>,
  ): Promise<never> => {
    startFailure = failure;
    await attempt(async () => release());
    throw failure;
  };

  const backend: ProcessBackend = {
    mode: 'pty',
    start: async () => {
      try {
        requireSupportedHost(settings);
      } catch (error) {
        startFailure = error as ProcessStartFailure;
        throw error;
      }
      let opened: PtyDevice;
      try {
        opened = (options.loadDevice ?? loadPtyDevice)();
      } catch (cause) {
        return failStart(
          new ProcessStartFailure(
            'unsupported-runtime',
            'this host cannot open a pseudo-terminal through libc and the bundled C helper',
            { cause },
          ),
          () => undefined,
        );
      }
      device = opened;
      let terminal: PtyPair | undefined;
      let slave: number | undefined;
      try {
        terminal = opened.open();
        slave = opened.openSlave(terminal.slavePath);
        opened.setWindowSize(terminal, dimensions.columns, dimensions.rows);
      } catch (cause) {
        const partial = terminal;
        const partialSlave = slave;
        return failStart(
          new ProcessStartFailure('spawn-failed', 'could not open a pseudo-terminal', { cause }),
          () => {
            if (partialSlave !== undefined) opened.close(partialSlave);
            if (partial !== undefined) opened.close(partial.masterFd);
          },
        );
      }
      const opening = { terminal, slave };
      let child;
      try {
        child = spawnOwnedProcess(
          settings,
          gatedCommand([profile.executable, ...profile.argumentList], opening.terminal.slavePath),
          {
            stdio: gateStdio(opening.slave),
            cwd: profile.workingDirectory,
            env: { ...profile.environment },
            detached: true,
          },
        );
      } catch (error) {
        return failStart(error as ProcessStartFailure, () =>
          opened.close(opening.terminal.masterFd),
        );
      } finally {
        // The child holds its own copies. Keeping this one would stop the master from ever seeing the
        // slave close, so the end of the output would never be reported.
        opened.close(opening.slave);
      }
      // The child is held until the gate is released, so it cannot have run before `Bun.spawn`
      // returned. It stays owned until it has been reaped and its group swept, so a failed start
      // cannot report a process that is still alive as gone.
      owned.adopt(child);
      const abort = async (): Promise<void> => {
        child.kill('SIGKILL');
        // The release channel is the host's end of a pipe the child never got a byte on; closing it
        // is what keeps a failed start from leaking it (a no-op when it was already released).
        abandonGate(child);
        master?.discard();
        await child.exited;
        await owned.terminate();
        // The descriptor is closed only after the thread reading it has stopped, so a reused
        // descriptor number can never be read by it.
        if (master === undefined) {
          opened.close(opening.terminal.masterFd);
        } else {
          // Closed only once the thread reading it has confirmed it stopped; otherwise the descriptor
          // stays for process teardown, since closing it under a reader invites a reused number.
          if (await master.stop()) master.close();
          else master.abandon();
        }
        master = undefined;
      };
      try {
        master = createPtyMaster({
          descriptor: opening.terminal.masterFd,
          device: opened,
          endsWithIo: settings.host.platform === 'linux',
          ...(options.createMasterWorker === undefined
            ? {}
            : { createWorker: options.createMasterWorker }),
          ...(options.writeMaster === undefined ? {} : { write: options.writeMaster }),
          ...(options.masterStopTimeoutMilliseconds === undefined
            ? {}
            : { stopTimeoutMilliseconds: options.masterStopTimeoutMilliseconds }),
        });
      } catch (cause) {
        return failStart(
          new ProcessStartFailure(
            'unsupported-runtime',
            'this Bun could not start the thread that reads a terminal',
            { cause },
          ),
          abort,
        );
      }
      // A command that cannot be run is found here, before the release, and the child ends without
      // having run anything.
      const unrunnable = notRunnable(profile);
      const hasChannel = unrunnable === undefined ? releaseGate(child) : abandonGate(child);
      if (hasChannel && unrunnable === undefined) {
        pair = opening.terminal;
        output.attach(master.stream);
        return undefined;
      }
      return failStart(
        hasChannel
          ? new ProcessStartFailure(
              'spawn-failed',
              `could not spawn ${profile.executable}: ${unrunnable}`,
            )
          : new ProcessStartFailure(
              'unsupported-runtime',
              'this Bun did not provide the channel that releases a terminal process',
            ),
        abort,
      );
    },
    write: async (bytes) => {
      if (master === undefined) throw new Error('the process has no open terminal');
      await master.write(bytes);
    },
    resize: async (columns, rows) => {
      if (device === undefined || pair === undefined || master === undefined) {
        throw new Error('the process has no open terminal');
      }
      device.setWindowSize(pair, columns, rows);
    },
    cleanup: async () => {
      const active = master;
      // Output keeps being read and dropped while the group is ended: a terminal with unread output
      // waits for it to drain before the last process holding it can finish closing.
      active?.discard();
      const terminated = await owned.terminate();
      // Never wait for the end of the output: a descendant that escaped the group can hold the
      // terminal open indefinitely, so the reader is stopped here instead.
      const stopped = active === undefined ? true : await active.stop();
      // An unconfirmed reader still has the descriptor: leave it open and say cleanup did not finish.
      const closed = stopped && (await attempt(() => active?.close()));
      if (!stopped) active?.abandon();
      master = undefined;
      pair = undefined;
      await attempt(() => output.cancel());
      return combineOutcomes([terminated, stopped && closed ? 'complete' : 'incomplete']);
    },
  };

  return assembleHostedProcess({
    mode: 'pty',
    backend,
    sources: [{ kind: 'stream', channel: 'pty', stream: output.stream }],
    owned,
    startFailure: () => startFailure,
  });
}
