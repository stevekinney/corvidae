import type { S3ObjectStoreOperations } from '@lostgradient/object-store';
import {
  createSigV4Presigner,
  ObjectStoreError,
  type ObjectPresigner,
} from '@lostgradient/object-store';
import type {
  Bungalow,
  DatabaseWorkspaceClaim,
  OpenRemoteBungalowOptions,
  PresignerFactory,
} from './bungalow.ts';
import type { ConfigurationSnapshot, ConfigurationWriteResult } from './configuration.ts';
import { assertConfigurationWrite } from './configuration.ts';
import { injectedDeploymentSecrets, type DeploymentSecrets } from './deployment-secrets.ts';
import { createEnvironmentSecretProvider } from './environment-secret-provider.ts';
import { BungalowFilesystemError, BungalowInputError, BungalowStateError } from './errors.ts';
import { createObjectStore } from './object-store.ts';
import {
  secretVariable,
  validateRemoteDescriptor,
  type RemoteBungalowDescriptor,
} from './remote-configuration.ts';
import { generateUlid, isUlid } from './ulid.ts';
import { assertBungalowName, assertDirectoryName, assertSecretKey } from './validation.ts';

type RemoteObjectStore = S3ObjectStoreOperations & {
  readonly presign: import('@lostgradient/object-store').ObjectPresigner;
};

/** How long a presigned request stays valid. Each request is signed just before it is sent. */
const PRESIGN_SECONDS = 60;

/** The query parameter of a presigned URL that carries a session token. */
const SESSION_TOKEN_PARAMETER = 'X-Amz-Security-Token';

/** The S3 operations Bungalow performs, which are all a failure's message may name. */
type S3Operation =
  | 'read configuration'
  | 'write configuration'
  | 'read deployment ID'
  | 'write deployment ID'
  | 'read workspace identity'
  | 'write workspace identity';

/**
 * What a failed S3 operation keeps as its `cause`: the HTTP status of a response, or the code of
 * a failure that produced none. Never the key, bucket, prefix, URL, or the underlying message,
 * since a presigned URL carries the access key ID and session token.
 */
type S3FailureCause = { readonly status: number } | { readonly code: string };

function s3Failure(operation: S3Operation, cause: S3FailureCause): BungalowFilesystemError {
  return new BungalowFilesystemError(`Could not ${operation}.`, { cause });
}

function codeOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code !== ''
    ? error.code
    : 'unknown';
}

function storeCause(error: unknown): S3FailureCause {
  if (error instanceof ObjectStoreError) {
    return error.status === undefined ? { code: error.code } : { status: error.status };
  }
  return { code: codeOf(error) };
}

/** The object's text, or `undefined` when the store answers 404. */
async function readObject(
  client: RemoteObjectStore,
  key: string,
  operation: S3Operation,
): Promise<string | undefined> {
  try {
    const object = await client.read(key);
    return object === undefined ? undefined : new TextDecoder().decode(object.bytes);
  } catch (error) {
    throw s3Failure(operation, storeCause(error));
  }
}

/** Read bytes and revision from one HTTP response, never separate GET and HEAD requests. */
async function readConfigurationObject(
  client: RemoteObjectStore,
  key: string,
): Promise<ConfigurationSnapshot> {
  try {
    const object = await client.read(key);
    if (object === undefined) return { text: undefined, revision: null };
    if (object.etag === '') throw s3Failure('read configuration', { code: 'missing-revision' });
    return { text: new TextDecoder().decode(object.bytes), revision: object.etag };
  } catch (error) {
    throw s3Failure('read configuration', storeCause(error));
  }
}

/** An uncertain response is observed once; equal content alone cannot prove which writer committed. */
async function reconcileConfiguration(
  client: RemoteObjectStore,
  key: string,
): Promise<ConfigurationWriteResult> {
  try {
    return { outcome: 'unknown', current: await readConfigurationObject(client, key) };
  } catch {
    return { outcome: 'unknown' };
  }
}

/**
 * Write a new deployment ID only if none exists. A 412 means another instance wrote first, which
 * is as good as success: the caller reads back whichever value the store kept.
 */
async function createDeploymentId(client: RemoteObjectStore, key: string): Promise<void> {
  try {
    await client.put(key, new TextEncoder().encode(`${generateUlid()}\n`), { kind: 'absent' });
  } catch (error) {
    throw s3Failure('write deployment ID', storeCause(error));
  }
}

async function bindWorkspaceId(
  client: RemoteObjectStore,
  workspaceKey: string,
  deploymentId: string,
  configured?: string,
): Promise<string> {
  const expected = (configured ?? deploymentId).trim();
  if (expected === '' || expected.includes('\n')) {
    throw new BungalowInputError('The workspace identity must be non-empty text.');
  }
  if (configured !== undefined && expected !== deploymentId) {
    throw new BungalowStateError('The configured workspace identity does not match deployment-id.');
  }
  let marker = await readObject(client, workspaceKey, 'read workspace identity');
  if (marker !== undefined && marker.trim() !== expected) {
    throw new BungalowStateError('The backing store belongs to a different workspace.');
  }
  if (marker === undefined) {
    try {
      await client.put(workspaceKey, new TextEncoder().encode(`${expected}\n`), { kind: 'absent' });
    } catch (error) {
      throw s3Failure('write workspace identity', storeCause(error));
    }
    marker = await readObject(client, workspaceKey, 'read workspace identity');
  }
  if (marker === undefined || marker.trim() !== expected) {
    throw new BungalowStateError('The backing store belongs to a different workspace.');
  }
  return expected;
}

/**
 * The deployment ID stored at `key`, created on the first open. Overlapping first opens each try
 * a conditional create and then all read the one value the store kept, so they agree. An object
 * that is absent again after the write is a failed read, not a reason to write again.
 */
async function loadDeploymentId(client: RemoteObjectStore, key: string): Promise<string> {
  let stored = await readObject(client, key, 'read deployment ID');
  if (stored === undefined) {
    await createDeploymentId(client, key);
    stored = await readObject(client, key, 'read deployment ID');
    if (stored === undefined) throw s3Failure('read deployment ID', { status: 404 });
  }
  const identifier = stored.trim();
  if (!isUlid(identifier)) {
    throw new BungalowStateError(
      'The deployment-id object does not hold a ULID. Restore the original identity from a backup.',
    );
  }
  return identifier;
}

/**
 * The default presigner: SigV4 over `node:crypto`, signing with exactly the descriptor's
 * credentials, path-style, for the descriptor's bucket, never `S3_BUCKET`. It reads no process
 * environment, so no ambient session token can reach a request.
 */
export const defaultPresigner: PresignerFactory = (descriptor) =>
  createSigV4Presigner({
    endpoint: descriptor.endpoint,
    region: descriptor.region,
    accessKeyId: descriptor.accessKeyId,
    secretAccessKey: descriptor.secretAccessKey,
    sessionToken: descriptor.sessionToken,
    bucket: descriptor.bucket,
  });

/**
 * The object-store client the descriptor describes, over the injected presigner or the default.
 * A presigner factory may refuse an endpoint with a message that quotes it, so that failure keeps
 * only its code.
 */
function objectStoreFor(
  descriptor: RemoteBungalowDescriptor,
  presignerFactory: PresignerFactory,
): RemoteObjectStore {
  if (typeof presignerFactory !== 'function') {
    throw new BungalowInputError('The presigner must be a function.');
  }
  let presign: ObjectPresigner;
  try {
    presign = presignerFactory(descriptor);
  } catch (error) {
    throw new BungalowInputError('The S3_ variables do not describe a usable S3 client.', {
      cause: { code: codeOf(error) },
    });
  }
  if (typeof presign !== 'function') {
    throw new BungalowInputError('The presigner factory must return a function.');
  }
  return createObjectStore(presign, descriptor.bucket);
}

/**
 * Refuse a key that a request URL would not address exactly. A presigner may turn `\\` into `/`
 * (Bun's does), and URL parsing drops `.` segments and resolves `..`, so such a key would read and write a
 * different object than the location Bungalow hands out, and two prefixes would share one home.
 * `normalizeBucketPrefix` refuses the known cases; this checks the URL itself, before any request.
 */
function assertExactlyAddressed(client: RemoteObjectStore, bucket: string, key: string): void {
  let path: string;
  try {
    path = decodeURIComponent(
      new URL(client.presign(key, { expiresIn: PRESIGN_SECONDS })).pathname,
    );
  } catch (error) {
    throw new BungalowInputError('The S3_ variables do not describe a usable S3 client.', {
      cause: { code: codeOf(error) },
    });
  }
  if (!path.endsWith(`/${bucket}/${key}`)) {
    throw new BungalowInputError(
      'The bucket or bucket prefix cannot be addressed exactly in a request URL.',
    );
  }
}

/**
 * Refuse a presigner that would sign with a session token nobody gave Bungalow. The decision is
 * that remote credentials come only from the environment Bungalow is given. The default presigner
 * reads no environment, but an injected SDK signer may fall back to the
 * `AWS_SESSION_TOKEN` or `S3_SESSION_TOKEN` the process had when it started whenever no
 * `sessionToken` option is set, or it is `''`, and no option turns that off. The probe is a
 * presigned URL, so nothing is sent, and its query shows exactly what every request would carry.
 * A token the given environment supplies is the intended one. Names only, never a value.
 */
function assertNoAmbientSessionToken(
  client: RemoteObjectStore,
  descriptor: RemoteBungalowDescriptor,
  key: string,
): void {
  if (descriptor.sessionToken !== undefined) return;
  let signed: boolean;
  try {
    signed = new URL(client.presign(key, { expiresIn: PRESIGN_SECONDS })).searchParams.has(
      SESSION_TOKEN_PARAMETER,
    );
  } catch (error) {
    throw new BungalowInputError('The S3_ variables do not describe a usable S3 client.', {
      cause: { code: codeOf(error) },
    });
  }
  if (signed) {
    throw new BungalowInputError(
      'The presigner signs every request with a session token, such as the AWS_SESSION_TOKEN or ' +
        'S3_SESSION_TOKEN the process started with, but the environment given to Bungalow sets ' +
        'no S3_SESSION_TOKEN. ' +
        'Set S3_SESSION_TOKEN in the given environment, or unset AWS_SESSION_TOKEN and ' +
        'S3_SESSION_TOKEN in the process.',
    );
  }
}

/** The callback remote mode cannot open without, or `BungalowInputError` before any request. */
export function requireDatabaseWorkspaceClaim(
  claim: DatabaseWorkspaceClaim | undefined,
): DatabaseWorkspaceClaim {
  if (typeof claim !== 'function') {
    throw new BungalowInputError('Remote mode requires a database workspace binding callback.');
  }
  return claim;
}

/**
 * Open the remote home an explicit descriptor names. Reads no environment: everything comes from
 * `options`. The descriptor goes through the same validation as one `resolveBungalowDescriptor`
 * returns (required fields, a path-safe bucket, the prefix's normalization and segment rules), so
 * a hand-built one cannot skip a check, and every input is checked before any request. Postgres
 * holds the database, the bucket the configuration, content, and identity, and the descriptor's
 * `secrets` the deployment secrets. No lock is taken, since there is no root to lock.
 */
export async function openRemoteBungalow(options: OpenRemoteBungalowOptions): Promise<Bungalow> {
  assertBungalowName(options.name);
  const descriptor = validateRemoteDescriptor(options.descriptor);
  const databaseWorkspaceClaim = requireDatabaseWorkspaceClaim(options.databaseWorkspaceClaim);
  return openValidatedRemoteBungalow({ ...options, descriptor, databaseWorkspaceClaim });
}

/**
 * Open a remote home from a descriptor `validateRemoteDescriptor` already returned. Not part of
 * the package's public surface: a test reaches the URL checks below through it with a key the
 * descriptor validation would have refused.
 */
export async function openValidatedRemoteBungalow(
  options: OpenRemoteBungalowOptions,
): Promise<Bungalow> {
  // Every option is read here, before the first await, so a later change to the caller's object
  // cannot change what the open does.
  const {
    name,
    descriptor: configuration,
    workspaceId: configuredWorkspaceId,
    databaseWorkspaceClaim,
    secretProvider: secretProviderFactory,
    deploymentSecrets: deploymentSecretsFactory,
    presigner = defaultPresigner,
  } = options;
  const writableConfiguration = options.writableConfiguration === true;
  const { bucket, prefix } = configuration;
  const secrets = configuration.secrets ?? new Map<string, string>();
  const client = objectStoreFor(configuration, presigner);
  const deploymentKey = `${prefix}deployment-id`;
  const workspaceKey = `${prefix}workspace-id`;
  const configurationKey = `${prefix}configuration.json`;
  assertExactlyAddressed(client, bucket, deploymentKey);
  assertExactlyAddressed(client, bucket, workspaceKey);
  assertExactlyAddressed(client, bucket, configurationKey);
  assertNoAmbientSessionToken(client, configuration, deploymentKey);
  const existingDeployment = await readObject(client, deploymentKey, 'read deployment ID');
  if (existingDeployment !== undefined && !isUlid(existingDeployment.trim())) {
    throw new BungalowStateError(
      'The deployment-id object does not hold a ULID. Restore the original identity from a backup.',
    );
  }
  const existingWorkspace = await readObject(client, workspaceKey, 'read workspace identity');
  if (existingDeployment === undefined && existingWorkspace !== undefined) {
    const racedDeployment = await readObject(client, deploymentKey, 'read deployment ID');
    if (racedDeployment === undefined) {
      throw new BungalowStateError(
        'The workspace identity exists without its persisted deployment identity.',
      );
    }
  }
  if (existingDeployment === undefined && existingWorkspace === undefined) {
    // An unmarked remote home may bootstrap only when neither backend already holds state.
    const entries = await client.list(prefix).catch((error: unknown) => {
      // An answered listing keeps its status, as every other S3 failure does.
      throw s3Failure('read workspace identity', storeCause(error));
    });
    const racedDeployment = await readObject(client, deploymentKey, 'read deployment ID');
    if (racedDeployment === undefined) {
      if (entries.objects.length > 0) {
        throw new BungalowStateError(
          'Existing remote state has no persisted deployment identity. Restore it from a backup.',
        );
      }
      try {
        await databaseWorkspaceClaim(
          configuration.databaseUrl,
          `s3://${bucket}/${prefix}`,
          undefined,
        );
      } catch (error) {
        // Another opener may have persisted this prefix's identity and claimed its database
        // between our read and emptiness check. Continue only from that persisted identity.
        if ((await readObject(client, deploymentKey, 'read deployment ID')) === undefined)
          throw error;
      }
    }
  }
  const deploymentId = await loadDeploymentId(client, deploymentKey);
  const expectedWorkspaceId = (configuredWorkspaceId ?? deploymentId).trim();
  if (expectedWorkspaceId !== deploymentId) {
    throw new BungalowStateError('The configured workspace identity does not match deployment-id.');
  }
  if (existingWorkspace !== undefined && existingWorkspace.trim() !== expectedWorkspaceId) {
    throw new BungalowStateError('The backing store belongs to a different workspace.');
  }
  // Claim the raw database before publishing the S3 workspace marker. A fresh prefix may have
  // written only its permitted deployment-id bootstrap; a losing claim performs no other write.
  await databaseWorkspaceClaim(
    configuration.databaseUrl,
    `s3://${bucket}/${prefix}`,
    expectedWorkspaceId,
  );
  const workspaceId = await bindWorkspaceId(
    client,
    workspaceKey,
    deploymentId,
    configuredWorkspaceId,
  );

  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new BungalowStateError('This Bungalow is closed.');
  };
  const close = (): void => {
    closed = true;
  };

  const variablePrefix = `${name.toUpperCase().replaceAll('-', '_')}_SECRET_`;
  const secretProvider =
    secretProviderFactory?.(workspaceId) ??
    createEnvironmentSecretProvider({
      workspaceId,
      values: Object.fromEntries(
        [...secrets]
          .filter(([key]) => key.startsWith(variablePrefix))
          .map(([key, value]) => [
            key.slice(variablePrefix.length).toLowerCase().replaceAll('_', '-'),
            value,
          ]),
      ),
      assertOpen,
    });
  if (secretProvider.workspaceId !== workspaceId) {
    throw new BungalowInputError('The secret provider belongs to a different workspace.');
  }
  const deploymentSecrets: DeploymentSecrets =
    deploymentSecretsFactory === undefined
      ? {
          writable: false,
          location(key) {
            assertOpen();
            return secretVariable(name, key);
          },
          async write(key) {
            assertOpen();
            assertSecretKey(key);
            throw new BungalowStateError('Deployment secrets are read-only environment inputs.');
          },
          async read(key) {
            assertOpen();
            return secrets.get(secretVariable(name, key));
          },
        }
      : injectedDeploymentSecrets(deploymentSecretsFactory, { workspaceId, assertOpen });
  return {
    name,
    mode: 'remote',
    capabilities: { sharedBetweenInstances: true, personalMachine: false },
    database: { kind: 'postgres', url: configuration.databaseUrl },
    configurationLocation: `s3://${bucket}/${configurationKey}`,
    logs: undefined,
    deploymentId,
    workspaceId,
    objectStore() {
      assertOpen();
      return client;
    },
    content(contentName) {
      assertOpen();
      assertDirectoryName(contentName);
      return { kind: 's3', bucket, prefix: `${prefix}${contentName}/` };
    },
    configurationWriteCapability: writableConfiguration ? 'writable' : 'read-only',
    async readConfiguration() {
      assertOpen();
      return readConfigurationObject(client, configurationKey);
    },
    async writeConfiguration(text, condition) {
      assertOpen();
      assertConfigurationWrite(text, condition);
      if (!writableConfiguration) return { outcome: 'read-only' };
      try {
        const written = await client.put(
          configurationKey,
          new TextEncoder().encode(text),
          condition.expectedRevision === null
            ? { kind: 'absent' }
            : { kind: 'etag', etag: condition.expectedRevision },
        );
        if (written.outcome === 'written') return { outcome: 'committed' };
        return { outcome: 'conflict' };
      } catch (error) {
        if (error instanceof ObjectStoreError && error.status === 501)
          return { outcome: 'unsupported' };
        if (error instanceof ObjectStoreError && error.status !== undefined && error.status < 500) {
          return { outcome: 'unavailable' };
        }
        // The request may have reached durable storage. Read current standing, but never retry.
        return reconcileConfiguration(client, configurationKey);
      }
    },
    secretProvider,
    deploymentSecrets,
    close,
    [Symbol.dispose]: close,
  };
}
