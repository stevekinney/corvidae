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
