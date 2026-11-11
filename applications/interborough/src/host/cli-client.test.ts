import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createCatalogSnapshot } from '@lostgradient/weft';

import {
  CLI_COMMAND_REGISTRY,
  CLI_OPERATION_COVERAGE,
  CLI_OPERATION_INVENTORY,
  executeCli,
  parseCliArguments,
  renderCliCompletion,
} from './cli-client.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-'));
  const calls: Request[] = [];
  let restarted = false;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    if (new URL(request.url).pathname === '/openrpc.json')
      return Response.json({ methods: [{ name: 'weft.system.health', description: 'health' }] });
    if (new URL(request.url).pathname === '/host/status')
      return Response.json({
        deploymentId: 'deployment-1',
        incarnationId: restarted ? 'incarnation-2' : 'incarnation-1',
        diagnostics: { providers: [] },
      });
    if (new URL(request.url).pathname === '/host/restart' && request.method === 'POST') {
      restarted = true;
      return Response.json({ restarting: true }, { status: 202 });
    }
    return Response.json({ deployment: 'local', ok: true });
  };
  return { preferencesPath: join(directory, 'preferences.json'), calls, fetch };
}

describe('Interborough command client', () => {
  // spawn-free: completion renders a string and no process opener stands in for it.
  test('keeps the public command registry complete and completion output data-only', async () => {
    const publicCommands = Object.keys(CLI_COMMAND_REGISTRY);
    expect(publicCommands).toContain('providers');
    expect(publicCommands).not.toContain('__interborough-host');
    for (const command of publicCommands) {
      const metadata = CLI_COMMAND_REGISTRY[command]!;
      expect(metadata.command).toBe(command);
      expect(metadata.help).toContain(`interborough ${command}`);
      expect(metadata.options).toContain('help');
      expect(parseCliArguments([command, '--help'])).toMatchObject({ exitCode: 0 });
    }
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const completion = renderCliCompletion(shell);
      expect(completion).toContain('interborough');
      expect(completion).toContain('providers');
      expect(completion).toContain(shell === 'fish' ? '-l help' : '--help');
    }
    const bash = renderCliCompletion('bash');
    expect(bash).toContain('status)');
    expect(bash.match(/status\).*--file/g)).toBeNull();
    expect(bash).toContain('completion)');
    expect(bash).toContain('complete -F _interborough_complete interborough');
    expect(parseCliArguments(['completion', 'bash'])).toMatchObject({ command: 'completion' });
    const completion = await executeCli(['completion', 'fish']);
    expect(completion.exitCode).toBe(0);
    expect(completion.stdout).toContain('complete -c interborough');
    expect(CLI_OPERATION_INVENTORY).toContain('connection.list');
    expect(CLI_OPERATION_INVENTORY).toContain('workflows.*');
    const catalogNames = createCatalogSnapshot().operations.map((operation) => operation.name);
    expect(Object.keys(CLI_OPERATION_COVERAGE).sort()).toEqual([...catalogNames].sort());
    for (const [operation, coverage] of Object.entries(CLI_OPERATION_COVERAGE)) {
      if ('excluded' in coverage) expect(coverage.reason).not.toBe('');
      else {
        expect(coverage.command).toBe('api');
        expect(coverage.action).toBe('call');
      }
      expect(operation).toMatch(/^[a-z]+\.[a-z0-9_.-]+$/);
    }
  });

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
        deployment: { identity: 'deployment-1', capability: 'available' },
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
  test('paginates connection profiles without implicit all-pages fetching', async () => {
    const fixture_ = await fixture();
    for (const name of ['one', 'two', 'three']) {
      const added = await executeCli(
        ['connection', 'add', name, '--url', 'http://localhost'],
        fixture_,
      );
      expect(added.exitCode).toBe(0);
    }
    const page = await executeCli(
      ['connection', 'list', '--limit', '2', '--output', 'json'],
      fixture_,
    );
    expect(JSON.parse(page.stdout)).toMatchObject({
      data: [{ name: 'one' }, { name: 'two' }],
      metadata: { cursor: '2', page: { limit: 2, all: false } },
    });
    const all = await executeCli(['connection', 'list', '--all', '--output', 'json'], fixture_);
    expect(JSON.parse(all.stdout).metadata).toMatchObject({ cursor: null, page: { all: true } });
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
      return Response.json({
        jsonrpc: '2.0',
        id: '1',
        error: { code: -32001, message: 'Denied', data: { httpStatus: 403 } },
      });
    };
    const result = await executeCli(
      ['api', 'call', 'weft.workflows.cancel', '--yes', '--url', 'http://localhost'],
      fixture_,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('Denied');
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('maps JSON-RPC HTTP status metadata to auth and conflict exit codes', async () => {
    const fixture_ = await fixture();
    fixture_.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/openrpc.json')
        return Response.json({ methods: [{ name: 'weft.alerts.list' }] });
      const status = request.headers.get('x-status') ?? '401';
      return Response.json({
        error: { code: -32001, message: 'Rejected', data: { httpStatus: Number(status) } },
      });
    };
    const unauthorized = await executeCli(['api', 'call', 'weft.alerts.list', '--yes'], fixture_);
    expect(unauthorized.exitCode).toBe(3);
    fixture_.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/openrpc.json')
        return Response.json({ methods: [{ name: 'weft.alerts.list' }] });
      return Response.json({
        error: { code: -32001, message: 'Conflict', data: { httpStatus: 409 } },
      });
    };
    const conflict = await executeCli(['api', 'call', 'weft.alerts.list', '--yes'], fixture_);
    expect(conflict.exitCode).toBe(4);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('reports malformed mutation responses as uncertain without retrying', async () => {
    const fixture_ = await fixture();
    let postRequests = 0;
    fixture_.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/openrpc.json')
        return Response.json({ methods: [{ name: 'weft.alerts.list' }] });
      if (request.method === 'POST') postRequests += 1;
      return new Response('{"jsonrpc":"2.0"', { status: 200 });
    };
    const result = await executeCli(['api', 'call', 'weft.alerts.list', '--yes'], fixture_);
    expect(result.exitCode).toBe(7);
    expect(postRequests).toBe(1);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('observes restart after the acknowledgement', async () => {
    const fixture_ = await fixture();
    const result = await executeCli(['restart', '--yes'], fixture_);
    expect(result.exitCode).toBe(0);
    expect(
      fixture_.calls.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ).toEqual(['GET /host/status', 'POST /host/restart', 'GET /host/status']);
  });

  // spawn-free: injected fetch and no process opener stand in for command execution.
  test('uses explicit pagination and rejects JSONL for non-streaming API output', async () => {
    const fixture_ = await fixture();
    fixture_.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/openrpc.json')
        return Response.json({
          methods: [
            { name: 'weft.alerts.list' },
            { name: 'weft.catalog.diagnostics' },
            { name: 'weft.conformance.targets' },
          ],
        });
      return Response.json({ ok: true });
    };
    const page = await executeCli(['api', 'list', '--limit', '2', '--output', 'json'], fixture_);
    expect(page.exitCode).toBe(0);
    expect(JSON.parse(page.stdout)).toMatchObject({
      data: [{ name: 'weft.alerts.list' }, { name: 'weft.catalog.diagnostics' }],
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
