import { closeSync, writeSync } from 'node:fs';

import type { SpawnedProcess } from './process-types.ts';

/**
 * Bun 1.4.2 on macOS can block forever inside `Bun.spawn({ terminal })`, with its main thread in
 * `wait4`, when the child writes to its terminal and exits before `Bun.spawn` has returned
 * (https://github.com/oven-sh/bun/issues/45300). The window is the spawn call itself, so the fix is
 * to make the child unable to run the real command until the call has returned: the child starts as
 * a small shell that blocks reading one release byte, and the host sends it once `Bun.spawn` is back.
 *
 * The release travels on an extra descriptor, never on the terminal: fd 3 is a pipe from the host to
 * the shell (a write to the terminal would be echoed and would reach the program). The shell closes
 * it and then `exec`s, so the real command keeps the pid, the session, the process group and the
 * controlling terminal of the shell, and never sees the channel. End of file without a byte, which is
 * what an abandoned gate or a host that died produces, ends the shell without running anything.
 *
 * The channel is deliberately one-way. Bun also reads the host's end of an extra pipe and delivers
 * whatever arrives to the terminal's `data` callback, so a shell that answered on it would race the
 * host for the answer and mostly lose.
 */
const GATE_SCRIPT = 'IFS= read -r _ <&3 || exit 1\nexec 3<&-\nexec "$@"';

/** The absolute path is used because the profile's environment is complete and may carry no `PATH`. */
const GATE_SHELL = '/bin/sh';

/** Standard streams stay on the terminal; descriptor 3 is the release channel. */
export const GATE_STDIO = [undefined, undefined, undefined, 'pipe'] as const;

/** The command a gated PTY child runs: the gate, then `command` once it is released. */
export function gatedCommand(command: readonly string[]): string[] {
  return [GATE_SHELL, '-c', GATE_SCRIPT, 'sh', ...command];
}

/** The host's end of the release channel, or `undefined` when this Bun did not provide one. */
function releaseDescriptor(child: SpawnedProcess): number | undefined {
  const descriptor = child.stdio?.[3];
  return typeof descriptor === 'number' ? descriptor : undefined;
}

function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // Already closed.
  }
}

/**
 * Let a gated child run its command. Call only after `Bun.spawn` has returned. Returns `false` when
 * the child has no release channel, so it cannot be released.
 */
export function releaseGate(child: SpawnedProcess): boolean {
  const descriptor = releaseDescriptor(child);
  if (descriptor === undefined) return false;
  try {
    writeSync(descriptor, '\n');
  } catch {
    // The child is already gone; its exit is reported as usual.
  } finally {
    closeQuietly(descriptor);
  }
  return true;
}

/**
 * Close the release channel without a byte, so the child ends without running its command. Returns
 * `false` when the child has no release channel.
 */
export function abandonGate(child: SpawnedProcess): boolean {
  const descriptor = releaseDescriptor(child);
  if (descriptor === undefined) return false;
  closeQuietly(descriptor);
  return true;
}
