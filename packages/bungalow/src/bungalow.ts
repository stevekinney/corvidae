import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ObjectPresigner } from '@lostgradient/object-store';
import type {
  ConfigurationSnapshot,
  ConfigurationWriteCapability,
  ConfigurationWriteCondition,
  ConfigurationWriteResult,
} from './configuration.ts';
import {
  assertConfigurationWrite,
  localConfigurationSnapshot,
  writeLocalConfiguration,
} from './configuration.ts';
import {
  injectedDeploymentSecrets,
  type DeploymentSecrets,
  type DeploymentSecretsFactory,
} from './deployment-secrets.ts';
import {
  directoryExists,
  ensureDirectory,
  readEntry,
  readEntryConcurrently,
  writePrivateFile,
} from './entry-guard.ts';
import { processEnvironment } from './environment-configuration.ts';
import { sanitizeCause } from './error-code.ts';
import {
  BungalowError,
  BungalowFilesystemError,
  BungalowInputError,
  BungalowStateError,
} from './errors.ts';
import { defaultAcquireLock, type RootLock } from './lock.ts';
import type { BungalowObjectStore } from './object-store.ts';
import { resolveRemoteDescriptor, type RemoteBungalowDescriptor } from './remote-configuration.ts';
import { openRemoteBungalow, requireDatabaseWorkspaceClaim } from './remote.ts';
import {
  absoluteRoot,
  bungalowHomeVariable,
  resolveBungalowRoot,
  type BungalowEnvironment,
} from './resolve-root.ts';
import {
  createLocalProvider,
  createLocalSecretProvider,
  type SecretProvider,
} from './secret-provider.ts';
import { generateUlid, isUlid } from './ulid.ts';
import { assertBungalowName, assertDirectoryName, assertSecretKey } from './validation.ts';

const SECRET_MODE = 0o600;
/** `<pid>-<uuid>`, the middle of the name `writePrivateFile` gives a temporary file. */
const TEMPORARY_SUFFIX =
  '\\.\\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp';
/** The only temporary files Bungalow writes in the root: beside `deployment-id` and `configuration.json`. */
const ROOT_TEMPORARY_FILE = new RegExp(
  `^(?:deployment-id|configuration\\.json|workspace-id)${TEMPORARY_SUFFIX}$`,
);
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
 * An open application home. Holding a local read-write one holds the root's single-instance lock;
 * a remote one, and a local one opened with `access: 'read'`, hold no lock.
 */
export type Bungalow = {
  readonly name: string;
  /** `'local'` when the home is a directory on this machine, `'remote'` when it is served elsewhere. */
  readonly mode: 'local' | 'remote';
  /**
   * What the home is, so a caller never infers it from `mode`. A local home reports
   * `{ sharedBetweenInstances: false, personalMachine: true }`: one process holds it, on one
   * person's machine. A remote home reports `{ sharedBetweenInstances: true, personalMachine: false }`.
   */
  readonly capabilities: {
    /** Several application instances can use this home at once. */
    readonly sharedBetweenInstances: boolean;
    /** The home belongs to one person's own machine. */
    readonly personalMachine: boolean;
  };
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
  /** The immutable workspace identity bound to this backing store. */
  readonly workspaceId: string;
  /**
   * Where the content named `name` lives: a mode-0700 `<root>/<name>` directory locally, created if
   * absent, or `{ kind: 's3', bucket, prefix: '<prefix><name>/' }` remotely, which creates nothing.
   * A read-only local home creates nothing either: it returns an existing directory and throws
   * `BungalowStateError` for a missing one.
   */
  content(name: string): ContentLocation;
  /**
   * The object-store client remote mode signs its requests with, or `undefined` locally: presigned
   * URLs and `ListObjectsV2` for the home's bucket, over `fetch`. It has the `presign` and `list`
   * members of `Bun.S3Client`, so code written against those accepts it.
   */
  objectStore(): BungalowObjectStore | undefined;
  /** The backend's write capability, independent of mode and caller permissions. */
  readonly configurationWriteCapability: ConfigurationWriteCapability;
  /** Configuration bytes and their backend revision from one read. */
  readConfiguration(): Promise<ConfigurationSnapshot>;
  /** Await one conditional replacement; unknown means a commit cannot safely be ruled out. */
  writeConfiguration(
    text: string,
    condition: ConfigurationWriteCondition,
  ): Promise<ConfigurationWriteResult>;
  /** Workspace-bound managed versions; configuration publication is owned by the application. */
  readonly secretProvider: SecretProvider;
  /** Deployment inputs independent of the managed provider, including root encryption keys. */
  readonly deploymentSecrets: DeploymentSecrets;
  /**
   * End the handle: release the lock locally. Idempotent once it has succeeded; a failed close can
   * be retried.
   */
  close(): void;
  [Symbol.dispose](): void;
};

/** Trusted composition binds a provider once, after the backing workspace identity is verified. */
export type SecretProviderFactory = (workspaceId: string) => SecretProvider;

/** Trusted composition hook: undefined identity checks an empty database before bootstrap;
 * a persisted identity atomically binds the raw store before workspace publication. */
export type DatabaseWorkspaceClaim = (
  databaseUrl: string,
  resourceLocation: string,
  workspaceId: string | undefined,
) => Promise<void>;

export type OpenBungalowOptions = {
  readonly name: string;
  /** Defaults to the process environment. */
  readonly environment?: BungalowEnvironment;
  /** Defaults to the user's home directory. */
  readonly homeDirectory?: string;
  /** An operator-supplied workspace identity; omitted means the persisted deployment identity. */
  readonly workspaceId?: string;
  /** Required in remote mode: the application binds the database it owns before recovery. */
  readonly databaseWorkspaceClaim?: DatabaseWorkspaceClaim;
  /** Opt in to conditional remote configuration writes. Defaults to read-only; authorization is separate. */
  readonly writableConfiguration?: boolean;
  /** Inject a provider bound to this home; location does not determine its capabilities. */
  readonly secretProvider?: SecretProviderFactory;
  /** Local mode only: the single-instance lock; see `OpenLocalBungalowOptions.acquireLock`. */
  readonly acquireLock?: AcquireLock;
  /** Remote mode only: the request signer; see `OpenRemoteBungalowOptions.presigner`. */
  readonly presigner?: PresignerFactory;
};

/**
 * Take a root's single-instance lock, or throw (by convention `BungalowLockedError`) when it is
 * held elsewhere. It may return a promise, which the open awaits.
 */
export type AcquireLock = (root: string) => RootLock | Promise<RootLock>;

/**
 * Build the signer of a remote home's requests from its validated descriptor. It is called once
 * per open, before any request. The default is `createSigV4Presigner` over the descriptor's
 * credentials; a host injects another to sign some other way. The presigner must also sign a
 * bucket-level request, an empty key with `options.query`, which is how a listing is made:
 * `Bun.S3Client.presign` cannot, so a presigner over it hands those to another signer.
 */
export type PresignerFactory = (descriptor: RemoteBungalowDescriptor) => ObjectPresigner;

/** What `openLocalBungalow` takes: an explicit root, and nothing read from the environment. */
export type OpenLocalBungalowOptions = {
  /** The application name, such as `interborough`: lower-case letters, digits, and hyphens. */
  readonly name: string;
  /** The home's root directory. It must be absolute, and is normalized before use. */
  readonly root: string;
  /** An operator-supplied workspace identity; omitted means the persisted deployment identity. */
  readonly workspaceId?: string;
  /** Inject a provider bound to this home; location does not determine its capabilities. */
  readonly secretProvider?: SecretProviderFactory;
  /**
   * Inject the deployment secrets. Omitted means files under `<root>/secrets/`, one per key, mode
   * `0600`. The `secrets/` directory is created either way.
   */
  readonly deploymentSecrets?: DeploymentSecretsFactory;
  /**
   * Take the root's single-instance lock, after the root directory exists and before anything in
   * it is read; the open releases it if it fails, and `close()` releases it. Omitted means an
   * exclusive `flock(2)` on `<root>/lock` through `bun:ffi`, which only Bun has: a Node host
   * injects `acquirePortableLock`. A host with its own single-instance mechanism, such as a
   * desktop application's, injects it here.
   */
  readonly acquireLock?: AcquireLock;
  /**
   * `'write'` (the default) opens and prepares the home as described above. `'read'` returns a
   * handle that takes no lock and creates, changes, and deletes nothing, so a second process can
   * read a home the host holds: the root and its `deployment-id` must already exist, a
   * missing `secrets/`, `.managed-secrets/`, or content directory reads as empty or missing, a
   * loose file is not tightened, and every writing member refuses or reports read-only. A
   * read-only open refuses `acquireLock`, `deploymentSecrets`, and `secretProvider` with
   * `BungalowInputError`.
   */
  readonly access?: 'read' | 'write';
};

/** What `openRemoteBungalow` takes: an explicit descriptor, and nothing read from the environment. */
export type OpenRemoteBungalowOptions = {
  /** The application name, such as `interborough`: lower-case letters, digits, and hyphens. */
  readonly name: string;
  /**
   * Where the remote home is. `resolveBungalowDescriptor` returns one, or a caller builds it by
   * hand; either way it is validated before any request.
   */
  readonly descriptor: RemoteBungalowDescriptor;
  /** The application binds the database it owns before recovery; see `DatabaseWorkspaceClaim`. */
  readonly databaseWorkspaceClaim: DatabaseWorkspaceClaim;
  /** An operator-supplied workspace identity; omitted means the persisted deployment identity. */
  readonly workspaceId?: string;
  /** Opt in to conditional configuration writes. Defaults to read-only; authorization is separate. */
  readonly writableConfiguration?: boolean;
  /** Inject a provider bound to this home; location does not determine its capabilities. */
  readonly secretProvider?: SecretProviderFactory;
  /**
   * Inject the deployment secrets. Omitted means the descriptor's `<NAME>_SECRET_<KEY>` values,
   * read-only.
   */
  readonly deploymentSecrets?: DeploymentSecretsFactory;
  /**
   * Sign the home's object-store requests. Omitted means `createSigV4Presigner` over the
   * descriptor's credentials, which runs on Bun and Node and reads no environment. Whatever signs,
   * every request is still sent with `fetch`, so conditional headers reach the store.
   */
  readonly presigner?: PresignerFactory;
};

export type OpenTemporaryBungalowOptions = {
  readonly name: string;
  /** The single-instance lock; see `OpenLocalBungalowOptions.acquireLock`. */
  readonly acquireLock?: AcquireLock;
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

function assertStoredDeploymentId(stored: string): string {
  if (!isUlid(stored)) {
    throw new BungalowStateError(
      'The deployment-id file does not hold a ULID. Restore the original identity from a backup.',
    );
  }
  return stored;
}

/** The persisted deployment identifier, generated on the first open. */
function loadDeploymentId(path: string): string {
  const stored = readEntry(path, 'deployment-id file')?.trim();
  if (stored === undefined) {
    const created = generateUlid();
    writePrivateFile(path, `${created}\n`);
    return created;
  }
  return assertStoredDeploymentId(stored);
}

const WORKSPACE_MARKER = 'workspace-id';

function assertWorkspaceId(value: string): string {
  const normalized = value.trim();
  if (normalized === '' || normalized.includes('\n')) {
    throw new BungalowInputError('The workspace identity must be non-empty text.');
  }
  return normalized;
}

/** With `persist` false, an identity not yet stored is returned and nothing is written. */
function bindWorkspaceId(
  path: string,
  deploymentId: string,
  configured?: string,
  persist = true,
): string {
  const expected = assertWorkspaceId(configured ?? deploymentId);
  const marker = readEntry(path, 'workspace identity file')?.trim();
  if (marker !== undefined && marker === '') {
    throw new BungalowStateError('The workspace identity file is malformed.');
  }
  if (marker !== undefined && marker !== expected) {
    throw new BungalowStateError('The backing store belongs to a different workspace.');
  }
  if (configured !== undefined && configured.trim() !== deploymentId) {
    throw new BungalowStateError('The configured workspace identity does not match deployment-id.');
  }
  if (marker === undefined && persist) {
    writePrivateFile(path, `${expected}\n`);
  }
  return expected;
}

/**
 * The fault seams of a local open, which are not part of the package's public surface: a close
 * step, or a configuration rename that fails.
 */
export type LocalOpenSeams = {
  readonly onClose?: () => void;
  /** Replaces the rename that publishes a written configuration, so a test can fail it. */
  readonly renameConfiguration?: (from: string, to: string) => void;
};

/**
 * Open a local home from an explicit absolute root. Reads no environment and applies no
 * `NODE_ENV=test` policy: the caller chose the root. Unless `access` is `'read'`, which takes no
 * lock and writes nothing, it takes the root's single-instance lock, so two
 * homes with different roots can be open in one process at once, each with its own lock,
 * identity, and secrets, and closing one leaves the other open. A relative root throws
 * `BungalowInputError`.
 */
export async function openLocalBungalow(options: OpenLocalBungalowOptions): Promise<Bungalow> {
  assertBungalowName(options.name);
  return openLocalAtRoot({ ...options, root: absoluteRoot(options.root) });
}

/**
 * Open the local home at `options.root`, which the caller has already made absolute, with the
 * fault seams a test needs. Not part of the package's public surface.
 */
export async function openLocalAtRoot(
  options: OpenLocalBungalowOptions,
  seams: LocalOpenSeams = {},
): Promise<Bungalow> {
  // Every option is read here, before anything else, so a later change to the caller's object
  // cannot change what the open does.
  const {
    name,
    root,
    workspaceId: configuredWorkspaceId,
    secretProvider: secretProviderFactory,
    deploymentSecrets: deploymentSecretsFactory,
    acquireLock: injectedLock,
    access = 'write',
  } = options;
  const { onClose, renameConfiguration } = seams;
  if (access !== 'read' && access !== 'write') {
    throw new BungalowInputError('The access must be "read" or "write".');
  }
  if (access === 'read') {
    if (
      injectedLock !== undefined ||
      deploymentSecretsFactory !== undefined ||
      secretProviderFactory !== undefined
    ) {
      throw new BungalowInputError(
        'A read-only open uses the built-in stores and takes no lock: it refuses acquireLock, deploymentSecrets, and secretProvider.',
      );
    }
    return openLocalReadOnly(name, root, configuredWorkspaceId, onClose);
  }
  filesystem('prepare the root directory', () =>
    ensureDirectory(root, 'root directory', { privateMode: true }),
  );
  const acquireLock = injectedLock ?? (await defaultAcquireLock());
  const lock = await acquireLock(root);
  const secrets = join(root, 'secrets');
  const logs = join(root, 'logs');
  const configurationLocation = join(root, 'configuration.json');
  let deploymentId: string;
  let workspaceId: string;
  try {
    const deploymentPath = join(root, 'deployment-id');
    filesystem('remove leftover temporary root files', () =>
      removeTemporaryFiles(root, ROOT_TEMPORARY_FILE),
    );
    const deployment = readEntry(deploymentPath, 'deployment-id file')?.trim();
    const existingEntries = readdirSync(root).filter((entry) => entry !== 'lock');
    if (deployment === undefined && existingEntries.length > 0) {
      throw new BungalowStateError(
        'The existing backing store has no persisted deployment identity.',
      );
    }
    deploymentId = filesystem('persist the deployment identifier', () =>
      loadDeploymentId(deploymentPath),
    );
    workspaceId = filesystem('bind the workspace identity', () =>
      bindWorkspaceId(join(root, WORKSPACE_MARKER), deploymentId, configuredWorkspaceId),
    );
    filesystem('prepare the secrets directory', () =>
      ensureDirectory(secrets, 'secrets directory', { privateMode: true }),
    );
    filesystem('prepare the logs directory', () => ensureDirectory(logs, 'logs directory'));
    filesystem('remove leftover temporary files', () => {
      removeTemporaryFiles(secrets, SECRET_TEMPORARY_FILE);
    });
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

  let secretProvider: SecretProvider;
  let deploymentSecrets: DeploymentSecrets;
  try {
    secretProvider =
      secretProviderFactory?.(workspaceId) ??
      createLocalSecretProvider({ root, workspaceId, assertOpen });
    if (secretProvider.workspaceId !== workspaceId) {
      throw new BungalowInputError('The secret provider belongs to a different workspace.');
    }
    deploymentSecrets =
      deploymentSecretsFactory === undefined
        ? localDeploymentSecrets(secrets, assertOpen)
        : injectedDeploymentSecrets(deploymentSecretsFactory, { workspaceId, assertOpen });
  } catch (error) {
    close();
    throw error;
  }

  return {
    name,
    mode: 'local',
    capabilities: LOCAL_CAPABILITIES,
    database: { kind: 'sqlite', path: join(root, 'database.sqlite') },
    configurationLocation,
    logs,
    deploymentId,
    workspaceId,
    objectStore() {
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
    configurationWriteCapability: 'writable',
    async readConfiguration() {
      assertOpen();
      return localConfigurationSnapshot(
        filesystem('read the configuration', () =>
          readEntry(configurationLocation, 'configuration file'),
        ),
      );
    },
    async writeConfiguration(text, condition) {
      assertOpen();
      return writeLocalConfiguration(
        text,
        condition,
        () =>
          filesystem('read the configuration', () =>
            readEntry(configurationLocation, 'configuration file'),
          ),
        (next) =>
          filesystem('write the configuration', () =>
            writePrivateFile(configurationLocation, next, renameConfiguration),
          ),
      );
    },
    secretProvider,
    deploymentSecrets,
    close,
    [Symbol.dispose]: close,
  };
}

const LOCAL_CAPABILITIES = {
  sharedBetweenInstances: false,
  personalMachine: true,
} as const satisfies Bungalow['capabilities'];

/**
 * Open the local home at `root` without taking its lock or writing anything: no directory is
 * created, no mode is tightened, no temporary file is swept, and no identity is saved. It reads
 * only files a writer replaces by rename, never the lock file, and refuses a symbolic link, a FIFO,
 * or a multiply linked file at every entry it reads.
 */
function openLocalReadOnly(
  name: string,
  root: string,
  configuredWorkspaceId: string | undefined,
  onClose: (() => void) | undefined,
): Bungalow {
  const secrets = join(root, 'secrets');
  const configurationLocation = join(root, 'configuration.json');
  let released = false;
  let finished = false;
  const assertOpen = (): void => {
    if (released) throw new BungalowStateError('This Bungalow is closed.');
  };
  const close = (): void => {
    if (finished) return;
    released = true;
    onClose?.();
    finished = true;
  };

  const { deploymentId, workspaceId } = filesystem('read the root', () => {
    if (!directoryExists(root, 'root directory')) {
      throw new BungalowStateError('The root directory does not exist.');
    }
    const stored = readEntry(join(root, 'deployment-id'), 'deployment-id file')?.trim();
    if (stored === undefined) {
      throw new BungalowStateError('The backing store has no persisted deployment identity.');
    }
    const id = assertStoredDeploymentId(stored);
    // A refused `secrets/` fails the open, as it does for a writer; a missing one is empty.
    directoryExists(secrets, 'secrets directory');
    return {
      deploymentId: id,
      // A home with no workspace identity yet uses its deployment identity, and saves nothing.
      workspaceId: bindWorkspaceId(join(root, WORKSPACE_MARKER), id, configuredWorkspaceId, false),
    };
  });
  const secretProvider = createLocalProvider({ root, workspaceId, assertOpen }, true);
  const readConfiguration = () =>
    filesystem('read the configuration', () =>
      readEntryConcurrently(configurationLocation, 'configuration file'),
    );

  return {
    name,
    mode: 'local',
    capabilities: LOCAL_CAPABILITIES,
    database: { kind: 'sqlite', path: join(root, 'database.sqlite') },
    configurationLocation,
    logs: join(root, 'logs'),
    deploymentId,
    workspaceId,
    objectStore() {
      assertOpen();
      return undefined;
    },
    content(contentName) {
      assertOpen();
      assertDirectoryName(contentName);
      const path = join(root, contentName);
      const exists = filesystem('inspect a content directory', () =>
        directoryExists(path, 'content directory'),
      );
      if (!exists) {
        throw new BungalowStateError('The content directory does not exist on a read-only home.');
      }
      return { kind: 'directory', path };
    },
    configurationWriteCapability: 'read-only',
    async readConfiguration() {
      assertOpen();
      return localConfigurationSnapshot(readConfiguration());
    },
    async writeConfiguration(text, condition) {
      assertOpen();
      assertConfigurationWrite(text, condition);
      return { outcome: 'read-only' };
    },
    secretProvider,
    deploymentSecrets: localDeploymentSecrets(secrets, assertOpen, true),
    close,
    [Symbol.dispose]: close,
  };
}

/**
 * The default local deployment secrets: one `0600` file per key under `secrets`. Read-only, it
 * reads a loose file as it is, reads a missing `secrets/` as empty, and rejects `write`.
 */
function localDeploymentSecrets(
  secrets: string,
  assertOpen: () => void,
  readOnly = false,
): DeploymentSecrets {
  return {
    writable: !readOnly,
    location(key) {
      assertOpen();
      assertSecretKey(key);
      return join(secrets, key);
    },
    async write(key, value) {
      assertOpen();
      assertSecretKey(key);
      if (readOnly)
        throw new BungalowStateError('Deployment secrets of a read-only home are read-only.');
      filesystem('write a deployment secret', () => writePrivateFile(join(secrets, key), value));
    },
    async read(key) {
      assertOpen();
      assertSecretKey(key);
      return filesystem('read a deployment secret', () => {
        if (!readOnly) return readEntry(join(secrets, key), 'secret file', SECRET_MODE);
        return directoryExists(secrets, 'secrets directory')
          ? readEntryConcurrently(join(secrets, key), 'secret file')
          : undefined;
      });
    },
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
 * The default presigner reads no process environment; an injected `presigner` that would sign
 * with a session token the given environment does not set is refused with that error too.
 *
 * Otherwise the home is local and this takes its single-instance lock. The root is `<NAME>_HOME`
 * or `~/.<name>`; see `resolveBungalowRoot`. Under `NODE_ENV=test` with no `<NAME>_HOME` in effect
 * a local open throws rather than touch the real home directory. The process's own environment
 * counts as well as the one passed in, so passing an empty environment cannot opt a test out. A
 * test points `<NAME>_HOME` at a disposable directory or calls `openTemporaryBungalow`.
 */
export async function openBungalow(options: OpenBungalowOptions): Promise<Bungalow> {
  // The descriptor is resolved as `resolveBungalowDescriptor` resolves it, in two halves so that
  // the `NODE_ENV=test` refusal still comes before the local root is resolved: the remote half
  // first, then the refusal, then the root. `acquireLock` is never asked for in remote mode, and
  // `presigner` never in local mode.
  assertBungalowName(options.name);
  const environment = options.environment ?? processEnvironment();
  const remote = resolveRemoteDescriptor(options.name, environment);
  if (remote !== undefined) {
    return openRemoteBungalow({
      name: options.name,
      descriptor: remote,
      databaseWorkspaceClaim: requireDatabaseWorkspaceClaim(options.databaseWorkspaceClaim),
      writableConfiguration: options.writableConfiguration === true,
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(options.secretProvider === undefined ? {} : { secretProvider: options.secretProvider }),
      ...(options.presigner === undefined ? {} : { presigner: options.presigner }),
    });
  }
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
  return openLocalAtRoot({
    name: options.name,
    root,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.secretProvider === undefined ? {} : { secretProvider: options.secretProvider }),
    ...(options.acquireLock === undefined ? {} : { acquireLock: options.acquireLock }),
  });
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
    // Awaited here, so a failed open still removes the directory it was given.
    return await openLocalAtRoot(
      {
        name: options.name,
        root,
        ...(options.acquireLock === undefined ? {} : { acquireLock: options.acquireLock }),
      },
      { onClose: remove },
    );
  } catch (error) {
    try {
      remove();
    } catch {
      // The open already failed; its error is the one worth reporting.
    }
    throw error;
  }
}
