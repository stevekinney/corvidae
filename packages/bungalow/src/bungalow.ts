import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { processEnvironment } from './environment-configuration.ts';
import { errorCode } from './error-code.ts';
import { BungalowFilesystemError, BungalowInputError, BungalowStateError } from './errors.ts';
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
  /** Release the lock. Idempotent. A temporary Bungalow also removes its root. */
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

/** Run a filesystem step, rethrowing any failure as a typed error that never carries a value. */
function filesystem<Result>(description: string, step: () => Result): Result {
  try {
    return step();
  } catch (error) {
    if (error instanceof BungalowFilesystemError || error instanceof BungalowStateError) {
      throw error;
    }
    throw new BungalowFilesystemError(`Could not ${description}.`, { cause: error });
  }
}

function makeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE });
}

/** Write a file that is 0600 from its first byte, then rename it into place. */
function writePrivateFile(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', SECRET_MODE);
    writeSync(descriptor, contents);
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

/** Open the Bungalow rooted at `root`, with no environment or test-mode policy applied. */
function openAtRoot(name: string, root: string, onClose?: () => void): Bungalow {
  filesystem('create the root directory', () => makeDirectory(root));
  const lock: RootLock = acquireRootLock(root);
  let deploymentId: string;
  const secrets = join(root, 'secrets');
  const logs = join(root, 'logs');
  try {
    filesystem('create the secrets and logs directories', () => {
      makeDirectory(secrets);
      makeDirectory(logs);
    });
    deploymentId = filesystem('persist the deployment identifier', () =>
      loadDeploymentId(join(root, 'deployment-id')),
    );
  } catch (error) {
    lock.release();
    throw error;
  }

  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new BungalowStateError('This Bungalow is closed.');
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      lock.release();
    } finally {
      onClose?.();
    }
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
      filesystem(`create the "${directoryName}" directory`, () => makeDirectory(path));
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
      return filesystem('read a secret', () => {
        try {
          return readFileSync(join(secrets, key), 'utf8');
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return undefined;
          throw error;
        }
      });
    },
    close,
    [Symbol.dispose]: close,
  };
}

/**
 * Open (creating if needed) an application's home and take its single-instance lock. The root is
 * `<NAME>_HOME` or `~/.<name>`; see `resolveBungalowRoot`.
 *
 * Under `NODE_ENV=test` with `<NAME>_HOME` unset this throws rather than touch the real home
 * directory. A test points `<NAME>_HOME` at a disposable directory or calls `openTemporaryBungalow`.
 */
export function openBungalow(options: OpenBungalowOptions): Bungalow {
  assertBungalowName(options.name);
  const environment = options.environment ?? processEnvironment();
  const variable = bungalowHomeVariable(options.name);
  const override = environment[variable];
  if (environment['NODE_ENV'] === 'test' && (override === undefined || override === '')) {
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
    rmSync(root, { recursive: true, force: true });
  };
  try {
    chmodSync(root, DIRECTORY_MODE);
    return openAtRoot(options.name, root, remove);
  } catch (error) {
    remove();
    throw error;
  }
}
