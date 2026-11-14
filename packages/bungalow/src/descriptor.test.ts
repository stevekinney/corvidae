import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { resolveBungalowDescriptor } from './descriptor.ts';
import { processEnvironment } from './environment-configuration.ts';
import { BungalowInputError } from './errors.ts';
import { TEST_HOME_VARIABLE, TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';
import { validateRemoteDescriptor } from './remote-configuration.ts';

const temporaryDirectory = useTemporaryDirectories();

const DATABASE_VARIABLE = 'BUNGALOW_TEST_DATABASE_URL';
const BUCKET_VARIABLE = 'BUNGALOW_TEST_BUCKET';
const PREFIX_VARIABLE = 'BUNGALOW_TEST_BUCKET_PREFIX';
const SECRET_ACCESS_KEY = 'sentinel-secret-access-key';

type Environment = Record<string, string | undefined>;

function remoteEnvironment(overrides: Environment = {}): Environment {
  return {
    [DATABASE_VARIABLE]: 'postgres://bungalow@127.0.0.1/bungalow',
    [BUCKET_VARIABLE]: 'sentinel-bucket',
    [PREFIX_VARIABLE]: '/production/',
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'SENTINELACCESSKEYID',
    S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
    ...overrides,
  };
}

function resolve(environment: Environment, homeDirectory = '/h') {
  return resolveBungalowDescriptor({ name: TEST_NAME, environment, homeDirectory });
}

function inputError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BungalowInputError);
    return error as Error;
  }
  throw new Error('Expected a BungalowInputError.');
}

describe('resolveBungalowDescriptor: local', () => {
  test('defaults to <homeDirectory>/.<name>', () => {
    expect(resolve({})).toEqual({ kind: 'local', root: `/h/.${TEST_NAME}` });
  });

  test('uses <NAME>_HOME, normalized, over the home directory', () => {
    expect(resolve({ [TEST_HOME_VARIABLE]: '/srv/./root/' })).toEqual({
      kind: 'local',
      root: '/srv/root',
    });
    expect(resolve({ [TEST_HOME_VARIABLE]: '' })).toEqual({
      kind: 'local',
      root: `/h/.${TEST_NAME}`,
    });
  });

  test('refuses a relative <NAME>_HOME or home directory', () => {
    expect(inputError(() => resolve({ [TEST_HOME_VARIABLE]: 'relative' })).message).toContain(
      TEST_HOME_VARIABLE,
    );
    inputError(() => resolve({}, 'relative/home'));
  });

  test('refuses an invalid name', () => {
    inputError(() =>
      resolveBungalowDescriptor({ name: '../x', environment: {}, homeDirectory: '/h' }),
    );
  });
});

describe('resolveBungalowDescriptor: purity', () => {
  test('creates nothing and applies no NODE_ENV=test policy, which belongs to openBungalow', () => {
    expect(processEnvironment()['NODE_ENV']).toBe('test');
    const home = join(temporaryDirectory(), 'absent');
    expect(resolve({ NODE_ENV: 'test' }, home)).toEqual({
      kind: 'local',
      root: join(home, `.${TEST_NAME}`),
    });
    expect(existsSync(home)).toBe(false);
  });

  test('reads only the environment it is given, never the process environment', () => {
    const environment = processEnvironment() as Record<string, string | undefined>;
    const remote = remoteEnvironment();
    const before = new Map(Object.keys(remote).map((key) => [key, environment[key]]));
    try {
      Object.assign(environment, remote, { [TEST_HOME_VARIABLE]: '/from/the/process' });
      expect(resolve({})).toEqual({ kind: 'local', root: `/h/.${TEST_NAME}` });
    } finally {
      for (const [key, value] of [...before, [TEST_HOME_VARIABLE, undefined] as const]) {
        if (value === undefined) delete environment[key];
        else environment[key] = value;
      }
    }
  });

  test('reads no inherited property of the environment', () => {
    const inherited: Environment = Object.create(remoteEnvironment());
    expect(resolve(inherited)).toEqual({ kind: 'local', root: `/h/.${TEST_NAME}` });
  });

  test('returns the same descriptor for the same inputs', () => {
    expect(resolve(remoteEnvironment())).toEqual(resolve(remoteEnvironment()));
  });
});

describe('resolveBungalowDescriptor: remote', () => {
  test('both selecting variables: a validated remote descriptor, and <NAME>_HOME is not read', () => {
    const descriptor = resolve(
      remoteEnvironment({
        [TEST_HOME_VARIABLE]: 'relative/home',
        S3_SESSION_TOKEN: 'sentinel-session-token',
        S3_BUCKET: 'ambient-bucket',
        BUNGALOW_TEST_SECRET_API_KEY: 'sentinel-secret-value',
        BUNGALOW_TEST_SECRET_EMPTY: '',
        OTHER_SECRET_API_KEY: 'not-ours',
      }),
    );
    expect(descriptor).toEqual({
      kind: 'remote',
      databaseUrl: 'postgres://bungalow@127.0.0.1/bungalow',
      bucket: 'sentinel-bucket',
      prefix: 'production/',
      endpoint: 'http://127.0.0.1:9',
      region: 'us-east-1',
      accessKeyId: 'SENTINELACCESSKEYID',
      secretAccessKey: SECRET_ACCESS_KEY,
      sessionToken: 'sentinel-session-token',
      secrets: new Map([['BUNGALOW_TEST_SECRET_API_KEY', 'sentinel-secret-value']]),
    });
  });

  test('an empty session token is unset', () => {
    const descriptor = resolve(remoteEnvironment({ S3_SESSION_TOKEN: '' }));
    expect(descriptor.kind).toBe('remote');
    expect(Object.hasOwn(descriptor, 'sessionToken')).toBe(false);
  });

  test('the secrets are copied, so a later change to the environment changes nothing', () => {
    const environment = remoteEnvironment({ BUNGALOW_TEST_SECRET_TOKEN: 'first' });
    const descriptor = resolve(environment);
    environment['BUNGALOW_TEST_SECRET_TOKEN'] = 'second';
    if (descriptor.kind !== 'remote') throw new Error('Expected a remote descriptor.');
    expect(descriptor.secrets?.get('BUNGALOW_TEST_SECRET_TOKEN')).toBe('first');
  });

  const prefixCases: readonly (readonly [string | undefined, string])[] = [
    ['prod', 'prod/'],
    ['/prod/', 'prod/'],
    ['a/b', 'a/b/'],
    ['/', ''],
    ['', ''],
    [undefined, ''],
  ];
  for (const [raw, normalized] of prefixCases) {
    test(`the prefix ${JSON.stringify(raw)} is ${JSON.stringify(normalized)}`, () => {
      const descriptor = resolve(remoteEnvironment({ [PREFIX_VARIABLE]: raw }));
      expect(descriptor.kind === 'remote' && descriptor.prefix).toBe(normalized);
    });
  }

  const inputCases: readonly (readonly [string, Environment, string])[] = [
    ['only the database URL', { [BUCKET_VARIABLE]: undefined }, BUCKET_VARIABLE],
    ['only the bucket', { [DATABASE_VARIABLE]: undefined }, DATABASE_VARIABLE],
    ['an empty bucket', { [BUCKET_VARIABLE]: '' }, BUCKET_VARIABLE],
    [
      'every S3 variable missing',
      {
        S3_ENDPOINT: undefined,
        S3_REGION: undefined,
        S3_ACCESS_KEY_ID: undefined,
        S3_SECRET_ACCESS_KEY: undefined,
      },
      'S3_ENDPOINT',
    ],
    ['no region or keys', { S3_REGION: '', S3_ACCESS_KEY_ID: '' }, 'S3_REGION'],
    ['no access key ID', { S3_ACCESS_KEY_ID: undefined }, 'S3_ACCESS_KEY_ID'],
    ['no secret access key', { S3_SECRET_ACCESS_KEY: '' }, 'S3_SECRET_ACCESS_KEY'],
    ['a prefix with an empty segment', { [PREFIX_VARIABLE]: 'a//b' }, PREFIX_VARIABLE],
    ['a prefix with a `.` segment', { [PREFIX_VARIABLE]: 'a/./b' }, PREFIX_VARIABLE],
    ['a prefix with a `..` segment', { [PREFIX_VARIABLE]: 'a/../b' }, PREFIX_VARIABLE],
    ['a prefix with a backslash', { [PREFIX_VARIABLE]: 'a\\b' }, PREFIX_VARIABLE],
    ['a bucket with a slash', { [BUCKET_VARIABLE]: 'a/b' }, BUCKET_VARIABLE],
    ['a bucket with a backslash', { [BUCKET_VARIABLE]: 'a\\b' }, BUCKET_VARIABLE],
    ['a bucket of `.`', { [BUCKET_VARIABLE]: '.' }, BUCKET_VARIABLE],
    // The bucket is checked before the other selecting variable is required, as before.
    [
      'an unsafe bucket without a database URL',
      { [BUCKET_VARIABLE]: '..', [DATABASE_VARIABLE]: undefined },
      `${BUCKET_VARIABLE} must be a bucket name`,
    ],
  ];
  for (const [name, overrides, names] of inputCases) {
    test(`${name}: BungalowInputError naming ${names}, and no value`, () => {
      const environment = remoteEnvironment(overrides);
      const { message } = inputError(() => resolve(environment));
      expect(message).toContain(names);
      for (const value of Object.values(environment)) {
        if (value !== undefined && value.length > 3) expect(message).not.toContain(value);
      }
    });
  }

  test('exactly one selecting variable names the other one', () => {
    expect(inputError(() => resolve(remoteEnvironment({ [BUCKET_VARIABLE]: '' }))).message).toBe(
      `${DATABASE_VARIABLE} is set, so remote mode also needs ${BUCKET_VARIABLE}. Set both, or neither for local mode.`,
    );
    expect(
      inputError(() => resolve(remoteEnvironment({ [DATABASE_VARIABLE]: undefined }))).message,
    ).toBe(
      `${BUCKET_VARIABLE} is set, so remote mode also needs ${DATABASE_VARIABLE}. Set both, or neither for local mode.`,
    );
  });

  test('a hand-built descriptor is validated by the same rules, and its empty values are unset', () => {
    const descriptor = resolve(remoteEnvironment());
    if (descriptor.kind !== 'remote') throw new Error('Expected a remote descriptor.');
    // Validating a validated descriptor changes nothing.
    expect(validateRemoteDescriptor(descriptor)).toEqual(descriptor);
    const handBuilt = validateRemoteDescriptor({
      ...descriptor,
      prefix: '/production',
      sessionToken: '',
      secrets: new Map([
        ['BUNGALOW_TEST_SECRET_KEPT', 'kept'],
        ['BUNGALOW_TEST_SECRET_EMPTY', ''],
      ]),
    });
    expect(handBuilt.prefix).toBe('production/');
    // An empty token would skip the ambient-token check while Bun signed with the process's own.
    expect(Object.hasOwn(handBuilt, 'sessionToken')).toBe(false);
    expect(handBuilt.secrets).toEqual(new Map([['BUNGALOW_TEST_SECRET_KEPT', 'kept']]));
    expect(
      inputError(() => validateRemoteDescriptor({ ...descriptor, prefix: 'a/./b' })).message,
    ).toContain('descriptor.prefix');
    expect(
      inputError(() =>
        validateRemoteDescriptor({ ...descriptor, kind: 'local' } as unknown as typeof descriptor),
      ).message,
    ).toContain('kind');
  });

  test('a missing S3 variable is named in the order endpoint, region, access key, secret key', () => {
    expect(inputError(() => resolve(remoteEnvironment({ S3_ENDPOINT: '' }))).message).toBe(
      'Remote mode needs S3_ENDPOINT.',
    );
  });
});
