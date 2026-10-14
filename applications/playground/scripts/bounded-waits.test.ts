/**
 * Every wait in the static gate, its cleanup, its stand-ins, and its lifecycle tests is bounded.
 * Each case here races the code under test against a watchdog, so a regression shows up as a
 * failure instead of a stalled test process.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { interruptRunner, readProcessTable, signalTarget } from './static-playground-processes.ts';

function signalGroupOf(pid: number): void {
  const group = readProcessTable().find((row) => row.pid === pid)?.pgid;
  if (group !== undefined) signalTarget(-group, 'SIGKILL');
}

const STAND_IN_RUNNER = join(
  import.meta.dirname,
  'fixtures',
  'static-playground',
  'stand-ins',
  'stand-in-test-runner.ts',
);

/** Resolve `work`, or the string `'hung'` once `milliseconds` pass without it settling. */
async function watchdog<T>(work: Promise<T>, milliseconds: number): Promise<T | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), milliseconds);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

describe('bounded waits', () => {
  it('stops waiting for a runner whose exit is never reported', async () => {
    // A subprocess whose `exited` never settles, as when an exit is never observed.
    const neverExits = {
      pid: 2_147_483_000,
      exitCode: null,
      signalCode: null,
      kill: () => undefined,
      exited: new Promise<number>(() => {}),
    } as unknown as Bun.Subprocess;

    const outcome = await watchdog(
      interruptRunner(neverExits, undefined, { graceMilliseconds: 200 }),
      2_000,
    );

    expect(outcome).not.toBe('hung');
    expect(outcome).toEqual({ survivors: [], runnerExited: false });
  });

  it('ends a stand-in test runner that never receives its proceed file', async () => {
    const record = await mkdtemp(join(tmpdir(), 'bounded-wait-record-'));
    try {
      const standIn = Bun.spawn(
        [
          process.execPath,
          STAND_IN_RUNNER,
          '--mode',
          'pass',
          '--record',
          record,
          '--wait-milliseconds',
          '300',
        ],
        { env: { PATH: '/usr/bin:/bin' }, stdout: 'ignore', stderr: 'pipe', detached: true },
      );

      const exitCode = await watchdog(standIn.exited, 3_000);
      if (exitCode === 'hung') standIn.kill('SIGKILL');

      expect(exitCode).toBe(1);
      expect(await new Response(standIn.stderr).text()).toContain('timed out waiting for');
    } finally {
      // The stand-in's sleepers: one in its own group, one detached into a group of its own.
      for (const label of ['runner-grandchild', 'runner-detached']) {
        const file = Bun.file(join(record, `${label}.pid`));
        if (!(await file.exists())) continue;
        const pid = await file.text();
        signalGroupOf(Number(pid.trim()));
      }
      await rm(record, { recursive: true, force: true });
    }
  });
});
