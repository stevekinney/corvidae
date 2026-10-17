import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { processEnvironment } from './environment-configuration.ts';
import { errorCode, sanitizeCause } from './error-code.ts';
import {
  BungalowError,
  BungalowFilesystemError,
  BungalowInputError,
  BungalowStateError,
} from './errors.ts';
import { acquireRootLock, type RootLock } from './lock.ts';
import {
  bungalowHomeVariable,
  resolveBungalowRoot,
  type BungalowEnvironment,
} from './resolve-root.ts';
import { generateUlid, isUlid } from './ulid.ts';
import { assertBungalowName, assertDirectoryName, assertSecretKey } from './validation.ts';

const DIRECTORY_MODE = 0o700;
const SECRET_MODE = 0o600;
/** The temporary files `writePrivateFile` makes: `<target>.<pid>-<uuid>.tmp`. */
const TEMPORARY_FILE = /\.\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/** An open application home. Holding one holds the root's single-instance lock. */
export type Bungalow = {
  readonly name: string;
  /** The absolute path of the root directory. */
  readonly root: string;
  /** `<root>/database.sqlite`. Bungalow never creates it. */
  readonly database: string;
  /** `<root>/configuration.json`. Bungalow never creates it, and its absence is valid. */
  readonly configuration: string;
  /** `<root>/secrets`, mode 0700, one 0600 file per secret. */
  readonly secrets: string;
  /** `<root>/logs`. */
  readonly logs: string;
  /** A ULID generated when the root was first opened and the same on every reopen. */
  readonly deploymentId: string;
  /** Create `<root>/<name>` (mode 0700) if absent and return its absolute path. */
  directory(name: string): string;
  /** Store `value` in its own 0600 file, replacing any earlier value. */
  writeSecret(key: string, value: string): void;
  /** The stored value, or `undefined` when the key has never been written. */
  readSecret(key: string): string | undefined;
  /** Release the lock. Idempotent once it has succeeded; a failed close can be retried. */
  close(): void;
  [Symbol.dispose](): void;
};

export type OpenBungalowOptions = {
  readonly name: string;
  /** Defaults to the process environment. */
  readonly environment?: BungalowEnvironment;
  /** Defaults to the user's home directory. */
  readonly homeDirectory?: string;
};

export type OpenTemporaryBungalowOptions = {
  readonly name: string;
};

/** Run a filesystem step, rethrowing any failure as a typed error that never carries a path. */
function filesystem<Result>(description: string, step: () => Result): Result {
  try {
    return step();
  } catch (error) {
    if (error instanceof BungalowError) throw error;
    throw new BungalowFilesystemError(`Could not ${description}.`, {
      cause: sanitizeCause(error),
    });
  }
}

function makeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
}

/** Create the directory if absent, and make it private if it already was not. */
function ensurePrivateDirectory(path: string): void {
  makeDirectory(path);
  chmodSync(path, DIRECTORY_MODE);
}

/** Make the rename durable: a file is only as durable as the directory entry that names it. */
function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
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

/** Write a file that is 0600 from its first byte, then rename it into place and sync the entry. */
function writePrivateFile(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', SECRET_MODE);
    writeFully(descriptor, Buffer.from(contents));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
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

/** Read a secret, first tightening a file that group or others can reach. */
function readPrivateFile(path: string): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) throw new BungalowStateError('A stored secret is not a regular file.');
    if ((status.mode & 0o077) !== 0) fchmodSync(descriptor, SECRET_MODE);
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Remove the temporary files a crash left behind. Only the lock holder may call this, since no one
 * else can then be mid-write, and only files named the way `writePrivateFile` names them go.
 */
function removeTemporaryFiles(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && TEMPORARY_FILE.test(entry.name)) unlinkSync(join(directory, entry.name));
  }
}

/** The persisted deployment identifier, generated on the first open. */
function loadDeploymentId(path: string): string {
  let stored: string | undefined;
  try {
    stored = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  if (stored === undefined) {
    const created = generateUlid();
    writePrivateFile(path, `${created}\n`);
    return created;
  }
  if (!isUlid(stored)) {
    throw new BungalowStateError(
      'The deployment-id file does not hold a ULID. Remove it to generate a new identity.',
    );
  }
  return stored;
}

/** What `openAtRoot` takes from outside, so a test can describe a lock that fails to release. */
export type OpenAtRootDependencies = {
  readonly acquireLock?: (root: string) => RootLock;
  readonly onClose?: () => void;
};

/**
 * Open the Bungalow rooted at `root`, with no environment or test-mode policy applied. Not part
 * of the package's public surface.
 */
export function openAtRoot(
  name: string,
  root: string,
  dependencies: OpenAtRootDependencies = {},
): Bungalow {
  const { acquireLock = acquireRootLock, onClose } = dependencies;
  filesystem('create the root directory', () => ensurePrivateDirectory(root));
  const lock = acquireLock(root);
  const secrets = join(root, 'secrets');
  const logs = join(root, 'logs');
  let deploymentId: string;
  try {
    filesystem('prepare the root directory', () => {
      ensurePrivateDirectory(secrets);
      makeDirectory(logs);
      removeTemporaryFiles(root);
      removeTemporaryFiles(secrets);
    });
    deploymentId = filesystem('persist the deployment identifier', () =>
      loadDeploymentId(join(root, 'deployment-id')),
    );
  } catch (error) {
    try {
      lock.release();
    } catch {
      // The open already failed; its error is the one worth reporting.
    }
    throw error;
  }

  // `released` ends the handle's use of the root; `finished` also covers `onClose`. Each is set
  // only once its step has succeeded, so a close that failed can be tried again.
  let released = false;
  let finished = false;
  const assertOpen = (): void => {
    if (released) throw new BungalowStateError('This Bungalow is closed.');
  };

  const close = (): void => {
    if (finished) return;
    if (!released) {
      lock.release();
      released = true;
    }
    onClose?.();
    finished = true;
  };

  return {
    name,
    root,
    database: join(root, 'database.sqlite'),
    configuration: join(root, 'configuration.json'),
    secrets,
    logs,
    deploymentId,
    directory(directoryName) {
      assertOpen();
      assertDirectoryName(directoryName);
      const path = join(root, directoryName);
      filesystem('create a content directory', () => makeDirectory(path));
      return path;
    },
    writeSecret(key, value) {
      assertOpen();
      assertSecretKey(key);
      filesystem('write a secret', () => writePrivateFile(join(secrets, key), value));
    },
    readSecret(key) {
      assertOpen();
      assertSecretKey(key);
      return filesystem('read a secret', () => readPrivateFile(join(secrets, key)));
    },
    close,
    [Symbol.dispose]: close,
  };
}

function isEmpty(value: string | undefined): boolean {
  return value === undefined || value === '';
}

/**
 * Open (creating if needed) an application's home and take its single-instance lock. The root is
 * `<NAME>_HOME` or `~/.<name>`; see `resolveBungalowRoot`.
 *
 * Under `NODE_ENV=test` with no `<NAME>_HOME` in effect this throws rather than touch the real
 * home directory. The process's own environment counts as well as the one passed in, so passing
 * an empty environment cannot opt a test out. A test points `<NAME>_HOME` at a disposable
 * directory or calls `openTemporaryBungalow`.
 */
export function openBungalow(options: OpenBungalowOptions): Bungalow {
  assertBungalowName(options.name);
  const environment = options.environment ?? processEnvironment();
  const variable = bungalowHomeVariable(options.name);
  const underTest =
    environment['NODE_ENV'] === 'test' || processEnvironment()['NODE_ENV'] === 'test';
  if (underTest && isEmpty(environment[variable])) {
    throw new BungalowInputError(
      `Refusing to open the real ${options.name} home directory under NODE_ENV=test. ` +
        `Set ${variable} to a disposable directory, or use openTemporaryBungalow.`,
    );
  }
  const root = resolveBungalowRoot({
    name: options.name,
    environment,
    homeDirectory: options.homeDirectory ?? homedir(),
  });
  return openAtRoot(options.name, root);
}

/**
 * Open a Bungalow in a fresh directory under the operating system's temporary directory, and
 * remove that directory on `close()`. Independent of `<NAME>_HOME` and safe under `NODE_ENV=test`.
 */
export function openTemporaryBungalow(options: OpenTemporaryBungalowOptions): Bungalow {
  assertBungalowName(options.name);
  const root = filesystem('create the temporary root', () =>
    mkdtempSync(join(tmpdir(), `${options.name}-`)),
  );
  const remove = (): void => {
    filesystem('remove the temporary root', () => {
      rmSync(root, { recursive: true, force: true });
    });
  };
  try {
    return openAtRoot(options.name, root, { onClose: remove });
  } catch (error) {
    try {
      remove();
    } catch {
      // The open already failed; its error is the one worth reporting.
    }
    throw error;
  }
}
