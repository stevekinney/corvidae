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

function verify(status: Stats, expected: EntryKind): string | undefined {
  if (expected === 'directory') return status.isDirectory() ? undefined : 'not a directory';
  if (!status.isFile()) return 'not a regular file';
  return status.nlink === 1 ? undefined : 'a hard link shared with another path';
}

/**
 * Open an entry, refusing a symbolic link, a FIFO, a device, and (for a file) a second hard link.
 * Returns a descriptor that is already known to be the right kind of entry; the caller closes it.
 * A missing entry throws the underlying `ENOENT`, and so does any other failure to open.
 */
export function openEntry(
  path: string,
  label: string,
  expected: EntryKind,
  flags: number,
  mode?: number,
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
    const problem = verify(fstatSync(descriptor), expected);
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
