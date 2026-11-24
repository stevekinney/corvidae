import { CString, dlopen, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { acquireLocalRootLockDescriptor, type RootLock } from '@lostgradient/bungalow';

const platform = process.platform;
if (platform !== 'darwin' && platform !== 'linux')
  throw new Error('Fixture reset requires macOS or Linux.');
const closeOnExec = platform === 'darwin' ? 0x01000000 : 0x80000;
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
const lockFlags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
// Darwin's 64-bit dirent has d_name at 21; glibc's 64-bit dirent has it at 19.
const nameOffset = platform === 'darwin' ? 21 : 19;
const removeDirectory = platform === 'darwin' ? 0x80 : 0x200;
const errnoName = platform === 'darwin' ? '__error' : '__errno_location';
const { symbols } = dlopen(platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
  openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  linkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  [errnoName]: { args: [], returns: FFIType.ptr },
});
const name = (value: string) => Buffer.from(`${value}\0`);
const errno = () => {
  const address = symbols[errnoName]!();
  return address === null ? -1 : read.i32(address);
};

async function lockDirectory(
  root: string,
  rootDescriptor: number,
  directoryDescriptor: number,
  label: string,
): Promise<RootLock> {
  const lockName = name('lock');
  let lockDescriptor = symbols.openat(directoryDescriptor, ptr(lockName), lockFlags);
  if (lockDescriptor < 0) {
    const temporary = `.fixture-lock-${crypto.randomUUID()}`;
    const temporaryName = name(temporary);
    const created = openSync(
      join(root, temporary),
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(created);
    symbols.linkat(rootDescriptor, ptr(temporaryName), directoryDescriptor, ptr(lockName), 0);
    if (symbols.unlinkat(rootDescriptor, ptr(temporaryName), 0) !== 0)
      throw new Error('Could not remove the temporary fixture lock.');
    lockDescriptor = symbols.openat(directoryDescriptor, ptr(lockName), lockFlags);
    if (lockDescriptor < 0) throw new Error('Could not open the fixture lock.');
  }
  return acquireLocalRootLockDescriptor(lockDescriptor, label);
}

/** Take the same inode lock whether this directory is a disposable root or someone's home. */
export async function lockFixtureRoot(root: string): Promise<RootLock> {
  const descriptor = openSync(root, directoryFlags);
  try {
    return await lockDirectory(root, descriptor, descriptor, root);
  } finally {
    closeSync(descriptor);
  }
}

function entries(directoryDescriptor: number): string[] {
  const dot = name('.');
  const duplicate = symbols.openat(directoryDescriptor, ptr(dot), directoryFlags);
  if (duplicate < 0) throw new Error(`Could not open fixture directory for reading (${errno()}).`);
  const stream = symbols.fdopendir(duplicate);
  if (stream === null) {
    closeSync(duplicate);
    throw new Error(`Could not read fixture directory (${errno()}).`);
  }
  const result: string[] = [];
  let failure: unknown;
  try {
    for (;;) {
      const address = symbols[errnoName]!();
      if (address === null) throw new Error('Could not inspect filesystem errors.');
      new DataView(toArrayBuffer(address, 0, 4)).setInt32(0, 0, true);
      const entry = symbols.readdir(stream);
      if (entry === null) {
        if (errno() !== 0) throw new Error(`Could not enumerate fixture directory (${errno()}).`);
        break;
      }
      const entryName = new CString(entry, nameOffset);
      if (entryName !== '.' && entryName !== '..') result.push(entryName);
    }
  } catch (error) {
    failure = error;
  }
  const closed = symbols.closedir(stream);
  if (failure !== undefined) throw failure;
  if (closed !== 0) throw new Error(`Could not close fixture directory (${errno()}).`);
  return result;
}

function clearDirectory(
  directoryDescriptor: number,
  device: bigint,
  preserveLock: boolean,
  afterRemove?: () => void,
): void {
  for (const entry of entries(directoryDescriptor)) {
    if (preserveLock && entry === 'lock') continue;
    const entryName = name(entry);
    const child = symbols.openat(directoryDescriptor, ptr(entryName), directoryFlags);
    if (child >= 0) {
      try {
        if (fstatSync(child, { bigint: true }).dev !== device)
          throw new Error('Fixture reset refuses a different filesystem.');
        clearDirectory(child, device, false, afterRemove);
      } finally {
        closeSync(child);
      }
      if (symbols.unlinkat(directoryDescriptor, ptr(entryName), removeDirectory) !== 0)
        throw new Error(`Could not remove a fixture directory (${errno()}).`);
    } else {
      const code = errno();
      if (code !== 20 && code !== (platform === 'darwin' ? 62 : 40))
        throw new Error(`Could not inspect a fixture entry (${code}).`);
      if (symbols.unlinkat(directoryDescriptor, ptr(entryName), 0) !== 0)
        throw new Error(`Could not remove a fixture entry (${errno()}).`);
    }
    afterRemove?.();
  }
}

/** Reset the pinned home in place, preserving its directory and permanent lock inode. */
export async function resetPinnedDirectory(
  root: string,
  child: string,
  afterLock?: (names: readonly string[]) => void | Promise<void>,
  expectedIdentity?: { readonly dev: string; readonly ino: string },
  beforeLock?: (identity: { readonly dev: string; readonly ino: string }) => Promise<void>,
  afterRemove?: () => void,
): Promise<RootLock> {
  const rootDescriptor = openSync(root, directoryFlags);
  let homeDescriptor = -1;
  let lock: RootLock | undefined;
  try {
    const childName = name(child);
    homeDescriptor = symbols.openat(rootDescriptor, ptr(childName), directoryFlags);
    if (homeDescriptor < 0) throw new Error('Could not pin the fixture home.');
    const pinned = fstatSync(homeDescriptor, { bigint: true });
    const identity = { dev: pinned.dev.toString(), ino: pinned.ino.toString() };
    if (pinned.dev !== fstatSync(rootDescriptor, { bigint: true }).dev)
      throw new Error('Fixture home is on a different filesystem.');
    if (
      expectedIdentity !== undefined &&
      (identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino)
    )
      throw new Error('Fixture changed before it was pinned.');
    await beforeLock?.(identity);
    lock = await lockDirectory(root, rootDescriptor, homeDescriptor, join(root, child));
    const names = entries(homeDescriptor);
    if (names.includes('.fixture-root'))
      throw new Error('A disposable root cannot also be a fixture home.');
    await afterLock?.(names);
    const current = lstatSync(join(root, child), { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== pinned.dev ||
      current.ino !== pinned.ino
    )
      throw new Error('Fixture changed during reset.');
    clearDirectory(homeDescriptor, pinned.dev, true, afterRemove);
    const afterReset = lstatSync(join(root, child), { bigint: true });
    if (
      !afterReset.isDirectory() ||
      afterReset.isSymbolicLink() ||
      afterReset.dev !== pinned.dev ||
      afterReset.ino !== pinned.ino
    )
      throw new Error('Fixture changed during reset.');
    return lock;
  } catch (error) {
    lock?.release();
    throw error;
  } finally {
    if (homeDescriptor >= 0) closeSync(homeDescriptor);
    closeSync(rootDescriptor);
  }
}
