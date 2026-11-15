import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';

import { errorCode } from './error-code.ts';
import { BungalowStateError } from './errors.ts';

/**
 * The one place that decides whether an entry inside a root is what Bungalow expects before it
 * opens, reads, changes the mode of, truncates, or sweeps it.
 *
 * A root lives in a directory the user and other tools also write to, so a path inside it can be
 * a symbolic link to somewhere else, a second hard link to a file elsewhere, or a FIFO that blocks
 * an `open` forever. Following or trusting any of those lets a `chmod`, a truncation, or a read
 * land on something that is not Bungalow's. So every entry is opened with `O_NOFOLLOW` and
 * `O_NONBLOCK`, and the descriptor, not the path, is then checked with `fstat`: a directory must
 * be a real directory, and a file must be a regular file with exactly one link. Only after that is
 * anything done through the descriptor. A failure is a `BungalowStateError` that names the kind of
 * entry (`lock file`, `secrets directory`) and never a secret's key.
 *
 * The one exception is `readEntryConcurrently`, for a reader that holds no lock: a writer can
 * replace the file it opened, which leaves a link count of 0, so it reads what it opened.
 */

export type EntryKind = 'directory' | 'file';

const DIRECTORY_MODE = 0o700;

function describeProblem(path: string, expected: EntryKind): string | undefined {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return 'a symbolic link';
    if (expected === 'directory' && !status.isDirectory()) return 'not a directory';
    return undefined;
  } catch {
    return undefined;
  }
}

function verify(status: Stats, expected: EntryKind, tolerateReplaced: boolean): string | undefined {
  if (expected === 'directory') return status.isDirectory() ? undefined : 'not a directory';
  if (!status.isFile()) return 'not a regular file';
  // A link count of 0 is a file a writer replaced by rename, or `reclaim` deleted, after this
  // descriptor opened it. It has no path left, so it cannot share a link with another one.
  if (tolerateReplaced && status.nlink === 0) return undefined;
  return status.nlink === 1 ? undefined : 'a hard link shared with another path';
}

/**
 * A hook that runs once an entry is open and before it is checked, so a test can change the entry
 * in exactly the window a concurrent writer can. Tests only: nothing in the package sets it.
 */
let afterOpenHook: ((path: string) => void) | undefined;

/** Set (or, with `undefined`, clear) the hook that runs between an open and its check. */
export function setAfterOpenHook(hook: ((path: string) => void) | undefined): void {
  afterOpenHook = hook;
}

/**
 * Open an entry, refusing a symbolic link, a FIFO, a device, and (for a file) a second hard link.
 * Returns a descriptor that is already known to be the right kind of entry; the caller closes it.
 * A missing entry throws the underlying `ENOENT`, and so does any other failure to open. A file
 * whose link count is not exactly 1 is always refused here, a replaced one (0) included; only
 * `readEntryConcurrently` reads one.
 */
export function openEntry(
  path: string,
  label: string,
  expected: EntryKind,
  flags: number,
  mode?: number,
): number {
  return openChecked(path, label, expected, flags, mode, false);
}

function openChecked(
  path: string,
  label: string,
  expected: EntryKind,
  flags: number,
  mode: number | undefined,
  tolerateReplaced: boolean,
): number {
  let descriptor: number;
  try {
    descriptor = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      const problem = describeProblem(path, expected);
      if (problem !== undefined) throw new BungalowStateError(`The ${label} is ${problem}.`);
    }
    throw error;
  }
  try {
    afterOpenHook?.(path);
    const problem = verify(fstatSync(descriptor), expected, tolerateReplaced);
    if (problem !== undefined) throw new BungalowStateError(`The ${label} is ${problem}.`);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return descriptor;
}

/** Make a directory entry durable: an entry is only as durable as the directory that names it. */
export function syncDirectory(path: string): void {
  const descriptor = openEntry(path, 'directory', 'directory', constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Make sure `path` is a real directory, creating it (and any missing parents) if absent. Every
 * directory this creates is made durable by syncing its parent. With `privateMode`, an existing
 * directory is also set to 0700, through the descriptor that was just checked.
 */
export function ensureDirectory(
  path: string,
  label: string,
  options: { readonly privateMode?: boolean } = {},
): void {
  let firstCreated: string | undefined;
  try {
    firstCreated = mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
  } catch (error) {
    // Something that is not a directory is already there; the check below says what it is.
    if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOTDIR') throw error;
  }
  if (firstCreated !== undefined) {
    for (let created = path; ; created = dirname(created)) {
      syncDirectory(dirname(created));
      if (created === firstCreated) break;
    }
  }
  const descriptor = openEntry(path, label, 'directory', constants.O_RDONLY);
  try {
    if (options.privateMode === true) fchmodSync(descriptor, DIRECTORY_MODE);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Whether a real directory is at `path`, which creates and changes nothing: a missing entry is
 * `false`, and a symbolic link or anything that is not a directory is a `BungalowStateError`.
 */
export function directoryExists(path: string, label: string): boolean {
  let descriptor: number;
  try {
    descriptor = openEntry(path, label, 'directory', constants.O_RDONLY);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  closeSync(descriptor);
  return true;
}

/**
 * The text of a regular file, or `undefined` when it does not exist. With `tighten`, a file that
 * group or others can reach is set back to `tighten` before it is read.
 */
export function readEntry(path: string, label: string, tighten?: number): string | undefined {
  let descriptor: number;
  try {
    descriptor = openEntry(path, label, 'file', constants.O_RDONLY);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    if (tighten !== undefined && (fstatSync(descriptor).mode & 0o077) !== 0) {
      fchmodSync(descriptor, tighten);
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The text of a regular file, or `undefined` when it does not exist, for a reader that holds no
 * lock and so can race a writer. A writer replaces a file by rename, and `reclaim` deletes one; a
 * descriptor opened just before that reports a link count of 0 and still reads the content it
 * opened, which is the old content and never an error. A file with a second link is still refused,
 * and this never changes a mode, so a reader that must tighten one uses `readEntry`.
 */
export function readEntryConcurrently(path: string, label: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openChecked(path, label, 'file', constants.O_RDONLY, undefined, true);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** Write every byte, since `writeSync` may write fewer than it was given. */
function writeFully(descriptor: number, contents: Buffer): void {
  let offset = 0;
  while (offset < contents.length) {
    offset += writeSync(descriptor, contents, offset, contents.length - offset);
  }
}

/**
 * Write a file that is 0600 from its first byte, then rename it into place and sync the entry.
 * The rename replaces whatever entry was at `path` (a symbolic link, a FIFO, a stale file) rather
 * than writing through it, so a write can never land on something that is not Bungalow's.
 */
export function writePrivateFile(
  path: string,
  contents: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const temporary = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openEntry(
      temporary,
      'temporary file',
      'file',
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFully(descriptor, Buffer.from(contents));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    rename(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was never created, or is already gone.
    }
    throw error;
  }
  syncDirectory(dirname(path));
}
