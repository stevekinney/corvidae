/**
 * Shared pieces of the gate's stand-in children. A sleeper is a `sh` loop that records its PID and
 * never exits on its own, so a lifecycle case can prove the runner, not the sleeper, ended it.
 */
import { HANG_GUARD_MILLISECONDS } from '@lostgradient/testing/hang-guard';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SLEEPER = 'echo $$ > "$1"; while :; do sleep 1; done';
const STUBBORN_SLEEPER = `trap '' TERM; ${SLEEPER}`;

/**
 * Start a sleeper that records its PID as `<record>/<label>.pid`. A detached sleeper leads a new
 * process group and names `marker` on its command line, the way Chromium leaves the test runner's
 * group but names its profile inside the run-owned `TMPDIR`.
 */
export function startSleeper(
  record: string,
  label: string,
  detached = false,
  marker = '',
  ignoreTermination = false,
): void {
  const script = ignoreTermination ? STUBBORN_SLEEPER : SLEEPER;
  const command = ['/bin/sh', '-c', script, 'stand-in-sleeper', join(record, `${label}.pid`)];
  if (marker !== '') command.push(`--profile=${marker}`);
  const sleeper = Bun.spawn(command, { stdio: ['ignore', 'ignore', 'ignore'], detached });
  sleeper.unref();
}

/**
 * How long a stand-in waits for its test's next step before giving up. `--wait-milliseconds`
 * overrides it, so a test can prove the bound without waiting it out.
 */
export const STAND_IN_WAIT_MILLISECONDS = HANG_GUARD_MILLISECONDS;

export function waitMilliseconds(): number {
  const value = Number(argumentValue('--wait-milliseconds') ?? STAND_IN_WAIT_MILLISECONDS);
  return Number.isFinite(value) && value > 0 ? value : STAND_IN_WAIT_MILLISECONDS;
}

/** Resolve once `path` exists; throw `timed out waiting for <path>` after `milliseconds`. */
export async function waitForFile(path: string, milliseconds = waitMilliseconds()): Promise<void> {
  for await (const _turn of awakeTurns({
    hangGuardMilliseconds: milliseconds,
    yieldTurn: () => Bun.sleep(20),
  })) {
    if (existsSync(path)) return;
  }
  throw new Error(`stand-in timed out waiting for ${path}`);
}

/** Read a flag value such as `--record <dir>` from `process.argv`. */
export function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
