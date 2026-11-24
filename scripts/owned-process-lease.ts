import { dlopen, FFIType, ptr, read } from 'bun:ffi';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  judgeByProcess,
  ownerFileName,
  processStartTime,
  processTableEnvironment,
  readOwner,
  recordProcessGroup,
  removeLock,
  takeReclaimGuard,
  type HeldHostLock,
  type OwnerRecord,
} from './run-exclusively.ts';

const platform = process.platform;
if (platform !== 'darwin' && platform !== 'linux')
  throw new Error('Owned process leases require macOS or Linux.');
const renameSymbol = platform === 'darwin' ? 'renameatx_np' : 'renameat2';
const errnoSymbol = platform === 'darwin' ? '__error' : '__errno_location';
const { symbols } = dlopen(platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
  [renameSymbol]: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  [errnoSymbol]: { args: [], returns: FFIType.ptr },
});

/** Publish a complete owner without ever replacing even an empty or unverified lock. */
async function installLease(
  lockDirectory: string,
  owner: OwnerRecord,
  beforePublish?: () => void | Promise<void>,
): Promise<boolean> {
  const pending = `${lockDirectory}.pending-${owner.token}`;
  await mkdir(pending);
  try {
    const ownerPath = join(pending, ownerFileName);
    await writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    sync(ownerPath);
    sync(pending);
    await beforePublish?.();
    const source = Buffer.from(`${pending}\0`);
    const target = Buffer.from(`${lockDirectory}\0`);
    const currentDirectory = platform === 'darwin' ? -2 : -100;
    const flag = platform === 'darwin' ? 4 : 1;
    if (
      symbols[renameSymbol]!(currentDirectory, ptr(source), currentDirectory, ptr(target), flag) ===
      0
    )
      return true;
    const address = symbols[errnoSymbol]!();
    const code = address === null ? -1 : read.i32(address);
    if (code === 17 || (platform === 'darwin' && code === 66)) return false;
    throw new Error(`Could not install the process lease (${code}).`);
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Read only the gate's dedicated token and group; do not retain or log its command line. */
export function verifiedGate(pid: number, token: string): boolean {
  if (!/^[0-9a-f-]{36}$/.test(token)) return false;
  const result = Bun.spawnSync(['ps', '-ww', '-p', String(pid), '-o', 'pgid=', '-o', 'command='], {
    env: processTableEnvironment(),
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return false;
  const text = result.stdout.toString();
  const group = /^\s*(\d+)/.exec(text)?.[1];
  const foundToken = /(?:^|\s)--owned-token=([0-9a-f-]{36})(?:\s|$)/.exec(text)?.[1];
  return Number(group) === pid && foundToken === token && text.includes('owned-process-gate.ts');
}

async function terminateVerifiedGroup(
  lockDirectory: string,
  record: OwnerRecord,
  group: number,
  groupStart: string,
  deadline: number,
): Promise<void> {
  const assertOwnership = async () => {
    const current = await readOwner(lockDirectory);
    if (
      current?.token !== record.token ||
      current.cwd !== record.cwd ||
      current.pid !== record.pid ||
      current.pidStartedAt !== record.pidStartedAt ||
      current.processGroup !== group ||
      current.processGroupStartedAt !== groupStart ||
      exists(record.pid) ||
      processStartTime(group) !== groupStart ||
      !verifiedGate(group, record.token)
    ) {
      throw new Error('Process ownership changed during cleanup.');
    }
  };
  if (performance.now() >= deadline) throw new Error('Owned cleanup budget expired.');
  await assertOwnership();
  if (performance.now() >= deadline) throw new Error('Owned cleanup budget expired.');
  try {
    process.kill(-group, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  const grace = Math.min(performance.now() + 2_000, deadline);
  while (exists(-group) && performance.now() < grace) await Bun.sleep(50);
  if (!exists(-group)) return;
  if (performance.now() >= deadline) throw new Error('Owned cleanup budget expired.');
  await assertOwnership();
  if (performance.now() >= deadline) throw new Error('Owned cleanup budget expired.');
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  while (exists(-group) && performance.now() < deadline) await Bun.sleep(50);
  if (exists(-group))
    throw new Error('Owned process group did not exit within the cleanup budget.');
}

/** Take an atomically published owner lease bound to a particular worktree. */
export async function acquireOwnedProcessLease(
  lockDirectory: string,
  worktree: string,
  command: string,
  beforePublish?: () => void | Promise<void>,
  afterCollision?: () => void | Promise<void>,
  afterBusyGuard?: () => void | Promise<void>,
): Promise<HeldHostLock> {
  const cwd = await realpath(worktree);
  const startedAt = processStartTime(process.pid);
  if (startedAt === undefined) throw new Error('Cannot verify the owner process identity.');
  await mkdir(dirname(lockDirectory), { recursive: true });
  const owner: OwnerRecord = {
    pid: process.pid,
    pidStartedAt: startedAt,
    command,
    cwd,
    acquiredAt: new Date().toISOString(),
    token: crypto.randomUUID(),
  };
  for (;;) {
    if (await installLease(lockDirectory, owner, beforePublish)) break;
    await afterCollision?.();
    const entry = await lstat(lockDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (entry === undefined) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Refusing an unverified existing process lease.');
    const current = await readOwner(lockDirectory);
    if (current === undefined) {
      const remaining = await lstat(lockDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (remaining === undefined || remaining.dev !== entry.dev || remaining.ino !== entry.ino)
        continue;
      throw new Error('Refusing an unverified existing process lease.');
    }
    if (
      current.cwd !== cwd ||
      typeof current.token !== 'string' ||
      !Number.isSafeInteger(current.pid) ||
      current.pid <= 0 ||
      typeof current.pidStartedAt !== 'string'
    ) {
      throw new Error('Refusing a foreign or unverified existing process lease.');
    }
    if (exists(current.pid)) {
      if (processStartTime(current.pid) !== current.pidStartedAt)
        throw new Error('Refusing a reused owner process.');
      await Bun.sleep(50);
    } else {
      try {
        await retireOwnedProcessLease(lockDirectory, cwd);
      } catch (error) {
        if (error instanceof ReclaimGuardBusyError) {
          await afterBusyGuard?.();
          await Bun.sleep(50);
          continue;
        }
        const replacement = await readOwner(lockDirectory);
        if (replacement !== undefined && replacement.token !== current.token) continue;
        throw error;
      }
    }
  }
  try {
    sync(join(lockDirectory, ownerFileName));
    sync(lockDirectory);
    sync(dirname(lockDirectory));
  } catch (error) {
    await removeLock(lockDirectory, owner);
    throw error;
  }
  return {
    token: owner.token,
    release: () => removeLock(lockDirectory, owner),
    recordProcessGroup: async (pid) => {
      const groupStart = processStartTime(pid);
      if (groupStart === undefined) throw new Error('Cannot verify the child process identity.');
      const current = await readOwner(lockDirectory);
      if (
        current?.token !== owner.token ||
        current.pid !== owner.pid ||
        current.pidStartedAt !== owner.pidStartedAt ||
        current.cwd !== cwd
      )
        throw new Error('Process lease ownership changed.');
      await recordProcessGroup(lockDirectory, owner, pid);
      const record = await readOwner(lockDirectory);
      if (
        record?.token !== owner.token ||
        record.processGroup !== pid ||
        record.processGroupStartedAt !== groupStart
      ) {
        throw new Error('The registered child process identity changed.');
      }
      sync(join(lockDirectory, ownerFileName));
      sync(lockDirectory);
    },
  };
}

class ReclaimGuardBusyError extends Error {}

/** Retire a dead owner's verified group; never signal a live or unverified foreign owner. */
export async function retireOwnedProcessLease(
  lockDirectory: string,
  worktree: string,
  deadline = performance.now() + 60_000,
  afterGuard?: () => void | Promise<void>,
  leaveLiveOwner = false,
): Promise<void> {
  const assertBudget = () => {
    if (performance.now() >= deadline) throw new Error('Owned cleanup budget expired.');
  };
  assertBudget();
  const cwd = await realpath(worktree);
  const parent = await lstat(dirname(lockDirectory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (parent === undefined) return;
  const startedAt = processStartTime(process.pid);
  if (startedAt === undefined) throw new Error('Cannot verify the cleanup process identity.');
  const claimant: OwnerRecord = {
    pid: process.pid,
    pidStartedAt: startedAt,
    command: 'retire owned process',
    cwd,
    acquiredAt: new Date().toISOString(),
    token: crypto.randomUUID(),
  };
  const leave = await takeReclaimGuard(lockDirectory, claimant, judgeByProcess);
  if (leave === undefined)
    throw new ReclaimGuardBusyError('Another cleanup owns the process lease guard.');
  try {
    await afterGuard?.();
    assertBudget();
    const prefix = `${basename(lockDirectory)}.pending-`;
    for (const entryName of await readdir(dirname(lockDirectory))) {
      assertBudget();
      if (!entryName.startsWith(prefix)) continue;
      const pending = join(dirname(lockDirectory), entryName);
      const pendingEntry = await lstat(pending, { bigint: true });
      const candidate =
        pendingEntry.isDirectory() && !pendingEntry.isSymbolicLink()
          ? await readOwner(pending)
          : undefined;
      if (
        candidate === undefined ||
        candidate.cwd !== cwd ||
        candidate.token !== entryName.slice(prefix.length) ||
        !Number.isSafeInteger(candidate.pid) ||
        candidate.pid <= 0 ||
        typeof candidate.pidStartedAt !== 'string'
      )
        continue;
      if (exists(candidate.pid)) continue;
      const pendingNames = await readdir(pending);
      const currentEntry = await lstat(pending, { bigint: true });
      const current = await readOwner(pending);
      if (
        pendingNames.length !== 1 ||
        pendingNames[0] !== ownerFileName ||
        currentEntry.dev !== pendingEntry.dev ||
        currentEntry.ino !== pendingEntry.ino ||
        current?.token !== candidate.token
      )
        throw new Error('Pending process ownership changed during cleanup.');
      await removeLock(pending, candidate);
    }
    const initial = await lstat(lockDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (initial === undefined) return;
    if (!initial.isDirectory() || initial.isSymbolicLink())
      throw new Error('Refusing an unverified process lease.');
    const record = await readOwner(lockDirectory);
    if (record === undefined) {
      const entry = await lstat(lockDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (entry !== undefined) throw new Error('Refusing an unverified process lease.');
      return;
    }
    if (
      record.cwd !== cwd ||
      typeof record.token !== 'string' ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.pidStartedAt !== 'string'
    ) {
      throw new Error('Refusing a foreign or invalid process lease.');
    }
    if (exists(record.pid)) {
      if (leaveLiveOwner && processStartTime(record.pid) === record.pidStartedAt) return;
      throw new Error('Refusing to retire a live or reused owner process.');
    }
    if (record.processGroup !== undefined) {
      const group = record.processGroup;
      if (
        !Number.isSafeInteger(group) ||
        group <= 0 ||
        typeof record.processGroupStartedAt !== 'string'
      )
        throw new Error('Refusing an unverified process group.');
      const groupStart = processStartTime(group);
      if (groupStart !== undefined && groupStart !== record.processGroupStartedAt)
        throw new Error('Refusing a reused process group.');
      if (groupStart === undefined) {
        if (exists(-group))
          throw new Error('Refusing a live process group without its verified leader.');
      } else {
        await terminateVerifiedGroup(lockDirectory, record, group, groupStart, deadline);
        if (exists(-group)) throw new Error('Owned process group did not exit.');
      }
    }
    assertBudget();
    await removeLock(lockDirectory, record);
  } finally {
    await leave();
  }
}
