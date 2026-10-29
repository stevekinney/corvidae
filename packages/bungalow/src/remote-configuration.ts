import { BungalowInputError } from './errors.ts';
import { bungalowVariable, type BungalowEnvironment } from './resolve-root.ts';
import { assertSecretKey } from './validation.ts';

/** The variables that configure the S3 client, in the order a missing one is reported. */
const REQUIRED_S3_VARIABLES = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

/** Everything remote mode reads from the environment, validated, before any request is made. */
export type RemoteConfiguration = {
  /** `<NAME>_DATABASE_URL`. */
  readonly databaseUrl: string;
  /** `<NAME>_BUCKET`. */
  readonly bucket: string;
  /** `<NAME>_BUCKET_PREFIX`, normalized: empty, or ending in exactly one `/`. */
  readonly prefix: string;
  /** The options `new Bun.S3Client(...)` receives: every one is set explicitly. */
  readonly client: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
    readonly bucket: string;
    readonly virtualHostedStyle: false;
  };
  /**
   * Every non-empty `<NAME>_SECRET_*` variable, copied when the configuration is read, so a later
   * change to the caller's environment object cannot change what the handle answers.
   */
  readonly secrets: ReadonlyMap<string, string>;
};

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

/** A bucket name a path-style URL addresses as one segment. */
function isPathSafeBucket(bucket: string): boolean {
  return !bucket.includes('/') && !bucket.includes('\\') && bucket !== '.' && bucket !== '..';
}

/**
 * Normalize `<NAME>_BUCKET_PREFIX`: one leading `/` is removed, and a non-empty prefix ends in
 * `/`. A prefix with an empty, `.`, or `..` segment, or a backslash, is refused, naming the
 * variable and not its value: a request URL would rewrite each of them, so the object written
 * would not be the one Bungalow names.
 */
export function normalizeBucketPrefix(raw: string | undefined, variable: string): string {
  if (raw === undefined) return '';
  let prefix = raw.startsWith('/') ? raw.slice(1) : raw;
  if (prefix === '') return '';
  if (prefix.endsWith('/')) prefix = prefix.slice(0, -1);
  if (
    prefix.includes('\\') ||
    prefix.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new BungalowInputError(
      `${variable} must not contain an empty, ".", or ".." segment, or a backslash.`,
    );
  }
  return `${prefix}/`;
}

/**
 * The remote configuration for the application `name`, or `undefined` for local mode, when
 * neither `<NAME>_DATABASE_URL` nor `<NAME>_BUCKET` is set. With exactly one set, or with a required
 * S3 variable missing, this throws `BungalowInputError` naming the missing variable. A message
 * names variables only, never a value.
 */
export function remoteConfiguration(
  name: string,
  environment: BungalowEnvironment,
): RemoteConfiguration | undefined {
  const databaseVariable = bungalowVariable(name, 'DATABASE_URL');
  const bucketVariable = bungalowVariable(name, 'BUCKET');
  const databaseUrl = readVariable(environment, databaseVariable);
  const bucket = readVariable(environment, bucketVariable);
  if (databaseUrl === undefined && bucket === undefined) return undefined;
  if (bucket !== undefined && !isPathSafeBucket(bucket)) {
    throw new BungalowInputError(
      `${bucketVariable} must be a bucket name, without "/" or "\\", and not "." or "..".`,
    );
  }
  if (databaseUrl === undefined || bucket === undefined) {
    const [present, missing] =
      databaseUrl === undefined
        ? [bucketVariable, databaseVariable]
        : [databaseVariable, bucketVariable];
    throw new BungalowInputError(
      `${present} is set, so remote mode also needs ${missing}. Set both, or neither for local mode.`,
    );
  }
  const values = REQUIRED_S3_VARIABLES.map((variable) => {
    const value = readVariable(environment, variable);
    if (value === undefined) {
      throw new BungalowInputError(`Remote mode needs ${variable}.`);
    }
    return value;
  });
  const [endpoint = '', region = '', accessKeyId = '', secretAccessKey = ''] = values;
  const prefixVariable = bungalowVariable(name, 'BUCKET_PREFIX');
  const prefix = normalizeBucketPrefix(readVariable(environment, prefixVariable), prefixVariable);
  const sessionToken = readVariable(environment, 'S3_SESSION_TOKEN');
  return {
    databaseUrl,
    bucket,
    prefix,
    client: {
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      bucket,
      virtualHostedStyle: false,
    },
    secrets: secretVariables(name, environment),
  };
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
