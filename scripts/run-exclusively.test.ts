import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from './promise-outcome.test-support.ts';
import {
  acquireHostLock,
  ownerFileName,
  reclaimAbandoned,
  runExclusively,
  type HostLockHolder,
  type OwnerRecord,
} from './run-exclusively';

let directory: string;
let lockDirectory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'corvidae-host-lock-'));
  lockDirectory = join(directory, 'host-lock');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function holder(pid = process.pid): HostLockHolder {
  return { pid, command: 'test', cwd: directory, acquiredAt: new Date(0).toISOString() };
}

/** The pid of a process that has already exited, so nothing can be holding a lock under it. */
async function exitedPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

async function writeLock(contents: OwnerRecord): Promise<void> {
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, ownerFileName), JSON.stringify(contents));
}

describe('acquireHostLock', () => {
  test('holds the lock until released, recording who holds it', async () => {
    const lock = await acquireHostLock({ lockDirectory, holder: holder() });
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.pid).toBe(process.pid);
    expect(recorded.command).toBe('test');
    await lock.recordCommand(4242);
    const updated = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(updated.commandPid).toBe(4242);
    await lock.release();
    expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
  });

  test('a second acquirer waits for the first to release', async () => {
    const events: string[] = [];
    const first = await acquireHostLock({ lockDirectory, holder: holder() });
    const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
    const second = acquireHostLock({
      lockDirectory,
      holder: holder(),
      pollIntervalMs: 1,
      onWait: (current) => {
        events.push(`waiting on ${current?.command}`);
        markWaiting();
      },
    }).then((lock) => {
      events.push('second acquired');
      return lock;
    });
    await waiting;
    events.push('first released');
    await first.release();
    const acquired = await second;
    await acquired.release();
    expect(events).toEqual(['waiting on test', 'first released', 'second acquired']);
  });

  test('reclaims a lock whose holder has exited', async () => {
    await writeLock({ ...holder(await exitedPid()), token: 'stale' });
    const lock = await acquireHostLock({ lockDirectory, holder: holder(), pollIntervalMs: 1 });
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.pid).toBe(process.pid);
    await lock.release();
  });

  test('treats a holder it may not signal as alive rather than reclaiming it', async () => {
    // Signalling pid 1 fails with EPERM: the process exists but belongs to another user.
    await writeLock({ ...holder(1), token: 'foreign' });
    const controller = new AbortController();
    const reason = rejectionOf(
      acquireHostLock({
        lockDirectory,
        holder: holder(),
        pollIntervalMs: 1,
        signal: controller.signal,
        onWait: () => controller.abort(),
      }),
    );
    expect(await reason).toBeInstanceOf(Error);
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.token).toBe('foreign');
  });

  test('reclaims a lock directory left without an owner once the grace period passes', async () => {
    // Not empty: renaming onto an empty directory would replace it without reaching the
    // ownerless branch at all.
    await mkdir(lockDirectory);
    await writeFile(join(lockDirectory, 'stray'), '');
    const lock = await acquireHostLock({
      lockDirectory,
      holder: holder(),
      pollIntervalMs: 1,
      ownerlessGraceMs: 0,
    });
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.pid).toBe(process.pid);
    await lock.release();
  });

  test('stays held while the command runs, even after the wrapper that took it has exited', async () => {
    await writeLock({ ...holder(await exitedPid()), commandPid: process.pid, token: 'orphaned' });
    const controller = new AbortController();
    const reason = rejectionOf(
      acquireHostLock({
        lockDirectory,
        holder: holder(),
        pollIntervalMs: 1,
        signal: controller.signal,
        onWait: () => controller.abort(),
      }),
    );
    expect(await reason).toBeInstanceOf(Error);
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.token).toBe('orphaned');
  });

  test('releasing never removes a lock someone else now holds', async () => {
    const lock = await acquireHostLock({ lockDirectory, holder: holder() });
    await rm(lockDirectory, { recursive: true });
    await writeLock({ ...holder(), token: 'successor' });
    await lock.release();
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.token).toBe('successor');
  });
});

describe('reclaimAbandoned', () => {
  test('leaves a lock that is live by the time the guard is held', async () => {
    // A waiter judged an earlier lock abandoned, but another waiter replaced it before this
    // reclaim took the guard.
    await writeLock({ ...holder(), token: 'live' });
    await reclaimAbandoned(lockDirectory, 10_000);
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.token).toBe('live');
  });

  test('leaves the lock to the reclaimer already holding the guard', async () => {
    const stale: OwnerRecord = { ...holder(await exitedPid()), token: 'stale' };
    await writeLock(stale);
    await mkdir(`${lockDirectory}.reclaiming`);
    await reclaimAbandoned(lockDirectory, 10_000);
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.token).toBe('stale');
  });

  test('removes a lock that is still the abandoned one', async () => {
    const stale: OwnerRecord = { ...holder(await exitedPid()), token: 'stale' };
    await writeLock(stale);
    await reclaimAbandoned(lockDirectory, 10_000);
    expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
    const guard = await stat(`${lockDirectory}.reclaiming`).catch(() => undefined);
    expect(guard).toBeUndefined();
  });
});

describe('runExclusively', () => {
  test('two concurrent runs never overlap', async () => {
    const log = join(directory, 'log');
    const script = `echo start >> '${log}'; sleep 0.2; echo end >> '${log}'`;
    const codes = await Promise.all([
      runExclusively({ lockDirectory, script, pollIntervalMs: 5, report: () => {} }),
      runExclusively({ lockDirectory, script, pollIntervalMs: 5, report: () => {} }),
    ]);
    expect(codes).toEqual([0, 0]);
    const lines = await readFile(log, 'utf8');
    expect(lines.trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
  });

  test("returns the command's exit code and releases the lock after a failure", async () => {
    expect(await runExclusively({ lockDirectory, script: 'exit 3', report: () => {} })).toBe(3);
    expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
  });

  test('passes arguments through with their boundaries intact', async () => {
    const output = join(directory, 'arguments');
    const code = await runExclusively({
      lockDirectory,
      script: `printf '%s\\n' > '${output}'`,
      args: ['two words', '--flag'],
      report: () => {},
    });
    expect(code).toBe(0);
    const written = await readFile(output, 'utf8');
    expect(written.split('\n')).toEqual(['two words', '--flag', '']);
  });

  test('runs unlocked with a warning when the lock cannot be created', async () => {
    const reports: string[] = [];
    const blocked = join(directory, 'a-file');
    await writeFile(blocked, '');
    const code = await runExclusively({
      lockDirectory: join(blocked, 'host-lock'),
      script: 'exit 0',
      report: (line) => reports.push(line),
    });
    expect(code).toBe(0);
    expect(reports.join('\n')).toContain('running without the host lock');
  });
});
