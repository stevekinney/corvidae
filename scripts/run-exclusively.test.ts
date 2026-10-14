import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from './promise-outcome.test-support.ts';
import {
  acquireHostLock,
  type HostLockHolder,
  ownerFileName,
  runExclusively,
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

async function writeLock(contents: HostLockHolder & { token: string }): Promise<void> {
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, ownerFileName), JSON.stringify(contents));
}

describe('acquireHostLock', () => {
  test('holds the lock until released, recording who holds it', async () => {
    const release = await acquireHostLock({ lockDirectory, holder: holder() });
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.pid).toBe(process.pid);
    expect(recorded.command).toBe('test');
    await release();
    expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
  });

  test('a second acquirer waits for the first to release', async () => {
    const events: string[] = [];
    const releaseFirst = await acquireHostLock({ lockDirectory, holder: holder() });
    const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
    const second = acquireHostLock({
      lockDirectory,
      holder: holder(),
      pollIntervalMs: 1,
      onWait: (current) => {
        events.push(`waiting on ${current?.command}`);
        markWaiting();
      },
    }).then((release) => {
      events.push('second acquired');
      return release;
    });
    await waiting;
    events.push('first released');
    await releaseFirst();
    await (
      await second
    )();
    expect(events).toEqual(['waiting on test', 'first released', 'second acquired']);
  });

  test('reclaims a lock whose holder has exited', async () => {
    await writeLock({ ...holder(await exitedPid()), token: 'stale' });
    const release = await acquireHostLock({ lockDirectory, holder: holder(), pollIntervalMs: 1 });
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.pid).toBe(process.pid);
    await release();
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
    await mkdir(lockDirectory);
    const release = await acquireHostLock({
      lockDirectory,
      holder: holder(),
      pollIntervalMs: 1,
      ownerlessGraceMs: 0,
    });
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.pid).toBe(process.pid);
    await release();
  });

  test('releasing never removes a lock someone else now holds', async () => {
    const release = await acquireHostLock({ lockDirectory, holder: holder() });
    await rm(lockDirectory, { recursive: true });
    await writeLock({ ...holder(), token: 'successor' });
    await release();
    const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
    expect(recorded.token).toBe('successor');
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
