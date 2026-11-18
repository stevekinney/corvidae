/**
 * The Bureau's operations on the host's composed `/jsonrpc` (COR-2480), where the browser's
 * generated client sends them: a caller who lacks a scope is refused there exactly as on
 * `/bureau/jsonrpc`, and every operation the browser calls is answered there.
 */
import { Glob } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { BUREAU_METHOD_SCOPES } from './scope-gate.ts';

const METHOD_NOT_FOUND = -32601;

let home: string;
let unscoped: Host;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'interborough-composed-'));
  // A caller holding no scope of Interborough's API.
  unscoped = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    apiPrincipal: () => ({ subject: 'anonymous:local', scopes: new Set() }),
  });
});

afterAll(async () => {
  await unscoped.close();
  await rm(home, { recursive: true, force: true });
});

async function post(path: string, method: string, params: unknown) {
  const response = await fetch(new URL(path, unscoped.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe('the scope gate on the composed /jsonrpc', () => {
  test.each([...BUREAU_METHOD_SCOPES.keys()])(
    'refuses %s as /bureau/jsonrpc does, with the same status and body',
    async (method) => {
      const composed = await post('/jsonrpc', method, {});
      const own = await post('/bureau/jsonrpc', method, {});

      expect(composed.status).toBe(own.status);
      expect(composed.body).toEqual(own.body);
      expect(composed.body).toMatchObject({
        error: { data: { weftCode: 'Forbidden', scope: BUREAU_METHOD_SCOPES.get(method) } },
      });
    },
  );
});

/** The Bureau operations the browser's code in `src/lib` calls, by the name it passes. */
async function operationsCalledByTheBrowser(): Promise<string[]> {
  const names = new Set<string>();
  const directory = join(import.meta.dir, '..', 'lib');
  for await (const path of new Glob('**/*.ts').scan({ cwd: directory, absolute: true })) {
    if (/\.test(-support)?\.ts$|\/generated\//u.test(path)) continue;
    const source = await Bun.file(path).text();
    const calls = source.matchAll(/callBureau\(\s*('bureau\.[\w.]+')|bureauClient\[([^\]]*)\]/gu);
    for (const call of calls) {
      for (const literal of (call[1] ?? call[2] ?? '').matchAll(/'(bureau\.[\w.]+)'/gu)) {
        if (literal[1] !== undefined) names.add(literal[1]);
      }
    }
  }
  return [...names].toSorted();
}

describe('the operations the browser calls', () => {
  test('every one answers on /jsonrpc with something other than method-not-found', async () => {
    const names = await operationsCalledByTheBrowser();
    expect(names.length).toBeGreaterThan(20);

    for (const name of names) {
      // A params value that is not an object is refused before any operation runs.
      const { body } = await post('/jsonrpc', name, 'not-params');
      expect(body, name).not.toMatchObject({ error: { code: METHOD_NOT_FOUND } });
    }
  });
});
