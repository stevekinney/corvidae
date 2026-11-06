/**
 * Shared pieces of the gate's stand-in children. A sleeper is a `sh` loop that records its PID and
 * never exits while its test is alive, so a lifecycle case can prove the runner, not the sleeper,
 * ended it.
 *
 * A stand-in must never outlive its test, however the test ends. A test passes `--owner-pid <pid>`
 * (its own PID) down to every stand-in, and each stand-in, sleeper included, exits once that
 * process is gone: a test process killed by the hang guard, an out-of-memory kill or a run
 * cancelled from outside never reaches its `finally`, and a stand-in with no owner would run for
 * ever with no parent. A sleeper also exits when its PID record is removed, which is what the
 * test's own cleanup does last.
 */
import { HANG_GUARD_MILLISECONDS } from '@lostgradient/testing/hang-guard';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// `$1` is the PID record and `$2` the owner's PID (this shell's own when no owner was named).
// A record that cannot be written, because the test already removed its directory, ends the
// sleeper at once instead of leaving a loop nothing can find by PID.
const SLEEPER =
  'echo $$ > "$1" || exit 1; while [ -e "$1" ] && kill -0 "${2:-$$}" 2>/dev/null; do sleep 1; done';
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
  const command = [
    '/bin/sh',
    '-c',
    script,
    'stand-in-sleeper',
    join(record, `${label}.pid`),
    argumentValue('--owner-pid') ?? '',
  ];
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
  for await (const _ of awakeTurns({
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

/**
 * Exit this stand-in once the process named by `--owner-pid` is gone. Without the argument it
 * does nothing, so a stand-in started by hand keeps running until it is stopped.
 */
export function exitWhenOwnerIsGone(pollMilliseconds = 500): void {
  const owner = Number(argumentValue('--owner-pid'));
  if (!Number.isInteger(owner) || owner <= 0) return;
  const timer = setInterval(() => {
    try {
      process.kill(owner, 0);
    } catch (error) {
      // EPERM means the owner exists but is not ours to signal, which is still alive.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      process.stderr.write(`stand-in owner ${owner} is gone; exiting\n`);
      process.exit(1);
    }
  }, pollMilliseconds);
  timer.unref();
}
