import {
  closeSync,
  constants,
  fsyncSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ensureDirectory, openEntry, readEntry, syncDirectory } from './entry-guard.ts';
import { processEnvironment } from './environment-configuration.ts';
import { sanitizeCause } from './error-code.ts';
import {
  BungalowError,
  BungalowFilesystemError,
  BungalowInputError,
  BungalowStateError,
} from './errors.ts';
import { acquireRootLock, type RootLock } from './lock.ts';
import { remoteConfiguration } from './remote-configuration.ts';
import { openRemoteBungalow } from './remote.ts';
import {
  bungalowHomeVariable,
  resolveBungalowRoot,
  type BungalowEnvironment,
} from './resolve-root.ts';
import { generateUlid, isUlid } from './ulid.ts';
import { assertBungalowName, assertDirectoryName, assertSecretKey } from './validation.ts';

const SECRET_MODE = 0o600;
/** `<pid>-<uuid>`, the middle of the name `writePrivateFile` gives a temporary file. */
const TEMPORARY_SUFFIX =
  '\\.\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp';
/** The only temporary file Bungalow writes in the root: beside `deployment-id`. */
const ROOT_TEMPORARY_FILE = new RegExp(`^deployment-id${TEMPORARY_SUFFIX}$`);
/** The only temporary files Bungalow writes in `secrets/`: beside a valid secret key. */
const SECRET_TEMPORARY_FILE = new RegExp(`^[a-z0-9][a-z0-9-]*${TEMPORARY_SUFFIX}$`);

/** Where the application database lives: a SQLite file in local mode, a server in remote mode. */
export type DatabaseLocation =
  | { readonly kind: 'sqlite'; readonly path: string }
  | { readonly kind: 'postgres'; readonly url: string };

/** Where a named body of content lives: a directory in local mode, an object-store prefix remotely. */
export type ContentLocation =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 's3'; readonly bucket: string; readonly prefix: string };

/**
 * An open application home. Holding a local one holds the root's single-instance lock; a remote
 * one holds no lock.
 */
export type Bungalow = {
  readonly name: string;
  /** `'local'` when the home is a directory on this machine, `'remote'` when it is served elsewhere. */
  readonly mode: 'local' | 'remote';
  /**
   * Local mode: `{ kind: 'sqlite', path: '<root>/database.sqlite' }`, a file Bungalow never
   * creates. Remote mode: `{ kind: 'postgres', url }` from `<NAME>_DATABASE_URL`.
   */
  readonly database: DatabaseLocation;
  /**
   * Where the configuration lives, for messages and for a person editing it by hand: the path of
   * `<root>/configuration.json` in local mode, `s3://<bucket>/<prefix>configuration.json` in remote
   * mode. Bungalow never creates it.
   */
  readonly configurationLocation: string;
  /** `<root>/logs` in local mode; `undefined` in remote mode, which has no local directory. */
  readonly logs: string | undefined;
  /** A ULID generated when the root was first opened and the same on every reopen. */
  readonly deploymentId: string;
  /**
   * Where the content named `name` lives: a mode-0700 `<root>/<name>` directory locally, created if
   * absent, or `{ kind: 's3', bucket, prefix: '<prefix><name>/' }` remotely, which creates nothing.
   */
  content(name: string): ContentLocation;
  /** The `Bun.S3Client` remote mode configured from the environment, or `undefined` locally. */
  s3Client(): Bun.S3Client | undefined;
  /** The text of the configuration, or `undefined` when none has been written. Absence is valid. */
  readConfiguration(): Promise<string | undefined>;
  /**
   * Where the secret `key` is stored: its 0600 file path in local mode, the name of its
   * `<NAME>_SECRET_<KEY>` variable in remote mode. The key is validated.
   */
  secretLocation(key: string): string;
  /**
   * Store `value` in its own 0600 file, replacing any earlier value. Remote mode reads secrets from
   * the environment, so there it throws `BungalowStateError`.
   */
  writeSecret(key: string, value: string): void;
  /**
   * The stored value, or `undefined` when the key has never been written (locally) or its
   * variable is unset or empty (remotely).
   */
  readSecret(key: string): string | undefined;
  /**
   * End the handle: release the lock locally. Idempotent once it has succeeded; a failed close can
   * be retried.
   */
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
function writePrivateFile(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openEntry(
      temporary,
      'temporary file',
      'file',
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      SECRET_MODE,
    );
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

/**
 * Remove the temporary files a crash left behind. Only the lock holder may call this, since no one
 * else can then be mid-write, and only files named exactly the way `writePrivateFile` names them
 * for this directory go. `unlink` removes a name and never follows it, and a symbolic link is not
 * a file here, so the sweep neither deletes through a link nor descends into one.
 */
function removeTemporaryFiles(directory: string, ours: RegExp): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && ours.test(entry.name)) unlinkSync(join(directory, entry.name));
  }
}

/** The persisted deployment identifier, generated on the first open. */
function loadDeploymentId(path: string): string {
  const stored = readEntry(path, 'deployment-id file')?.trim();
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
  filesystem('prepare the root directory', () =>
    ensureDirectory(root, 'root directory', { privateMode: true }),
  );
  const lock = acquireLock(root);
  const secrets = join(root, 'secrets');
  const logs = join(root, 'logs');
  const configurationLocation = join(root, 'configuration.json');
  let deploymentId: string;
  try {
    filesystem('prepare the secrets directory', () =>
      ensureDirectory(secrets, 'secrets directory', { privateMode: true }),
    );
    filesystem('prepare the logs directory', () => ensureDirectory(logs, 'logs directory'));
    filesystem('remove leftover temporary files', () => {
      removeTemporaryFiles(root, ROOT_TEMPORARY_FILE);
      removeTemporaryFiles(secrets, SECRET_TEMPORARY_FILE);
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
    mode: 'local',
    database: { kind: 'sqlite', path: join(root, 'database.sqlite') },
    configurationLocation,
    logs,
    deploymentId,
    s3Client() {
      assertOpen();
      return undefined;
    },
    content(contentName) {
      assertOpen();
      assertDirectoryName(contentName);
      const path = join(root, contentName);
      filesystem('prepare a content directory', () => ensureDirectory(path, 'content directory'));
      return { kind: 'directory', path };
    },
    async readConfiguration() {
      assertOpen();
      return filesystem('read the configuration', () =>
        readEntry(configurationLocation, 'configuration file'),
      );
    },
    secretLocation(key) {
      assertOpen();
      assertSecretKey(key);
      return join(secrets, key);
    },
    writeSecret(key, value) {
      assertOpen();
      assertSecretKey(key);
      filesystem('write a secret', () => writePrivateFile(join(secrets, key), value));
    },
    readSecret(key) {
      assertOpen();
      assertSecretKey(key);
      return filesystem('read a secret', () =>
        readEntry(join(secrets, key), 'secret file', SECRET_MODE),
      );
    },
    close,
    [Symbol.dispose]: close,
  };
}

function isEmpty(value: string | undefined): boolean {
  return value === undefined || value === '';
}

/**
 * The root `openBungalow` will use: `resolveBungalowRoot` with the process's home directory as the
 * default. Pure, so a test can check the default without opening anything.
 */
export function resolveOpenRoot(options: OpenBungalowOptions): string {
  return resolveBungalowRoot({
    name: options.name,
    environment: options.environment ?? processEnvironment(),
    homeDirectory: options.homeDirectory ?? homedir(),
  });
}

/**
 * Open (creating if needed) an application's home. The promise resolves once the home is ready; a
 * failure rejects it.
 *
 * With both `<NAME>_DATABASE_URL` and `<NAME>_BUCKET` set, the home is remote: Postgres, an S3
 * bucket configured by `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and
 * optionally `S3_SESSION_TOKEN` and `<NAME>_BUCKET_PREFIX`, and secrets in `<NAME>_SECRET_<KEY>`.
 * `<NAME>_HOME` is then not read and no lock is taken. With exactly one of the two set, or a
 * required S3 variable missing, this throws `BungalowInputError` naming it, before any request.
 *
 * Otherwise the home is local and this takes its single-instance lock. The root is `<NAME>_HOME`
 * or `~/.<name>`; see `resolveBungalowRoot`. Under `NODE_ENV=test` with no `<NAME>_HOME` in effect
 * a local open throws rather than touch the real home directory. The process's own environment
 * counts as well as the one passed in, so passing an empty environment cannot opt a test out. A
 * test points `<NAME>_HOME` at a disposable directory or calls `openTemporaryBungalow`.
 */
export async function openBungalow(options: OpenBungalowOptions): Promise<Bungalow> {
  return openBungalowWithDependencies(options);
}

/**
 * `openBungalow` with the local lock injectable, so a test can show that remote mode never asks
 * for it: an `acquireLock` that throws fails a local open and leaves a remote one untouched. Not
 * part of the package's public surface.
 */
export async function openBungalowWithDependencies(
  options: OpenBungalowOptions,
  dependencies: OpenAtRootDependencies = {},
): Promise<Bungalow> {
  assertBungalowName(options.name);
  const environment = options.environment ?? processEnvironment();
  const remote = remoteConfiguration(options.name, environment);
  if (remote !== undefined) return openRemoteBungalow(options.name, remote);
  const variable = bungalowHomeVariable(options.name);
  const underTest =
    environment['NODE_ENV'] === 'test' || processEnvironment()['NODE_ENV'] === 'test';
  if (underTest && isEmpty(environment[variable])) {
    throw new BungalowInputError(
      `Refusing to open the real ${options.name} home directory under NODE_ENV=test. ` +
        `Set ${variable} to a disposable directory, or use openTemporaryBungalow.`,
    );
  }
  const root = resolveOpenRoot({ ...options, environment });
  return openAtRoot(options.name, root, dependencies);
}

/** The temporary directory as an absolute path, since `TMPDIR` is allowed to be relative. */
export function absoluteTemporaryDirectory(base: string = tmpdir()): string {
  return resolve(base);
}

/**
 * Open a Bungalow in a fresh directory under the operating system's temporary directory, and
 * remove that directory on `close()`. Independent of `<NAME>_HOME` and safe under `NODE_ENV=test`.
 */
export async function openTemporaryBungalow(
  options: OpenTemporaryBungalowOptions,
): Promise<Bungalow> {
  assertBungalowName(options.name);
  const root = filesystem('create the temporary root', () =>
    mkdtempSync(join(absoluteTemporaryDirectory(), `${options.name}-`)),
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
