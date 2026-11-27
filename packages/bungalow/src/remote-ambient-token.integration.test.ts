/**
 * COR-1793: remote credentials come only from the environment Bungalow is given. The default
 * presigner reads no environment, so an `AWS_SESSION_TOKEN` or `S3_SESSION_TOKEN` the process
 * started with never reaches a request. `Bun.S3Client` does sign with that ambient token whenever
 * no session token is set, so an open with a presigner over it must still fail closed, before any
 * request.
 */
import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { processEnvironment } from './environment-configuration.ts';
import { useS3Proxy, type ProxiedRequest } from './s3-proxy.test-support.ts';

const AMBIENT_TOKEN = 'sentinel-ambient-session-token';
const GIVEN_TOKEN = 'sentinel-given-session-token';
const BUCKET = 'sentinel-bucket';

const startProxy = useS3Proxy();

/** Which presigner the child injects: the default, or one over `Bun.S3Client`. */
type Presigner = 'default' | 'bun-presigner';

type Outcome =
  | {
      readonly outcome: 'opened';
      readonly deploymentId: string;
    }
  | { readonly outcome: 'failed'; readonly name: string; readonly message: string };

/** The process environment the child inherits, minus any session token of this process's own. */
function cleanProcessEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [variable, value] of Object.entries(processEnvironment())) {
    if (
      value !== undefined &&
      variable !== 'AWS_SESSION_TOKEN' &&
      variable !== 'S3_SESSION_TOKEN'
    ) {
      inherited[variable] = value;
    }
  }
  return inherited;
}

/** Open a remote Bungalow in a fresh Bun process whose own environment is `processEnvironment`. */
async function openInChild(
  endpoint: string,
  processEnvironment: Record<string, string>,
  givenEnvironment: Record<string, string>,
  presigner: Presigner,
): Promise<Outcome> {
  const environment = {
    NODE_ENV: 'test',
    BUNGALOW_TEST_DATABASE_URL: 'postgres://bungalow@127.0.0.1:5432/bungalow',
    BUNGALOW_TEST_BUCKET: BUCKET,
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'SENTINELACCESSKEYID',
    S3_SECRET_ACCESS_KEY: 'sentinel-secret-access-key',
    ...givenEnvironment,
  };
  const result = await runWithHangGuard(
    [
      process.execPath,
      join(import.meta.dir, '../testing/remote-open.test-support.ts'),
      JSON.stringify(environment),
      presigner,
    ],
    { env: { ...cleanProcessEnvironment(), ...processEnvironment } },
  );
  expect(result.stderr.toString()).toBe('');
  return JSON.parse(result.stdout.toString()) as Outcome;
}

/**
 * Every child runs here, at module scope, because a process started inside a test would pay its
 * boot on Bun's per-test clock. Each records its outcome and the requests its proxy saw.
 */
async function runCase(
  presigner: Presigner,
  processEnvironment: Record<string, string>,
  given: Record<string, string> = {},
): Promise<{
  readonly outcome: Outcome;
  readonly requests: readonly ProxiedRequest[];
  readonly sessionTokens: readonly (string | null)[];
}> {
  const server = createS3TestServer({ bucket: BUCKET });
  try {
    const proxy = startProxy(server);
    const outcome = await openInChild(proxy.endpoint, processEnvironment, given, presigner);
    return { outcome, requests: [...proxy.requests], sessionTokens: [...proxy.sessionTokens] };
  } finally {
    await server.stop();
  }
}

/** The ambient environments, each run once per presigner. */
const AMBIENT = [
  { name: 'AWS_SESSION_TOKEN and static keys', process: { AWS_SESSION_TOKEN: AMBIENT_TOKEN } },
  { name: 'S3_SESSION_TOKEN and static keys', process: { S3_SESSION_TOKEN: AMBIENT_TOKEN } },
  {
    name: 'AWS_SESSION_TOKEN and an empty S3_SESSION_TOKEN, which is unset',
    process: { AWS_SESSION_TOKEN: AMBIENT_TOKEN },
    given: { S3_SESSION_TOKEN: '' },
  },
] as const;

async function ambientCasesFor(presigner: Presigner) {
  const cases = [];
  for (const entry of AMBIENT) {
    cases.push({
      name: entry.name,
      result: await runCase(presigner, entry.process, 'given' in entry ? entry.given : {}),
    });
  }
  return cases;
}

const defaultAmbientCases = await ambientCasesFor('default');
const bunAmbientCases = await ambientCasesFor('bun-presigner');
const supplied = await runCase(
  'bun-presigner',
  { AWS_SESSION_TOKEN: AMBIENT_TOKEN },
  { S3_SESSION_TOKEN: GIVEN_TOKEN },
);
const unset = await runCase('bun-presigner', {});

describe('remote mode: the default presigner ignores a session token the process started with', () => {
  for (const { name, result } of defaultAmbientCases) {
    test(`${name}: opens, and no request carries the ambient token`, () => {
      expect(result.outcome.outcome).toBe('opened');
      if (result.outcome.outcome !== 'opened') return;
      expect(result.requests.length).toBeGreaterThan(0);
      expect(result.sessionTokens).toEqual(Array(result.requests.length).fill(null));
    });
  }
});

describe('remote mode: a Bun.S3Client presigner and a session token the process started with', () => {
  for (const { name, result } of bunAmbientCases) {
    test(`${name}: BungalowInputError naming the variables, before any request`, () => {
      expect(result.outcome.outcome).toBe('failed');
      if (result.outcome.outcome !== 'failed') return;
      expect(result.outcome.name).toBe('BungalowInputError');
      expect(result.outcome.message).toContain('AWS_SESSION_TOKEN');
      expect(result.outcome.message).toContain('S3_SESSION_TOKEN');
      expect(result.outcome.message).not.toContain(AMBIENT_TOKEN);
      expect(result.requests).toEqual([]);
    });
  }

  test('a session token the given environment supplies is the one every request carries', () => {
    expect(supplied.outcome.outcome).toBe('opened');
    if (supplied.outcome.outcome !== 'opened') return;
    expect(supplied.requests.length).toBeGreaterThan(0);
    expect(supplied.sessionTokens).toEqual(Array(supplied.requests.length).fill(GIVEN_TOKEN));
  });

  test('no session token anywhere: static keys open and sign without one', () => {
    expect(unset.outcome.outcome).toBe('opened');
    if (unset.outcome.outcome !== 'opened') return;
    expect(unset.requests.length).toBeGreaterThan(0);
    expect(unset.sessionTokens).toEqual(Array(unset.requests.length).fill(null));
  });
});
