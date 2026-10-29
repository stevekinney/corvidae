import type { Bungalow } from './bungalow.ts';
import { BungalowFilesystemError, BungalowInputError, BungalowStateError } from './errors.ts';
import { secretVariable, type RemoteConfiguration } from './remote-configuration.ts';
import { generateUlid, isUlid } from './ulid.ts';
import { assertDirectoryName, assertSecretKey } from './validation.ts';

/** How long a presigned request stays valid. Each request is signed just before it is sent. */
const PRESIGN_SECONDS = 60;

/** The query parameter of a presigned URL that carries a session token. */
const SESSION_TOKEN_PARAMETER = 'X-Amz-Security-Token';

/** The S3 operations Bungalow performs, which are all a failure's message may name. */
type S3Operation = 'read configuration' | 'read deployment ID' | 'write deployment ID';

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

/** Release a response's connection without reading what it says. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is already consumed or closed; nothing is left to release.
  }
}

/**
 * Send one request to `key`, signed with `client.presign` and sent with `fetch`, the mechanism
 * COR-1759 proved: `Bun.S3Client.write` silently drops a conditional header.
 */
async function send(
  client: Bun.S3Client,
  key: string,
  operation: S3Operation,
  method: 'GET' | 'PUT',
  init: { readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<Response> {
  try {
    const url = client.presign(key, { method, expiresIn: PRESIGN_SECONDS });
    return await fetch(url, { method, ...init });
  } catch (error) {
    throw s3Failure(operation, { code: codeOf(error) });
  }
}

/** The object's text, or `undefined` when the store answers 404. */
async function readObject(
  client: Bun.S3Client,
  key: string,
  operation: S3Operation,
): Promise<string | undefined> {
  const response = await send(client, key, operation, 'GET');
  if (!response.ok) {
    await discard(response);
    if (response.status === 404) return undefined;
    throw s3Failure(operation, { status: response.status });
  }
  try {
    return await response.text();
  } catch (error) {
    throw s3Failure(operation, { code: codeOf(error) });
  }
}

/**
 * Write a new deployment ID only if none exists. A 412 means another instance wrote first, which
 * is as good as success: the caller reads back whichever value the store kept.
 */
async function createDeploymentId(client: Bun.S3Client, key: string): Promise<void> {
  const response = await send(client, key, 'write deployment ID', 'PUT', {
    headers: { 'If-None-Match': '*' },
    body: `${generateUlid()}\n`,
  });
  await discard(response);
  if (response.ok || response.status === 412) return;
  throw s3Failure('write deployment ID', { status: response.status });
}

/**
 * The deployment ID stored at `key`, created on the first open. Overlapping first opens each try
 * a conditional create and then all read the one value the store kept, so they agree. An object
 * that is absent again after the write is a failed read, not a reason to write again.
 */
async function loadDeploymentId(client: Bun.S3Client, key: string): Promise<string> {
  let stored = await readObject(client, key, 'read deployment ID');
  if (stored === undefined) {
    await createDeploymentId(client, key);
    stored = await readObject(client, key, 'read deployment ID');
    if (stored === undefined) throw s3Failure('read deployment ID', { status: 404 });
  }
  const identifier = stored.trim();
  if (!isUlid(identifier)) {
    throw new BungalowStateError(
      'The deployment-id object does not hold a ULID. Remove it to generate a new identity.',
    );
  }
  return identifier;
}

/**
 * The client the configuration describes. Bun refuses some endpoints in its constructor with a
 * message that quotes the endpoint, so that failure keeps only its code.
 */
function s3Client(configuration: RemoteConfiguration): Bun.S3Client {
  try {
    return new Bun.S3Client(configuration.client);
  } catch (error) {
    throw new BungalowInputError('The S3_ variables do not describe a usable S3 client.', {
      cause: { code: codeOf(error) },
    });
  }
}

/**
 * Refuse a key that a request URL would not address exactly. Bun's presigned URL turns `\\` into
 * `/`, and URL parsing drops `.` segments and resolves `..`, so such a key would read and write a
 * different object than the location Bungalow hands out, and two prefixes would share one home.
 * `normalizeBucketPrefix` refuses the known cases; this checks the URL itself, before any request.
 */
function assertExactlyAddressed(client: Bun.S3Client, bucket: string, key: string): void {
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
 * Refuse a client that would sign with a session token nobody gave Bungalow. The decision is that
 * remote credentials come only from the environment Bungalow is given, but `Bun.S3Client` falls
 * back to the `AWS_SESSION_TOKEN` or `S3_SESSION_TOKEN` the process had when it started whenever
 * no `sessionToken` option is set, or it is `''`, and no option turns that off. The probe is a
 * presigned URL, so nothing is sent, and its query shows exactly what every request would carry.
 * A token the given environment supplies is the intended one. Names only, never a value.
 */
function assertNoAmbientSessionToken(
  client: Bun.S3Client,
  configuration: RemoteConfiguration,
  key: string,
): void {
  if (configuration.client.sessionToken !== undefined) return;
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
      'The process environment sets AWS_SESSION_TOKEN or S3_SESSION_TOKEN, which Bun would sign ' +
        'every request with, but the environment given to Bungalow sets no S3_SESSION_TOKEN. ' +
        'Set S3_SESSION_TOKEN in the given environment, or unset AWS_SESSION_TOKEN and ' +
        'S3_SESSION_TOKEN in the process.',
    );
  }
}

/**
 * Open the remote Bungalow that `configuration` describes: Postgres for the database, the bucket
 * for configuration, content, and the deployment ID, and environment variables for secrets. It
 * takes no lock, since there is no root to lock, and makes no request until every input is valid.
 */
export async function openRemoteBungalow(
  name: string,
  configuration: RemoteConfiguration,
): Promise<Bungalow> {
  const { bucket, prefix, secrets } = configuration;
  const client = s3Client(configuration);
  const deploymentKey = `${prefix}deployment-id`;
  const configurationKey = `${prefix}configuration.json`;
  assertExactlyAddressed(client, bucket, deploymentKey);
  assertExactlyAddressed(client, bucket, configurationKey);
  assertNoAmbientSessionToken(client, configuration, deploymentKey);
  const deploymentId = await loadDeploymentId(client, deploymentKey);

  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new BungalowStateError('This Bungalow is closed.');
  };
  const close = (): void => {
    closed = true;
  };

  return {
    name,
    mode: 'remote',
    database: { kind: 'postgres', url: configuration.databaseUrl },
    configurationLocation: `s3://${bucket}/${configurationKey}`,
    logs: undefined,
    deploymentId,
    s3Client() {
      assertOpen();
      return client;
    },
    content(contentName) {
      assertOpen();
      assertDirectoryName(contentName);
      return { kind: 's3', bucket, prefix: `${prefix}${contentName}/` };
    },
    async readConfiguration() {
      assertOpen();
      return readObject(client, configurationKey, 'read configuration');
    },
    secretLocation(key) {
      assertOpen();
      return secretVariable(name, key);
    },
    writeSecret(key) {
      assertOpen();
      assertSecretKey(key);
      throw new BungalowStateError(
        'A remote Bungalow reads secrets from environment variables and cannot write one.',
      );
    },
    readSecret(key) {
      assertOpen();
      return secrets.get(secretVariable(name, key));
    },
    close,
    [Symbol.dispose]: close,
  };
}
