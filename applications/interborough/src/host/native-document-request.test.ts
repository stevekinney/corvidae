import { expect, test } from 'bun:test';

import { isDocumentRequest } from './native-document-request.ts';

const request = (pathname: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1:7300${pathname}`, init);

test('Velveteen owns unclaimed document, data and native asset reads', () => {
  for (const path of ['/nonsense/route', '/runs/abc/extra', '/_assets/missing.js', '/a%20b']) {
    expect(isDocumentRequest(request(path, { headers: { accept: 'text/html' } })), path).toBe(true);
    expect(isDocumentRequest(request(path, { method: 'HEAD' })), path).toBe(true);
  }
  expect(
    isDocumentRequest(request('/runs', { headers: { accept: 'application/x-velveteen-data' } })),
  ).toBe(true);
});

test('the document application cannot take host paths, mutations or upgrades', () => {
  for (const path of [
    '/assets/missing.js',
    '/api/v1/principal',
    '/v1/schedules',
    '/jsonrpc',
    '/mcp',
    '/.well-known/openrpc.json',
    '/bureau/jsonrpc',
    '/host/other',
    '/auth/callback',
    '/oauth/token',
    '/triggers/unknown',
    '/_remote/unknown',
    '/key-admin/jsonrpc',
  ]) {
    expect(isDocumentRequest(request(path)), path).toBe(false);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    expect(isDocumentRequest(request('/runs', { method })), method).toBe(false);
  }
  expect(isDocumentRequest(request('/unclaimed', { headers: { upgrade: 'websocket' } }))).toBe(
    false,
  );
});
