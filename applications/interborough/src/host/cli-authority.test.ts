import { openBungalow } from '@lostgradient/bungalow';
import { BUREAU_SCOPES } from '@lostgradient/bureau';
import { AUTHORIZATION_SCOPES, principalFromApiKey } from '@lostgradient/weft';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { executeCli } from './cli-client.ts';
import { enableDemoPlugin } from './demo-plugin-home.ts';
import { startHost, type Host } from './host.ts';

const endpoint = 'https://management.example.test';
const hosts: Host[] = [];
const homes: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function authenticatedHost(removed: () => boolean): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-host-'));
  homes.push(home);
  await enableDemoPlugin(home);
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  const actualWorkspaceId = bungalow.workspaceId;
  await bungalow.close();
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    workspaceId: actualWorkspaceId,
    port: 0,
    workspaceAuthentication: {
      authentication: {
        resolveApiKeyPrincipal: async (key) =>
          ['alice', 'bob', 'administrator'].includes(key)
            ? principalFromApiKey({
                subject: key,
                scopes: [...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES],
              })
            : null,
      },
      workspace: {
        workspaceId: actualWorkspaceId,
        resolveMembership: async ({ subject }) => {
          if (removed() || subject === undefined) return null;
          return {
            version: 1,
            workspaceId: actualWorkspaceId,
            actorId: subject,
            actorKind: 'user',
            owner: `owner-${subject}`,
            membershipRevision: 'fixture-v1',
            capabilities:
              subject === 'administrator'
                ? ['workspace:use', 'workspace:manage', 'deployment:operate']
                : ['workspace:use'],
          };
        },
        resolveOwnerMembership: async () => null,
      },
    },
  });
  hosts.push(host);
  return host;
}

function injectedHttpsFetch(
  host: Host,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const incoming = new Request(input, init);
    const target = new URL(incoming.url);
    target.protocol = host.url.protocol;
    target.hostname = host.url.hostname;
    target.port = host.url.port;
    return fetch(target, incoming);
  };
}

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
      const actor = request.headers.get('x-api-key') === 'alice-token' ? 'alice' : 'bob';
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
    expect(redirectCalls[0]?.headers.get('x-api-key')).toBe('alice-token');
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

  // spawn-free: injected HTTPS fetch targets real authenticated host authority seams.
  test('exercises two workspaces, actor capabilities, denial, revocation, and connection switching', async () => {
    let revoked = false;
    const first = await authenticatedHost(() => revoked);
    const second = await authenticatedHost(() => false);
    const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-preferences-'));
    homes.push(directory);
    const preferencesPath = join(directory, 'preferences.json');
    const dependencies = {
      preferencesPath,
      environment: { ALICE: 'alice', BOB: 'bob', ADMIN: 'administrator' },
      fetch: injectedHttpsFetch(first),
    };
    await executeCli(
      [
        'connection',
        'add',
        'first',
        '--url',
        'https://first.example',
        '--credential-reference',
        'ALICE',
      ],
      dependencies,
    );
    await executeCli(
      [
        'connection',
        'add',
        'second',
        '--url',
        'https://second.example',
        '--credential-reference',
        'BOB',
      ],
      dependencies,
    );
    const alice = await executeCli(
      ['whoami', '--connection', 'first', '--workspace', first.workspaceId],
      dependencies,
    );
    expect(alice.exitCode).toBe(0);
    expect(JSON.parse(alice.stdout)).toMatchObject({
      actor: 'alice',
      workspace: first.workspaceId,
    });

    const bob = await executeCli(
      ['whoami', '--connection', 'second', '--workspace', second.workspaceId],
      { ...dependencies, fetch: injectedHttpsFetch(second) },
    );
    expect(bob.exitCode).toBe(0);
    expect(JSON.parse(bob.stdout)).toMatchObject({
      actor: 'bob',
      workspace: second.workspaceId,
    });

    const privateMemory = await executeCli(
      [
        'memory',
        'remember',
        '--agent',
        'shared',
        '--content',
        'alice-private-memory',
        '--connection',
        'first',
      ],
      dependencies,
    );
    expect([0, 7]).toContain(privateMemory.exitCode);
    expect(privateMemory.stdout).not.toContain('alice-private-memory');
    await executeCli(
      [
        'connection',
        'add',
        'bob-first',
        '--url',
        'https://first.example',
        '--credential-reference',
        'BOB',
      ],
      dependencies,
    );
    const bobPrivateMemory = await executeCli(
      ['memory', 'search', '--agent', 'shared', '--query', 'private', '--connection', 'bob-first'],
      dependencies,
    );
    expect(bobPrivateMemory.exitCode).toBe(0);
    expect(bobPrivateMemory.stdout).not.toContain('alice-private-memory');
    const administratorMutation = await executeCli(
      [
        'schedules',
        'create',
        '--file',
        '-',
        '--connection',
        'first',
        '--workspace',
        first.workspaceId,
      ],
      { ...dependencies, stdin: async () => '{}' },
    );
    expect([3, 7]).toContain(administratorMutation.exitCode);

    revoked = true;
    const afterRemoval = await executeCli(
      ['memory', 'search', '--agent', 'missing', '--query', 'private', '--connection', 'first'],
      dependencies,
    );
    expect(afterRemoval.exitCode).not.toBe(0);
    const mismatch = await executeCli(
      ['whoami', '--connection', 'first', '--workspace', second.workspaceId],
      dependencies,
    );
    expect(mismatch.exitCode).not.toBe(0);
  });
});
