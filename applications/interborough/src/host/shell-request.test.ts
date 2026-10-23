import { describe, expect, test } from 'bun:test';

import { isShellNavigation } from './shell-request.ts';

const HTML = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

function request(path: string, init: RequestInit = { headers: HTML }): Request {
  return new Request(`http://127.0.0.1:7300${path}`, init);
}

describe('isShellNavigation', () => {
  test('takes a document navigation to an address no route names', () => {
    for (const path of ['/nonsense/route', '/runs/abc/extra', '/missing.html', '/a%20b']) {
      expect(isShellNavigation(request(path)), path).toBe(true);
    }
    expect(isShellNavigation(request('/nonsense', { method: 'HEAD', headers: HTML }))).toBe(true);
  });

  test('leaves every path the engine, the Bureau, the host, or the build owns alone', () => {
    const owned = [
      '/assets/missing.js',
      '/assets',
      '/api/v1/principal',
      '/v1/schedules',
      '/jsonrpc',
      '/mcp',
      '/openapi.json',
      '/.well-known/openrpc.json',
      '/bureau/jsonrpc',
      '/bureau',
      '/host/paths',
      '/host/other',
    ];
    for (const path of owned) expect(isShellNavigation(request(path)), path).toBe(false);
  });

  test('leaves a request that does not ask for a page a 404', () => {
    expect(isShellNavigation(request('/nonsense', { headers: { accept: '*/*' } }))).toBe(false);
    expect(isShellNavigation(request('/nonsense', {}))).toBe(false);
    expect(isShellNavigation(request('/favicon.ico', { headers: { accept: 'image/*' } }))).toBe(
      false,
    );
  });

  test('leaves a method that is not a read alone', () => {
    expect(isShellNavigation(request('/nonsense', { method: 'POST', headers: HTML }))).toBe(false);
    expect(isShellNavigation(request('/nonsense', { method: 'DELETE', headers: HTML }))).toBe(
      false,
    );
  });
});
