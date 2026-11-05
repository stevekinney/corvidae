import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { executeCli, parseCliArguments } from './cli-client.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-'));
  const calls: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    if (new URL(request.url).pathname === '/openrpc.json')
      return Response.json({ methods: [{ name: 'weft.system.health', description: 'health' }] });
    if (new URL(request.url).pathname === '/host/restart')
      return Response.json({ restarting: true }, { status: 202 });
    return Response.json({ deployment: 'local', ok: true });
  };
  return { preferencesPath: join(directory, 'preferences.json'), calls, fetch };
}

describe('Interborough command client', () => {
  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('rejects unknown and duplicate options before making a request', async () => {
    const fixture_ = await fixture();
    expect(parseCliArguments(['status', '--wat'])).toMatchObject({ exitCode: 2 });
    expect(
      parseCliArguments(['status', '--url', 'http://localhost', '--url', 'http://localhost']),
    ).toMatchObject({ exitCode: 2 });
    const result = await executeCli(['status', '--wat'], fixture_);
    expect(result.exitCode).toBe(2);
    expect(fixture_.calls).toHaveLength(0);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('uses loopback endpoint and emits versioned JSON envelopes', async () => {
    const fixture_ = await fixture();
    const result = await executeCli(
      ['status', '--url', 'http://127.0.0.1:8123', '--output', 'json'],
      fixture_,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      data: {
        deployment: { identity: null, capability: 'unavailable' },
        reachability: { reachable: true },
      },
    });
    expect(fixture_.calls[0]?.headers.get('origin')).toBeNull();
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('refuses non-loopback management endpoints', async () => {
    const fixture_ = await fixture();
    const result = await executeCli(['status', '--url', 'https://example.com'], fixture_);
    expect(result.exitCode).toBe(3);
    expect(fixture_.calls).toHaveLength(0);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('stores endpoint and credential reference metadata without a token', async () => {
    const fixture_ = await fixture();
    const added = await executeCli(
      [
        'connection',
        'add',
        'local',
        '--url',
        'http://localhost:7234',
        '--credential-reference',
        'INTERBOROUGH_TOKEN',
      ],
      fixture_,
    );
    expect(added.exitCode).toBe(0);
    const text = await readFile(fixture_.preferencesPath, 'utf8');
    expect(text).toContain('INTERBOROUGH_TOKEN');
    expect(text).not.toContain('secret-value');
    const listed = await executeCli(['connection', 'list', '--output', 'json'], fixture_);
    expect(listed.exitCode).toBe(0);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('discovers and describes only the externally served API document', async () => {
    const fixture_ = await fixture();
    const result = await executeCli(
      ['api', 'describe', 'weft.system.health', '--url', 'http://localhost'],
      fixture_,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('weft.system.health');
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('treats a JSON-RPC error envelope as a failed mutation', async () => {
    const fixture_ = await fixture();
    fixture_.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/openrpc.json')
        return Response.json({ methods: [{ name: 'weft.workflows.cancel' }] });
      return Response.json({ jsonrpc: '2.0', id: '1', error: { code: -32001, message: 'Denied' } });
    };
    const result = await executeCli(
      ['api', 'call', 'weft.workflows.cancel', '--yes', '--url', 'http://localhost'],
      fixture_,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('Denied');
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('observes restart after the acknowledgement', async () => {
    const fixture_ = await fixture();
    const result = await executeCli(['restart', '--yes'], fixture_);
    expect(result.exitCode).toBe(0);
    expect(
      fixture_.calls.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ).toEqual(['POST /host/restart', 'GET /host/restart']);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('uses explicit pagination and rejects JSONL for non-streaming API output', async () => {
    const fixture_ = await fixture();
    fixture_.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/openrpc.json')
        return Response.json({ methods: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
      return Response.json({ ok: true });
    };
    const page = await executeCli(['api', 'list', '--limit', '2', '--output', 'json'], fixture_);
    expect(page.exitCode).toBe(0);
    expect(JSON.parse(page.stdout)).toMatchObject({
      data: [{ name: 'a' }, { name: 'b' }],
      metadata: { cursor: '2' },
    });
    const jsonLines = await executeCli(['api', 'list', '--output', 'jsonl'], fixture_);
    expect(jsonLines.exitCode).toBe(2);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('rejects ambiguous stdin consumers before network access', async () => {
    const fixture_ = await fixture();
    const result = await executeCli(
      ['api', 'call', 'weft.system.health', '--input', '-', '--input-file', '-'],
      { ...fixture_, stdin: async () => '{}' },
    );
    expect(result.exitCode).toBe(2);
    expect(fixture_.calls).toHaveLength(0);
  });
});
