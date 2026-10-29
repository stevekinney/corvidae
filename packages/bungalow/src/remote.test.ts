/**
 * COR-1761: remote mode, against the in-process S3 server from `@lostgradient/testing/s3-server`.
 * Postgres is only a location here: Bungalow hands out `<NAME>_DATABASE_URL` and never connects.
 *
 * The outcome matrix crosses each input and each remote write with how it ends. Every input error
 * is raised before any request, which the proxy in front of the server counts.
 */
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createS3TestServer, type S3TestServer } from '@lostgradient/testing/s3-server';
import { afterEach, describe, expect, test } from 'bun:test';

import { openBungalow, openBungalowWithDependencies, openTemporaryBungalow } from './bungalow.ts';
import { BungalowFilesystemError, BungalowInputError, BungalowStateError } from './errors.ts';
import {
  homeEnvironment,
  TEST_HOME_VARIABLE,
  TEST_NAME,
  useTemporaryDirectories,
} from './fixtures.test-support.ts';
import { useS3Proxy } from './s3-proxy.test-support.ts';
import { generateUlid, isUlid } from './ulid.ts';

// Distinctive values, so a leak into a message or a `cause` is found by a substring search.
const BUCKET = 'sentinel-bucket';
const PREFIX = 'sentinel-prefix';
const ACCESS_KEY_ID = 'SENTINELACCESSKEYID';
const SECRET_ACCESS_KEY = 'sentinel-secret-access-key';
const SESSION_TOKEN = 'sentinel-session-token';
const DATABASE_URL = 'postgres://bungalow:sentinel-database-password@127.0.0.1:5432/bungalow';
const SECRET_VALUE = 'sentinel-secret-value';
const DEPLOYMENT_KEY = `${PREFIX}/deployment-id`;
const CONFIGURATION_KEY = `${PREFIX}/configuration.json`;

const DATABASE_VARIABLE = 'BUNGALOW_TEST_DATABASE_URL';
const BUCKET_VARIABLE = 'BUNGALOW_TEST_BUCKET';
const PREFIX_VARIABLE = 'BUNGALOW_TEST_BUCKET_PREFIX';

const servers: S3TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
const startProxy = useS3Proxy();
const temporaryDirectory = useTemporaryDirectories();

function startServer(): S3TestServer {
  const server = createS3TestServer({ bucket: BUCKET });
  servers.push(server);
  return server;
}

type Environment = Record<string, string | undefined>;

/** Every variable remote mode reads, set, under `NODE_ENV=test` with no `<NAME>_HOME`. */
function remoteEnvironment(endpoint: string, overrides: Environment = {}): Environment {
  return {
    NODE_ENV: 'test',
    [DATABASE_VARIABLE]: DATABASE_URL,
    [BUCKET_VARIABLE]: BUCKET,
    [PREFIX_VARIABLE]: PREFIX,
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
    S3_SESSION_TOKEN: SESSION_TOKEN,
    BUNGALOW_TEST_SECRET_API_KEY: SECRET_VALUE,
    ...overrides,
  };
}

function openRemote(endpoint: string, overrides: Environment = {}) {
  return openBungalow({ name: TEST_NAME, environment: remoteEnvironment(endpoint, overrides) });
}

/** The message and `cause` of a failure hold no bucket, prefix, URL, credential, or secret. */
function expectNothingLeaked(error: unknown, endpoint: string): void {
  expect(error).toBeInstanceOf(Error);
  const { message, cause } = error as Error;
  const text = `${message} ${JSON.stringify(cause) ?? ''}`;
  for (const sentinel of [
    BUCKET,
    PREFIX,
    ACCESS_KEY_ID,
    SECRET_ACCESS_KEY,
    SESSION_TOKEN,
    DATABASE_URL,
    'sentinel-database-password',
    SECRET_VALUE,
    endpoint,
    '127.0.0.1',
    'deployment-id',
    'configuration.json',
  ]) {
    expect(text).not.toContain(sentinel);
  }
}

describe('remote mode: input outcome matrix', () => {
  const inputCases: readonly {
    readonly name: string;
    readonly overrides: Environment;
    readonly names: string;
  }[] = [
    {
      name: 'only the database URL',
      overrides: { [BUCKET_VARIABLE]: undefined },
      names: BUCKET_VARIABLE,
    },
    {
      name: 'only the bucket',
      overrides: { [DATABASE_VARIABLE]: undefined },
      names: DATABASE_VARIABLE,
    },
    { name: 'an empty bucket', overrides: { [BUCKET_VARIABLE]: '' }, names: BUCKET_VARIABLE },
    {
      name: 'an empty database URL',
      overrides: { [DATABASE_VARIABLE]: '' },
      names: DATABASE_VARIABLE,
    },
    {
      name: 'every S3 variable missing',
      overrides: {
        S3_ENDPOINT: undefined,
        S3_REGION: undefined,
        S3_ACCESS_KEY_ID: undefined,
        S3_SECRET_ACCESS_KEY: undefined,
      },
      names: 'S3_ENDPOINT',
    },
    { name: 'an empty endpoint', overrides: { S3_ENDPOINT: '' }, names: 'S3_ENDPOINT' },
    {
      name: 'no region or keys',
      overrides: { S3_REGION: undefined, S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: undefined },
      names: 'S3_REGION',
    },
    {
      name: 'no access key ID or secret key',
      overrides: { S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' },
      names: 'S3_ACCESS_KEY_ID',
    },
    {
      name: 'no secret access key',
      overrides: { S3_SECRET_ACCESS_KEY: undefined },
      names: 'S3_SECRET_ACCESS_KEY',
    },
    {
      name: 'a prefix with an empty segment',
      overrides: { [PREFIX_VARIABLE]: 'a//b' },
      names: PREFIX_VARIABLE,
    },
    {
      name: 'a prefix with a `..` segment',
      overrides: { [PREFIX_VARIABLE]: 'a/../b' },
      names: PREFIX_VARIABLE,
    },
    {
      name: 'a prefix ending in two slashes',
      overrides: { [PREFIX_VARIABLE]: 'prod//' },
      names: PREFIX_VARIABLE,
    },
    {
      name: 'a prefix of two slashes',
      overrides: { [PREFIX_VARIABLE]: '//' },
      names: PREFIX_VARIABLE,
    },
    {
      name: 'a prefix starting with two slashes',
      overrides: { [PREFIX_VARIABLE]: '//prod' },
      names: PREFIX_VARIABLE,
    },
    {
      name: 'an endpoint Bun refuses',
      overrides: { S3_ENDPOINT: 'http://' },
      names: 'S3_',
    },
  ];

  for (const { name, overrides, names } of inputCases) {
    test(`${name}: BungalowInputError naming ${names}, before any request`, async () => {
      const proxy = startProxy(startServer());
      const error = await rejectionOf(openRemote(proxy.endpoint, overrides));
      expect(error).toBeInstanceOf(BungalowInputError);
      expect((error as Error).message).toContain(names);
      expectNothingLeaked(error, proxy.endpoint);
      expect(proxy.requests).toEqual([]);
    });
  }

  test('neither selecting variable: local mode, and NODE_ENV=test still refuses it', async () => {
    const proxy = startProxy(startServer());
    const environment = remoteEnvironment(proxy.endpoint, {
      [DATABASE_VARIABLE]: undefined,
      [BUCKET_VARIABLE]: '',
    });
    const reject = await throwingRejectionOf(openBungalow({ name: TEST_NAME, environment }));
    expect(reject).toThrow(BungalowInputError);
    expect(reject).toThrow(/NODE_ENV=test/);
    expect(proxy.requests).toEqual([]);
  });

  test('remote mode opens under NODE_ENV=test and never reads <NAME>_HOME', async () => {
    const server = startServer();
    // A relative `<NAME>_HOME` is refused in local mode, so opening proves it was not read.
    using bungalow = await openRemote(server.endpoint, { [TEST_HOME_VARIABLE]: 'relative/home' });
    expect(bungalow.mode).toBe('remote');
  });
});

describe('remote mode: the lock', () => {
  test('a remote open never asks for the lock, which a local open through the same seam does', async () => {
    const server = startServer();
    const acquireLock = (): never => {
      throw new Error('flock was requested');
    };
    using remote = await openBungalowWithDependencies(
      { name: TEST_NAME, environment: remoteEnvironment(server.endpoint) },
      { acquireLock },
    );
    expect(remote.mode).toBe('remote');
    const local = await throwingRejectionOf(
      openBungalowWithDependencies(
        { name: TEST_NAME, environment: homeEnvironment(temporaryDirectory()) },
        { acquireLock },
      ),
    );
    expect(local).toThrow('flock was requested');
  });
});

describe('remote mode: the bucket prefix', () => {
  const prefixCases: readonly (readonly [string | undefined, string])[] = [
    ['prod', 'prod/'],
    ['/prod/', 'prod/'],
    ['a/b', 'a/b/'],
    ['/', ''],
    ['', ''],
    [undefined, ''],
  ];
  for (const [raw, normalized] of prefixCases) {
    test(`${JSON.stringify(raw)} is the prefix ${JSON.stringify(normalized)}`, async () => {
      const server = startServer();
      using bungalow = await openRemote(server.endpoint, { [PREFIX_VARIABLE]: raw });
      expect(bungalow.content('agents')).toEqual({
        kind: 's3',
        bucket: BUCKET,
        prefix: `${normalized}agents/`,
      });
      expect(bungalow.configurationLocation).toBe(`s3://${BUCKET}/${normalized}configuration.json`);
      expect([...server.objects().keys()]).toEqual([`${normalized}deployment-id`]);
    });
  }
});

describe('remote mode: the deployment ID outcome matrix', () => {
  test('an empty bucket: written with If-None-Match, read back, and used', async () => {
    const server = startServer();
    const proxy = startProxy(server);
    using bungalow = await openRemote(proxy.endpoint);
    expect(isUlid(bungalow.deploymentId)).toBe(true);
    expect(new TextDecoder().decode(server.objects().get(DEPLOYMENT_KEY))).toBe(
      `${bungalow.deploymentId}\n`,
    );
    expect(proxy.requests).toEqual([
      { method: 'GET', key: DEPLOYMENT_KEY },
      { method: 'PUT', key: DEPLOYMENT_KEY },
      { method: 'GET', key: DEPLOYMENT_KEY },
    ]);
  });

  test('a stored ULID is used and nothing is written', async () => {
    const server = startServer();
    const proxy = startProxy(server);
    const stored = generateUlid();
    server.put(DEPLOYMENT_KEY, `${stored}\n`);
    using bungalow = await openRemote(proxy.endpoint);
    expect(bungalow.deploymentId).toBe(stored);
    expect(proxy.requests).toEqual([{ method: 'GET', key: DEPLOYMENT_KEY }]);
  });

  test('a stored value that is not a ULID is BungalowStateError and is left alone', async () => {
    const server = startServer();
    const proxy = startProxy(server);
    server.put(DEPLOYMENT_KEY, 'not-a-ulid\n');
    const reject = await throwingRejectionOf(openRemote(proxy.endpoint));
    expect(reject).toThrow(BungalowStateError);
    expect(new TextDecoder().decode(server.objects().get(DEPLOYMENT_KEY))).toBe('not-a-ulid\n');
    expect(proxy.requests.map(({ method }) => method)).toEqual(['GET']);
  });

  test('losing the conditional write (412) uses the winner’s stored value', async () => {
    const server = startServer();
    const proxy = startProxy(server);
    const winner = generateUlid();
    proxy.intercept(({ method }) => {
      // Another instance writes between this one's read and its write.
      if (method === 'PUT') server.put(DEPLOYMENT_KEY, `${winner}\n`);
      return undefined;
    });
    using bungalow = await openRemote(proxy.endpoint);
    expect(bungalow.deploymentId).toBe(winner);
    expect(new TextDecoder().decode(server.objects().get(DEPLOYMENT_KEY))).toBe(`${winner}\n`);
  });

  test('eight opens at once against an empty bucket share one deployment ID', async () => {
    const server = startServer();
    const opened = await Promise.all(Array.from({ length: 8 }, () => openRemote(server.endpoint)));
    const identifiers = new Set(opened.map((bungalow) => bungalow.deploymentId));
    for (const bungalow of opened) bungalow.close();
    expect(identifiers.size).toBe(1);
    const [identifier] = identifiers;
    expect(new TextDecoder().decode(server.objects().get(DEPLOYMENT_KEY))).toBe(`${identifier}\n`);
  });

  const failureCases: readonly {
    readonly name: string;
    readonly answer: (method: string) => Response | undefined;
    readonly message: string;
    readonly cause: unknown;
  }[] = [
    {
      name: 'a 500 on the first read',
      answer: (method) => (method === 'GET' ? new Response('boom', { status: 500 }) : undefined),
      message: 'Could not read deployment ID.',
      cause: { status: 500 },
    },
    {
      name: 'a 500 on the conditional write',
      answer: (method) => (method === 'PUT' ? new Response('boom', { status: 500 }) : undefined),
      message: 'Could not write deployment ID.',
      cause: { status: 500 },
    },
    {
      name: 'an object that vanished between the write and the read back',
      // The write reports success without storing anything, so the read back finds no object.
      answer: (method) => (method === 'PUT' ? new Response(null, { status: 200 }) : undefined),
      message: 'Could not read deployment ID.',
      cause: { status: 404 },
    },
  ];
  for (const { name, answer, message, cause } of failureCases) {
    test(`${name}: BungalowFilesystemError naming only the operation`, async () => {
      const proxy = startProxy(startServer());
      proxy.intercept(({ method }) => answer(method));
      const error = await rejectionOf(openRemote(proxy.endpoint));
      expect(error).toBeInstanceOf(BungalowFilesystemError);
      expect((error as Error).message).toBe(message);
      expect((error as Error).cause).toEqual(cause);
      expectNothingLeaked(error, proxy.endpoint);
    });
  }

  test('a refused connection: BungalowFilesystemError whose cause is only the code', async () => {
    const server = startServer();
    const endpoint = server.endpoint;
    await server.stop();
    const error = await rejectionOf(openRemote(endpoint));
    expect(error).toBeInstanceOf(BungalowFilesystemError);
    expect((error as Error).message).toBe('Could not read deployment ID.');
    expect((error as Error).cause).toEqual({ code: 'ECONNREFUSED' });
    expectNothingLeaked(error, endpoint);
  });
});

describe('remote mode: the handle', () => {
  test('hands out remote locations and the configured S3 client', async () => {
    const server = startServer();
    // `S3_BUCKET` is never read: the client's bucket is `<NAME>_BUCKET`.
    using bungalow = await openRemote(server.endpoint, { S3_BUCKET: 'ambient-bucket' });
    expect(bungalow.mode).toBe('remote');
    expect(bungalow.database).toEqual({ kind: 'postgres', url: DATABASE_URL });
    expect(bungalow.logs).toBeUndefined();
    expect(bungalow.configurationLocation).toBe(`s3://${BUCKET}/${CONFIGURATION_KEY}`);
    expect(bungalow.content('workflows')).toEqual({
      kind: 's3',
      bucket: BUCKET,
      prefix: `${PREFIX}/workflows/`,
    });
    const client = bungalow.s3Client();
    expect(client).toBeInstanceOf(Bun.S3Client);
    const url = client?.presign('probe') ?? '';
    expect(url.startsWith(`${server.endpoint}/${BUCKET}/probe?`)).toBe(true);
    expect(url).toContain(ACCESS_KEY_ID);
    expect(url).toContain(SESSION_TOKEN);
    server.put(`${PREFIX}/agents/a.md`, 'agent');
    expect(await client?.file(`${PREFIX}/agents/a.md`).text()).toBe('agent');
  });

  test('reads the configuration from the bucket, or undefined when absent', async () => {
    const server = startServer();
    using bungalow = await openRemote(server.endpoint);
    expect(await bungalow.readConfiguration()).toBeUndefined();
    server.put(CONFIGURATION_KEY, '{"providers":[]}');
    expect(await bungalow.readConfiguration()).toBe('{"providers":[]}');
  });

  test('a 500 reading the configuration names only the operation', async () => {
    const proxy = startProxy(startServer());
    using bungalow = await openRemote(proxy.endpoint);
    proxy.intercept(({ key }) =>
      key === CONFIGURATION_KEY ? new Response('boom', { status: 500 }) : undefined,
    );
    const error = await rejectionOf(bungalow.readConfiguration());
    expect(error).toBeInstanceOf(BungalowFilesystemError);
    expect((error as Error).message).toBe('Could not read configuration.');
    expect((error as Error).cause).toEqual({ status: 500 });
    expectNothingLeaked(error, proxy.endpoint);
  });

  test('reads secrets from <NAME>_SECRET_<KEY> and refuses to write them', async () => {
    const server = startServer();
    using bungalow = await openRemote(server.endpoint, { BUNGALOW_TEST_SECRET_EMPTY: '' });
    expect(bungalow.readSecret('api-key')).toBe(SECRET_VALUE);
    expect(bungalow.readSecret('missing')).toBeUndefined();
    expect(bungalow.readSecret('empty')).toBeUndefined();
    expect(bungalow.secretLocation('api-key')).toBe('BUNGALOW_TEST_SECRET_API_KEY');
    expect(() => bungalow.readSecret('API_KEY')).toThrow(BungalowInputError);
    let thrown: unknown;
    try {
      bungalow.writeSecret('api-key', 'new-sentinel-value');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BungalowStateError);
    expect((thrown as Error).message).not.toContain('api-key');
    expect((thrown as Error).message).not.toContain('new-sentinel-value');
  });

  test('secrets are read from the environment as it was when the open began', async () => {
    const server = startServer();
    const environment = remoteEnvironment(server.endpoint);
    const opening = openBungalow({ name: TEST_NAME, environment });
    environment['BUNGALOW_TEST_SECRET_API_KEY'] = 'changed-after-the-open-began';
    environment['BUNGALOW_TEST_SECRET_LATE'] = 'added-after-the-open-began';
    using bungalow = await opening;
    expect(bungalow.readSecret('api-key')).toBe(SECRET_VALUE);
    expect(bungalow.readSecret('late')).toBeUndefined();
  });

  test('close is idempotent and a closed handle refuses further use', async () => {
    const server = startServer();
    const bungalow = await openRemote(server.endpoint);
    bungalow.close();
    bungalow.close();
    bungalow[Symbol.dispose]();
    expect(() => bungalow.s3Client()).toThrow(BungalowStateError);
    expect(() => bungalow.content('agents')).toThrow(BungalowStateError);
    expect(() => bungalow.readSecret('api-key')).toThrow(BungalowStateError);
    const reject = await throwingRejectionOf(bungalow.readConfiguration());
    expect(reject).toThrow(BungalowStateError);
  });

  test('the package still has no runtime dependencies', async () => {
    const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
    expect(manifest).toBeObject();
    expect(Object.keys(Object(manifest)).filter((field) => /dependencies$/i.test(field))).toEqual([
      'devDependencies',
    ]);
  });

  test('a local Bungalow has no S3 client', async () => {
    using bungalow = await openTemporaryBungalow({ name: TEST_NAME });
    expect(bungalow.s3Client()).toBeUndefined();
  });
});
