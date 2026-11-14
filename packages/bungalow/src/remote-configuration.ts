import { BungalowInputError } from './errors.ts';
import { bungalowVariable, type BungalowEnvironment } from './resolve-root.ts';
import { assertSecretKey } from './validation.ts';

/**
 * Everything a remote home needs, validated before any request: where the database, the bucket,
 * and the secrets are, and the credentials of the S3 client. `resolveBungalowDescriptor` builds
 * one from the environment; a caller can also build one by hand and pass it to
 * `openRemoteBungalow`, which validates it exactly as it validates a resolved one.
 */
export type RemoteBungalowDescriptor = {
  /** Selects remote mode. */
  readonly kind: 'remote';
  /** The Postgres URL handed out as `database`: `<NAME>_DATABASE_URL`. */
  readonly databaseUrl: string;
  /** The bucket that holds the configuration, content, and identity: `<NAME>_BUCKET`. */
  readonly bucket: string;
  /**
   * The key prefix inside the bucket: `<NAME>_BUCKET_PREFIX`. Normalized when validated: one
   * leading `/` is removed and a non-empty prefix ends in exactly one `/`; `''` is the bucket's root.
   */
  readonly prefix: string;
  /** The S3 endpoint URL: `S3_ENDPOINT`. */
  readonly endpoint: string;
  /** The S3 region: `S3_REGION`. */
  readonly region: string;
  /** The S3 access key ID: `S3_ACCESS_KEY_ID`. */
  readonly accessKeyId: string;
  /** The S3 secret access key: `S3_SECRET_ACCESS_KEY`. */
  readonly secretAccessKey: string;
  /** Optional session token for temporary credentials: `S3_SESSION_TOKEN`. Empty means unset. */
  readonly sessionToken?: string;
  /**
   * The deployment secrets, as `<NAME>_SECRET_<KEY>` variable names and their values. Copied when
   * validated, so a later change to the caller's map cannot change what the handle answers. An
   * empty value counts as unset. Omitted means no deployment secrets.
   */
  readonly secrets?: ReadonlyMap<string, string>;
};

/** What a validation failure names for each field: a variable, or a descriptor field. */
type RemoteDescriptorLabels = {
  readonly databaseUrl: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

/** A hand-built descriptor's failures name its fields, never a value. */
export const DESCRIPTOR_LABELS: RemoteDescriptorLabels = {
  databaseUrl: 'descriptor.databaseUrl',
  bucket: 'descriptor.bucket',
  prefix: 'descriptor.prefix',
  endpoint: 'descriptor.endpoint',
  region: 'descriptor.region',
  accessKeyId: 'descriptor.accessKeyId',
  secretAccessKey: 'descriptor.secretAccessKey',
};

/** A resolved descriptor's failures name the variables, never a value. */
function environmentLabels(name: string): RemoteDescriptorLabels {
  return {
    databaseUrl: bungalowVariable(name, 'DATABASE_URL'),
    bucket: bungalowVariable(name, 'BUCKET'),
    prefix: bungalowVariable(name, 'BUCKET_PREFIX'),
    endpoint: 'S3_ENDPOINT',
    region: 'S3_REGION',
    accessKeyId: 'S3_ACCESS_KEY_ID',
    secretAccessKey: 'S3_SECRET_ACCESS_KEY',
  };
}

/**
 * The value of `variable`, or `undefined` when it is unset or empty: empty means unset. Only the
 * environment's own properties count, so a name such as `constructor` never reads the prototype.
 */
export function readVariable(
  environment: BungalowEnvironment,
  variable: string,
): string | undefined {
  const value = Object.hasOwn(environment, variable) ? environment[variable] : undefined;
  return value === '' ? undefined : value;
}

/** Refuse a bucket name a path-style URL would not address as one segment, naming `label`. */
function assertPathSafeBucket(bucket: string, label: string): void {
  if (bucket.includes('/') || bucket.includes('\\') || bucket === '.' || bucket === '..') {
    throw new BungalowInputError(
      `${label} must be a bucket name, without "/" or "\\", and not "." or "..".`,
    );
  }
}

/**
 * Normalize a bucket prefix: one leading `/` is removed, and a non-empty prefix ends in `/`. A
 * prefix with an empty, `.`, or `..` segment, or a backslash, is refused, naming `label` and not
 * the value: a request URL would rewrite each of them, so the object written would not be the one
 * Bungalow names. Normalizing a normalized prefix returns it unchanged.
 */
export function normalizeBucketPrefix(raw: string | undefined, label: string): string {
  if (raw === undefined) return '';
  let prefix = raw.startsWith('/') ? raw.slice(1) : raw;
  if (prefix === '') return '';
  if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  if (
    prefix.includes('\\') ||
    prefix.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new BungalowInputError(
      `${label} must not contain an empty, ".", or ".." segment, or a backslash.`,
    );
  }
  return `${prefix}/`;
}

/** A required text field: a non-empty string, or `BungalowInputError` naming `label`. */
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new BungalowInputError(`Remote mode needs ${label}.`);
  }
  return value;
}

/**
 * Validate a remote descriptor and return a normalized copy: the database URL, the bucket (which
 * must be path-safe), the four S3 client fields in that order, the prefix (normalized, with its
 * segment rules), an empty session token dropped, and the secrets copied without empty values.
 * Both a resolved descriptor and a hand-built one pass through here, so neither can skip a check.
 * A failure is `BungalowInputError` naming the field by `labels`, never its value.
 */
export function validateRemoteDescriptor(
  descriptor: RemoteBungalowDescriptor,
  labels: RemoteDescriptorLabels = DESCRIPTOR_LABELS,
): RemoteBungalowDescriptor {
  if (typeof descriptor !== 'object' || descriptor === null || descriptor.kind !== 'remote') {
    throw new BungalowInputError('A remote descriptor needs kind "remote".');
  }
  const databaseUrl = requireText(descriptor.databaseUrl, labels.databaseUrl);
  const bucket = requireText(descriptor.bucket, labels.bucket);
  assertPathSafeBucket(bucket, labels.bucket);
  const endpoint = requireText(descriptor.endpoint, labels.endpoint);
  const region = requireText(descriptor.region, labels.region);
  const accessKeyId = requireText(descriptor.accessKeyId, labels.accessKeyId);
  const secretAccessKey = requireText(descriptor.secretAccessKey, labels.secretAccessKey);
  const rawPrefix: unknown = descriptor.prefix;
  if (rawPrefix !== undefined && typeof rawPrefix !== 'string') {
    throw new BungalowInputError(`${labels.prefix} must be text.`);
  }
  const prefix = normalizeBucketPrefix(rawPrefix, labels.prefix);
  // An empty token would read as set here while Bun signed with the process's ambient one.
  const rawToken: unknown = descriptor.sessionToken;
  if (rawToken !== undefined && typeof rawToken !== 'string') {
    throw new BungalowInputError('The session token must be text.');
  }
  const sessionToken = rawToken === '' ? undefined : rawToken;
  const rawSecrets: unknown = descriptor.secrets;
  if (rawSecrets !== undefined && !(rawSecrets instanceof Map)) {
    throw new BungalowInputError('The deployment secrets of a remote descriptor must be a Map.');
  }
  const secrets = new Map<string, string>();
  for (const [variable, value] of (rawSecrets ?? new Map()) as Map<unknown, unknown>) {
    if (typeof variable === 'string' && typeof value === 'string' && value !== '') {
      secrets.set(variable, value);
    }
  }
  return {
    kind: 'remote',
    databaseUrl,
    bucket,
    prefix,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
    secrets,
  };
}

/**
 * The remote descriptor the environment describes for the application `name`, or `undefined` for
 * local mode, when neither `<NAME>_DATABASE_URL` nor `<NAME>_BUCKET` is set. With exactly one set,
 * or with a required S3 variable missing, this throws `BungalowInputError` naming the missing
 * variable. A message names variables only, never a value. Pure: it reads only `environment`.
 */
export function resolveRemoteDescriptor(
  name: string,
  environment: BungalowEnvironment,
): RemoteBungalowDescriptor | undefined {
  const labels = environmentLabels(name);
  const databaseUrl = readVariable(environment, labels.databaseUrl);
  const bucket = readVariable(environment, labels.bucket);
  if (databaseUrl === undefined && bucket === undefined) return undefined;
  if (bucket !== undefined) assertPathSafeBucket(bucket, labels.bucket);
  if (databaseUrl === undefined || bucket === undefined) {
    const [present, missing] =
      databaseUrl === undefined
        ? [labels.bucket, labels.databaseUrl]
        : [labels.databaseUrl, labels.bucket];
    throw new BungalowInputError(
      `${present} is set, so remote mode also needs ${missing}. Set both, or neither for local mode.`,
    );
  }
  const sessionToken = readVariable(environment, 'S3_SESSION_TOKEN');
  const prefix = readVariable(environment, labels.prefix);
  return validateRemoteDescriptor(
    {
      kind: 'remote',
      databaseUrl,
      bucket,
      prefix: prefix ?? '',
      endpoint: readVariable(environment, labels.endpoint) ?? '',
      region: readVariable(environment, labels.region) ?? '',
      accessKeyId: readVariable(environment, labels.accessKeyId) ?? '',
      secretAccessKey: readVariable(environment, labels.secretAccessKey) ?? '',
      ...(sessionToken === undefined ? {} : { sessionToken }),
      secrets: secretVariables(name, environment),
    },
    labels,
  );
}

/** The variable that holds the secret `key`: `<NAME>_SECRET_<KEY>`, uppercased with `-` as `_`. */
export function secretVariable(name: string, key: string): string {
  assertSecretKey(key);
  return bungalowVariable(name, `SECRET_${key.toUpperCase().replaceAll('-', '_')}`);
}

function secretVariables(name: string, environment: BungalowEnvironment): Map<string, string> {
  const prefix = bungalowVariable(name, 'SECRET_');
  const secrets = new Map<string, string>();
  for (const [variable, value] of Object.entries(environment)) {
    if (variable.startsWith(prefix) && value !== undefined && value !== '') {
      secrets.set(variable, value);
    }
  }
  return secrets;
}
