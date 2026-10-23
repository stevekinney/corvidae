import { describe, expect, test } from 'bun:test';

import { acceptsHtml, isShellNavigation } from './shell-request.ts';

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

  test('leaves a request that rules HTML out with a zero quality a 404', () => {
    for (const accept of [
      'application/json, text/html;q=0',
      'application/json, text/html; q=0.0',
      'text/html;q=0, */*',
      'text/html;Q=0',
      'text/html;q=nonsense',
    ]) {
      expect(isShellNavigation(request('/nonsense', { headers: { accept } })), accept).toBe(false);
    }
  });

  test('takes a request that ranks HTML above zero', () => {
    for (const accept of [
      'application/json, text/html;q=0.1',
      'TEXT/HTML',
      'text/html ; q=1',
      'application/json;q=0, text/html',
    ]) {
      expect(isShellNavigation(request('/nonsense', { headers: { accept } })), accept).toBe(true);
    }
  });
});

describe('acceptsHtml', () => {
  test('needs text/html named with a positive quality, and nothing else counts', () => {
    expect(acceptsHtml('text/html')).toBe(true);
    expect(acceptsHtml('text/html;q=0')).toBe(false);
    expect(acceptsHtml('text/htmlx')).toBe(false);
    expect(acceptsHtml('application/xhtml+xml, text/*, */*')).toBe(false);
    expect(acceptsHtml('')).toBe(false);
  });
});
