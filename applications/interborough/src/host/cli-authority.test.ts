import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { executeCli } from './cli-client.ts';

const endpoint = 'https://management.example.test';

function principal(actorId: string, workspaceId: string, capabilities: string[]) {
  return Response.json({
    result: {
      workspace: { actorId, workspaceId, capabilities },
    },
  });
}

async function remoteFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-'));
  const calls: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/principal') {
      const actor = request.headers.get('authorization') === 'Bearer alice-token' ? 'alice' : 'bob';
      return principal(actor, actor === 'alice' ? 'workspace-a' : 'workspace-b', [
        'workspace:use',
        ...(actor === 'alice' ? ['workspace:manage'] : []),
      ]);
    }
    if (url.pathname === '/host/status') return Response.json({ deploymentId: 'remote-1' });
    if (url.pathname === '/openrpc.json')
      return Response.json({ methods: [{ name: 'weft.alerts.list' }] });
    if (url.pathname === '/bureau/jsonrpc')
      return Response.json({
        jsonrpc: '2.0',
        id: 'cli',
        error: { code: -32001, message: 'read-only', data: { httpStatus: 403 } },
      });
    return Response.json({ ok: true });
  };
  return { preferencesPath: join(directory, 'preferences.json'), calls, fetch };
}

describe('CLI authenticated workspace authority', () => {
  // spawn-free: injected fetch replaces the remote management process.
  test('requires HTTPS and an explicit credential environment reference for remote connections', async () => {
    const fixture = await remoteFixture();
    const insecure = await executeCli(['status', '--url', 'http://remote.example.test'], fixture);
    const missingReference = await executeCli(['status', '--url', endpoint], fixture);
    expect(insecure.exitCode).toBe(3);
    expect(missingReference.exitCode).toBe(3);
    expect(fixture.calls).toHaveLength(0);
  });

  // spawn-free: injected fetch replaces the remote management process.
  test('resolves actor, workspace, and capabilities from server authority', async () => {
    const fixture = await remoteFixture();
    const result = await executeCli(['whoami', '--url', endpoint, '--workspace', 'workspace-a'], {
      ...fixture,
      environment: { REMOTE_TOKEN: 'alice-token' },
      preferencesPath: fixture.preferencesPath,
    });
    expect(result.exitCode).toBe(3);

    await executeCli(
      ['connection', 'add', 'remote', '--url', endpoint, '--credential-reference', 'REMOTE_TOKEN'],
      fixture,
    );
    const authenticated = await executeCli(
      ['whoami', '--connection', 'remote', '--workspace', 'workspace-a', '--output', 'json'],
      { ...fixture, environment: { REMOTE_TOKEN: 'alice-token' } },
    );
    expect(authenticated.exitCode).toBe(0);
    expect(JSON.parse(authenticated.stdout).data).toEqual({
      actor: 'alice',
      workspace: 'workspace-a',
      capabilities: ['workspace:use', 'workspace:manage'],
    });
  });

  // spawn-free: injected fetch replaces the remote management process.
  test('rejects an expected workspace mismatch before the command runs', async () => {
    const fixture = await remoteFixture();
    await executeCli(
      ['connection', 'add', 'remote', '--url', endpoint, '--credential-reference', 'REMOTE_TOKEN'],
      fixture,
    );
    const result = await executeCli(
      ['status', '--connection', 'remote', '--workspace', 'workspace-other'],
      { ...fixture, environment: { REMOTE_TOKEN: 'alice-token' } },
    );
    expect(result.exitCode).toBe(3);
    expect(fixture.calls.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/v1/principal',
    ]);
  });

  // spawn-free: injected fetch replaces the remote management process.
  test('refuses redirects and never sends management credentials to A2A', async () => {
    const fixture = await remoteFixture();
    await executeCli(
      ['connection', 'add', 'remote', '--url', endpoint, '--credential-reference', 'REMOTE_TOKEN'],
      fixture,
    );
    const redirectCalls: Request[] = [];
    const redirected = await executeCli(['whoami', '--connection', 'remote'], {
      ...fixture,
      environment: { REMOTE_TOKEN: 'alice-token' },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        redirectCalls.push(request);
        if (new URL(request.url).pathname === '/api/v1/principal')
          return Response.redirect('https://other.example.test/api/v1/principal', 302);
        return Response.json({});
      },
    });
    expect(redirected.exitCode).toBe(1);
    expect(redirectCalls[0]?.headers.get('authorization')).toBe('Bearer alice-token');
    expect(redirectCalls[0]?.redirect).toBe('error');

    const a2a = await executeCli(
      ['api', 'call', 'weft.alerts.list', '--connection', 'remote', '--yes'],
      {
        ...fixture,
        environment: { REMOTE_TOKEN: 'alice-token' },
      },
    );
    expect(a2a.exitCode).toBe(3);
    expect(fixture.calls.map((request) => new URL(request.url).pathname)).not.toContain('/jsonrpc');
  });

  // spawn-free: injected fetch replaces the remote management process.
  test('keeps credentials out of preferences and maps server read-only outcomes', async () => {
    const fixture = await remoteFixture();
    const added = await executeCli(
      ['connection', 'add', 'remote', '--url', endpoint, '--credential-reference', 'REMOTE_TOKEN'],
      fixture,
    );
    expect(added.exitCode).toBe(0);
    const saved = await readFile(fixture.preferencesPath, 'utf8');
    expect(saved).toContain('REMOTE_TOKEN');
    expect(saved).not.toContain('alice-token');
    const result = await executeCli(
      [
        'memory',
        'search',
        '--agent',
        'private-agent',
        '--query',
        'private',
        '--connection',
        'remote',
      ],
      {
        ...fixture,
        environment: { REMOTE_TOKEN: 'alice-token' },
      },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('read-only');
    expect(result.stderr).not.toContain('alice-token');
  });
});
