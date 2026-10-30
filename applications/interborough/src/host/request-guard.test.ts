/**
 * The Host and Origin forms the guard accepts for a listener's port, including the default port
 * that a client leaves out (`request-guard.ts`).
 */
import { describe, expect, test } from 'bun:test';

import { createRequestGuard } from './request-guard.ts';

function request(headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1/', { headers });
}

function refused(port: number, headers: Record<string, string>): boolean {
  return createRequestGuard(() => port)(request(headers))?.status === 403;
}

describe('a listener on the default HTTP port', () => {
  test('accepts a Host that omits the port, under either name', () => {
    expect(refused(80, { host: 'localhost' })).toBe(false);
    expect(refused(80, { host: '127.0.0.1' })).toBe(false);
    expect(refused(80, { host: 'localhost:80' })).toBe(false);
  });

  test('accepts the page’s own Origin without a port', () => {
    expect(refused(80, { host: 'localhost', origin: 'http://localhost' })).toBe(false);
    expect(refused(80, { host: '127.0.0.1', origin: 'http://127.0.0.1:80' })).toBe(false);
  });

  test('still refuses another host and another origin', () => {
    expect(refused(80, { host: 'attacker.example' })).toBe(true);
    expect(refused(80, { host: 'localhost', origin: 'http://attacker.example' })).toBe(true);
    expect(refused(80, { host: 'localhost', origin: 'http://localhost.attacker.example' })).toBe(
      true,
    );
  });
});

describe('a listener on any other port', () => {
  test('refuses a Host that omits the port', () => {
    expect(refused(7234, { host: 'localhost' })).toBe(true);
    expect(refused(7234, { host: '127.0.0.1' })).toBe(true);
  });

  test('refuses an Origin that omits the port', () => {
    expect(refused(7234, { host: 'localhost:7234', origin: 'http://localhost' })).toBe(true);
  });

  test('accepts its own port', () => {
    expect(refused(7234, { host: 'localhost:7234', origin: 'http://localhost:7234' })).toBe(false);
  });
});

describe('a guard given a public A2A origin (COR-1904)', () => {
  const publicOrigin = new URL('https://agents.example.test:8443');

  function refusedAt(path: string, headers: Record<string, string>): boolean {
    const guard = createRequestGuard(() => 7234, publicOrigin);
    return guard(new Request(`http://127.0.0.1${path}`, { headers }))?.status === 403;
  }

  test('accepts that origin for an A2A path, under any case, with no Origin or its own', () => {
    expect(refusedAt('/bureau/a2a/open', { host: 'Agents.Example.Test:8443' })).toBe(false);
    expect(
      refusedAt('/bureau/a2a/open', {
        host: 'agents.example.test:8443',
        origin: 'https://agents.example.test:8443',
      }),
    ).toBe(false);
  });

  test('refuses that origin for any other path, another port, or a foreign Origin', () => {
    expect(refusedAt('/bureau/jsonrpc', { host: 'agents.example.test:8443' })).toBe(true);
    expect(refusedAt('/bureau/a2a', { host: 'agents.example.test:8443' })).toBe(true);
    expect(refusedAt('/bureau/a2a/open', { host: 'agents.example.test' })).toBe(true);
    expect(
      refusedAt('/bureau/a2a/open', {
        host: 'agents.example.test:8443',
        origin: 'https://attacker.example',
      }),
    ).toBe(true);
  });

  test('still answers loopback as before', () => {
    expect(refusedAt('/bureau/jsonrpc', { host: 'localhost:7234' })).toBe(false);
    expect(refusedAt('/bureau/a2a/open', { host: 'attacker.example' })).toBe(true);
  });
});

describe('a guard given a public origin on its default port (COR-1904)', () => {
  const guard = createRequestGuard(() => 7234, new URL('https://agents.example.test'));

  function statusAt(path: string, headers: Record<string, string>): number | undefined {
    return guard(new Request(`http://127.0.0.1${path}`, { headers }))?.status;
  }

  test('accepts the name with the default port written out or left out', () => {
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test' })).toBeUndefined();
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test:443' })).toBeUndefined();
  });

  test('refuses any other port', () => {
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test:8443' })).toBe(403);
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test:80' })).toBe(403);
  });

  test('lets an asset read through only with a credential, which the Bureau then checks', () => {
    const host = { host: 'agents.example.test' };
    expect(statusAt('/bureau/assets/a/content', { ...host, 'x-api-key': 'k' })).toBeUndefined();
    expect(
      statusAt('/bureau/assets/a/content', { ...host, authorization: 'Bearer k' }),
    ).toBeUndefined();
    expect(statusAt('/bureau/assets/a/content', host)).toBe(401);
    expect(statusAt('/bureau/assets/../jsonrpc', { ...host, 'x-api-key': 'k' })).toBe(403);
  });

  test('leaves an asset read on loopback to the Bureau, credential or not', () => {
    expect(statusAt('/bureau/assets/a/content', { host: 'localhost:7234' })).toBeUndefined();
  });
});
