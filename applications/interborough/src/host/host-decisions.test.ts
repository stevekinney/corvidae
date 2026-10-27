/**
 * COR-1709 — the host's decision model: with the `typesafe-api-key` secret in Bungalow's secrets, Bureau's
 * decisions are answered by `typesafeJev` for the kinds it serves, and without it the host starts
 * all the same and leaves every decision to the catalog's fallback. No test reaches the network:
 * `fetch` is replaced for the whole file, and the key is a fixture.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { TYPESAFE_SECRET_KEY } from './providers.ts';

const FIXTURE_KEY = 'fixture-typesafe-key-51c9';
const directories: string[] = [];
const hosts: Host[] = [];
const realFetch = globalThis.fetch;
let requests: Request[] = [];

beforeEach(() => {
  requests = [];
  // Any request the decision model makes lands here and is refused, so nothing leaves the process.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response('refused by the test', { status: 500 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function startWith(secrets: Readonly<Record<string, string>>): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-decisions-'));
  directories.push(home);
  const bungalow = openBungalow({ name: 'interborough', environment: { INTERBOROUGH_HOME: home } });
  try {
    for (const [key, value] of Object.entries(secrets)) bungalow.writeSecret(key, value);
  } finally {
    bungalow.close();
  }
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

describe('the TypeSafe decision model', () => {
  test('starts without the typesafe-api-key secret and leaves every decision to the catalog’s fallback', async () => {
    const host = await startWith({});

    const failure = await host.bureau.decisions
      .decide({ kind: 'boolean', question: 'Is it?' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // No provider holds a key, so the catalog has no row to fall back to.
    expect(failure).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(requests).toEqual([]);
  });

  test('starts with the typesafe-api-key secret and asks TypeSafe for a boolean, a choice, and a scale', async () => {
    const host = await startWith({ [TYPESAFE_SECRET_KEY]: FIXTURE_KEY });

    const failure = await host.bureau.decisions
      .decide({ kind: 'boolean', question: 'Is it?' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The refused request is TypeSafe's, not a fallback's: the fallback has no row to run.
    expect(failure).toBeDefined();
    expect(failure).not.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(requests.length).toBeGreaterThan(0);
    expect(String(failure)).not.toContain(FIXTURE_KEY);
  });

  test('sends a kind TypeSafe does not serve to the fallback even with the key', async () => {
    const host = await startWith({ [TYPESAFE_SECRET_KEY]: FIXTURE_KEY });

    const failure = await host.bureau.decisions
      .decide({
        kind: 'structured',
        question: 'Name it',
        schema: (await import('zod')).z.object({}),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(requests).toEqual([]);
  });
});
