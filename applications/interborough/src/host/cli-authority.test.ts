import { openBungalow } from '@lostgradient/bungalow';
import { BUREAU_SCOPES } from '@lostgradient/bureau';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { AUTHORIZATION_SCOPES, principalFromApiKey } from '@lostgradient/weft';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  BARRIER_AGENT_NAME,
  BARRIER_FIRST_REPLY,
  createBarrier,
  createBarrierAgents,
} from '../../tests/e2e/barrier-agent.ts';
import { request, requestBytes, stream } from './cli-client-transport.ts';
import { executeCli, parseCliArguments } from './cli-client.ts';
import { enableDemoPlugin } from './demo-plugin-home.ts';
import { startHost, type Host, type HostOptions } from './host.ts';

const endpoint = 'https://management.example.test';
const tlsKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCooh2RVeKQwjKd
py01LuZ+4FcacDIMEjO8SBh+bG0fZbN/LasD/PAHmKIz7mihT6+sSeHRdGMbmkqq
iP0Fz/+dbJy8iPNCAIcNRXfaOrYWZXbhFkhySn3gtvC8Qmzqz2Dh3R0n9cwH2/Gs
0Z4WTqmH5cUZTguJAIxuQ9HcAUCTrcMgkRjsxyxubSSkv5/VnRcH1asNOaS6Xh4K
6tfuUS7gtnW+8/vn1Sbz6ov88Wz7IB1zSQd2eXVZp/Egt+Vawzn1Uto+BEVMwk9+
eb45vvXC6s5O/BQ4gnXc4eUdf4KOdflSpg8ONZrJc9bY+OF7rGAR17ROUKIc2GJh
Irs+LQI/AgMBAAECggEAKktGqS3mPjJGqZ3FS+Jwcv/nOL1NABQMn7thUUv2bnp+
c3ZLvxtQREd23xl7aoHm6Io7NeI//StMcMsc0rlhPeWAxhR/Fl21gZGbxsMU6jcW
gsuo7ela+uJHLKBoWtgaT2u6pUwTmSED0zlbsfKWuHvbXEZjxD+7+OfPmaNCxAbX
e9ybyahfQXV0hY4qWqTbr3q8fvbUbrkCvb3V01Jb7+I2GDR81aO+LrWNTKbD0oqx
OAGjbKIon9d+nMxZjcmmFdcVQKpx1rHqAgTkMpZlIv+eZheNAGE23DwztbhqHGSC
X9VmHDGx/yfo3IEcx0+/vtWG+YOBm35mNaFqfGELSQKBgQDUHc6Oy2c0XHrhyKWf
KXu3bwmsgUsCRIRfu3whqcStWacCmC4ct2pOg7ifqti/s7pkeJaOOGYbQXK/+vw2
xWBE6LFUseAo1fQ22ORrIuL4/awW5URgLp1wAN4op4MaVUPC10Qf+wKO2FMRImlS
T18GcMVkl5lGBS6mwi9q2VX8gwKBgQDLhVYJYu0LlnWuGz72bWB+AkL4HnP+b3lA
XLlmJkTX1pz6CWfc4dGgCRhdc5itYhWQUZMZgEYy9J4wYTKWtJxKFEKH1z8gE0GG
PxabKUJhFJn6P4bYIEmdmI9ZEJvc2WMS829sIUQs/loyFyesEqx2orfbYuLblhUD
9uv2BICulQKBgGIx5kSejwljYpORcnKrHpW9dooAVLwZAfrbbUycLeteHH2L+5TZ
qAHu4pIv4iVky33lgTUXkNU/SCLtysKEPtvHqQgfTDk7StH1OFEMlmxT6s2ylyO7
kLCgBjhly8BuBm91fhkb94QvSs0c1AsBqWju3cKCl7cdgQo7zP223SKHAoGAHEsq
Hd3x5HWDYLQK+clU68+2rbXWHF409hyt7aSOV49PfXdHSC7grKX3DC7g3+HN66Vb
lOT/XWAiiclJdigfvjC42xeyf+wNZPNqWiHPR53Mljy0q2E5ur4V16T2diqGmoDb
UaYCS1sFAQe1DTf/X/LZKpfBwBNKUqXGQgp4NU0CgYAH5Zs2pXlVMs4mf02cC7iH
0Prp6W7zGM0CUOxscl4gSHgThF03L4gnIUZ8o5LZHU/a1Y4OjlPIaO9SRE4tXbed
J36snAtKo/Cv4AldWSZSGelUky9WaGkRBvP1XIp0nR7VpRy7x5KaXZ7UAbwlCzpz
Y4RgXXPeLZLVZ9iEx0fAgw==
-----END PRIVATE KEY-----`;
const tlsCertificate = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUQS97fImX3AHkOcxr7TJeHIqfNm4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEwNjEwMTQzNVoXDTM2MTEw
MzEwMTQzNVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqKIdkVXikMIynactNS7mfuBXGnAyDBIzvEgYfmxtH2Wz
fy2rA/zwB5iiM+5ooU+vrEnh0XRjG5pKqoj9Bc//nWycvIjzQgCHDUV32jq2FmV2
4RZIckp94LbwvEJs6s9g4d0dJ/XMB9vxrNGeFk6ph+XFGU4LiQCMbkPR3AFAk63D
IJEY7Mcsbm0kpL+f1Z0XB9WrDTmkul4eCurX7lEu4LZ1vvP759Um8+qL/PFs+yAd
c0kHdnl1WafxILflWsM59VLaPgRFTMJPfnm+Ob71wurOTvwUOIJ13OHlHX+CjnX5
UqYPDjWayXPW2Pjhe6xgEde0TlCiHNhiYSK7Pi0CPwIDAQABo2kwZzAdBgNVHQ4E
FgQUlcMDEE9lq/ZT9cDrm/husE7ge08wHwYDVR0jBBgwFoAUlcMDEE9lq/ZT9cDr
m/husE7ge08wDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBADU4x2SI5/ydADyv9wSsnah1W1t8UJMFkqIQyQph
nnu82VIr9KOdvvHA/5gxa9D5Ee7NFIyk8gPbXbtiH2534xA6Rn4lv64qb3Yrc43l
kDSW6gRp+zYLFj/EySY2p9lzgGhf1U6RKvk5kSw8VVejWnF5eX06qlYDSq08tsXe
NeR2K3qzirdLQoJ8h1CQCLw8YbUYW4a3yTWBC8q55KW/xEWbQDu3ZMrlpfBTElog
aBEufpxyIflhDu0O1EB7dRn2+NfOwXKMuVvNK+nWd1EIINCyBHxbvGGCofbEInwT
x9YXoFbmLBQyK6PqjLUtKlNIWWpFjSNysS1UIdsioO7phBs=
-----END CERTIFICATE-----`;
const hosts: Host[] = [];
const homes: string[] = [];
const tlsServers: Array<{ stop(): void }> = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of tlsServers.splice(0)) server.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function authenticatedHost(
  removed: () => boolean,
  options: Pick<HostOptions, 'extraAgents'> = {},
): Promise<Host> {
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
    ...options,
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
        resolveOwnerMembership: async (owner) => {
          if (removed()) return null;
          const subject = owner.replace(/^api-key:/, '').replace(/^owner-/, '');
          if (!['alice', 'bob', 'administrator'].includes(subject)) return null;
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
      },
    },
  });
  hosts.push(host);
  return host;
}

async function authenticatedHttpsFixture(host: Host) {
  const server = Bun.serve({
    port: 0,
    tls: { key: tlsKey, cert: tlsCertificate },
    fetch: async (request) => {
      const target = new URL(request.url);
      target.protocol = host.url.protocol;
      target.hostname = host.url.hostname;
      target.port = host.url.port;
      const headers = new Headers(request.headers);
      headers.set('host', target.host);
      return fetch(target, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: await request.arrayBuffer() }),
      });
    },
  });
  tlsServers.push(server);
  const url = new URL(server.url);
  const fetcher = (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, tls: { ca: tlsCertificate } });
  return { url, fetch: fetcher };
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

  // spawn-free: executeCli invokes the in-process client; the TLS fixture is a Bun listener.
  test('performs certificate validation on the real HTTPS management request', async () => {
    const host = await authenticatedHost(() => false);
    const https = await authenticatedHttpsFixture(host);
    const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-tls-'));
    homes.push(directory);
    const preferencesPath = join(directory, 'preferences.json');
    const connection = [
      'connection',
      'add',
      'tls',
      '--url',
      https.url.toString(),
      '--credential-reference',
      'TOKEN',
    ];
    const dependencies = { preferencesPath, environment: { TOKEN: 'alice' } };
    const added = await executeCli(connection, dependencies);
    expect(added.exitCode).toBe(0);
    const untrusted = await executeCli(['whoami', '--connection', 'tls'], dependencies);
    expect(untrusted.exitCode).toBe(1);
    expect(untrusted.stderr).toContain('certificate');
    const wrongHost = new URL(https.url);
    wrongHost.hostname = '127.0.0.1';
    const wrong = await executeCli(
      ['whoami', '--connection', 'tls', '--url', wrongHost.toString()],
      {
        ...dependencies,
        fetch: https.fetch,
      },
    );
    expect(wrong.exitCode).toBe(1);
    const trusted = await executeCli(['whoami', '--connection', 'tls'], {
      ...dependencies,
      fetch: https.fetch,
    });
    expect(trusted.exitCode).toBe(0);
    expect(JSON.parse(trusted.stdout)).toMatchObject({
      actor: 'alice',
      workspace: host.workspaceId,
    });
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
    const firstHttps = await authenticatedHttpsFixture(first);
    const secondHttps = await authenticatedHttpsFixture(second);
    const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-preferences-'));
    homes.push(directory);
    const preferencesPath = join(directory, 'preferences.json');
    const dependencies = {
      preferencesPath,
      environment: { ALICE: 'alice', BOB: 'bob', ADMIN: 'administrator' },
      fetch: firstHttps.fetch,
    };
    await executeCli(
      [
        'connection',
        'add',
        'first',
        '--url',
        firstHttps.url.toString(),
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
        secondHttps.url.toString(),
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
      { ...dependencies, fetch: secondHttps.fetch },
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
        'demo:assistant',
        '--content',
        'alice-private-memory',
        '--connection',
        'first',
      ],
      dependencies,
    );
    expect(privateMemory.exitCode).toBe(0);
    expect(privateMemory.stdout).toContain('alice-private-memory');
    await executeCli(
      [
        'connection',
        'add',
        'bob-first',
        '--url',
        firstHttps.url.toString(),
        '--credential-reference',
        'BOB',
      ],
      dependencies,
    );
    const bobPrivateMemory = await executeCli(
      [
        'memory',
        'search',
        '--agent',
        'demo:assistant',
        '--query',
        'private',
        '--connection',
        'bob-first',
      ],
      dependencies,
    );
    expect(bobPrivateMemory.exitCode).toBe(0);
    expect(bobPrivateMemory.stdout).not.toContain('alice-private-memory');
    const administratorMutation = await executeCli(
      ['restart', '--connection', 'bob-first', '--yes'],
      dependencies,
    );
    expect(administratorMutation.exitCode).toBe(3);
    expect(administratorMutation.stderr).toBe('Trusted deployment operation required');
    const forbiddenMutation = await dependencies.fetch(
      new URL('/host/providers/reload', firstHttps.url),
      { method: 'POST', headers: { 'x-api-key': 'bob' } },
    );
    expect(forbiddenMutation.status).toBe(403);
    expect(await forbiddenMutation.text()).toBe('Workspace administration required');

    revoked = true;
    const afterRemoval = await executeCli(
      ['memory', 'search', '--agent', 'missing', '--query', 'private', '--connection', 'first'],
      dependencies,
    );
    expect(afterRemoval.exitCode).toBe(3);
    expect(afterRemoval.stderr).toBe('Workspace membership required');
    const mismatch = await executeCli(
      ['whoami', '--connection', 'first', '--workspace', second.workspaceId],
      dependencies,
    );
    expect(mismatch.exitCode).toBe(3);
    expect(mismatch.stderr).toBe('Workspace membership required');
  });

  // spawn-free: executeCli uses the injected in-process client and does not spawn a child.
  test('credential diagnostics preserve status while redacting active credentials', async () => {
    const fixture = await remoteFixture();
    await executeCli(
      ['connection', 'add', 'remote', '--url', endpoint, '--credential-reference', 'TOKEN'],
      fixture,
    );
    const raw = await executeCli(['status', '--connection', 'remote'], {
      ...fixture,
      environment: { TOKEN: 'alice-secret' },
      fetch: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        if (path === '/api/v1/principal') return fixture.fetch(input, init);
        return new Response('reflected x-api-key=alice-secret', { status: 401 });
      },
    });
    expect(raw.exitCode).toBe(3);
    expect(raw.stderr).toBe('reflected x-api-key=[redacted]');
    expect(raw.stderr).not.toContain('alice-secret');
    const json = await executeCli(['status', '--connection', 'remote'], {
      ...fixture,
      environment: { TOKEN: 'alice-secret' },
      fetch: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        if (path === '/api/v1/principal') return fixture.fetch(input, init);
        return Response.json({ message: 'reflected x-api-key=alice-secret' }, { status: 401 });
      },
    });
    expect(json.exitCode).toBe(3);
    expect(json.stderr).toBe('reflected x-api-key=[redacted]');
    expect(json.stderr).not.toContain('alice-secret');
    const streamed = await executeCli(
      ['chat', '--agent', 'demo', '--message', 'hello', '--connection', 'remote'],
      {
        ...fixture,
        environment: { TOKEN: 'alice-secret' },
        fetch: async (input, init) => {
          if (
            new URL(input instanceof Request ? input.url : input).pathname === '/api/v1/principal'
          )
            return fixture.fetch(input, init);
          return Response.json({ message: 'reflected x-api-key=alice-secret' }, { status: 401 });
        },
      },
    );
    expect(streamed.exitCode).toBe(3);
    expect(streamed.stderr).toBe('reflected x-api-key=[redacted]');
    expect(streamed.stderr).not.toContain('alice-secret');

    await executeCli(
      [
        'connection',
        'add',
        'local',
        '--url',
        'http://127.0.0.1:43123',
        '--credential-reference',
        'TOKEN',
      ],
      fixture,
    );
    const localRaw = await executeCli(['status', '--connection', 'local'], {
      ...fixture,
      environment: { TOKEN: 'alice-secret' },
      fetch: async () => new Response('reflected alice-secret', { status: 401 }),
    });
    expect(localRaw.exitCode).toBe(3);
    expect(localRaw.stderr).toBe('reflected [redacted]');
    expect(localRaw.stderr).not.toContain('alice-secret');
    const localJson = await executeCli(['status', '--connection', 'local'], {
      ...fixture,
      environment: { TOKEN: 'alice-secret' },
      fetch: async () => Response.json({ message: 'reflected alice-secret' }, { status: 401 }),
    });
    expect(localJson.exitCode).toBe(3);
    expect(localJson.stderr).toBe('reflected [redacted]');
    expect(localJson.stderr).not.toContain('alice-secret');
  });

  // spawn-free: executeCli uses the injected in-process client and does not spawn a child.
  test('private chat ownership is enforced by the real host for CLI context reads', async () => {
    const host = await authenticatedHost(() => false);
    const https = await authenticatedHttpsFixture(host);
    const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-chat-'));
    homes.push(directory);
    const preferencesPath = join(directory, 'preferences.json');
    const base = { preferencesPath, environment: { ALICE: 'alice', BOB: 'bob' } };
    await executeCli(
      [
        'connection',
        'add',
        'alice',
        '--url',
        https.url.toString(),
        '--credential-reference',
        'ALICE',
      ],
      base,
    );
    await executeCli(
      ['connection', 'add', 'bob', '--url', https.url.toString(), '--credential-reference', 'BOB'],
      base,
    );
    const created = await host.bureau.tasks.start('demo:assistant', 'alice-private-chat secret', {
      principal: 'owner-alice',
    });
    await created.result();
    const aliceList = await executeCli(['chats', 'list', '--connection', 'alice'], {
      ...base,
      fetch: https.fetch,
    });
    expect(aliceList.exitCode).toBe(0);
    expect(aliceList.stdout).toContain('alice-private-chat secret');
    const bobList = await executeCli(['chats', 'list', '--connection', 'bob'], {
      ...base,
      fetch: https.fetch,
    });
    expect(bobList.exitCode).toBe(0);
    expect(bobList.stdout).not.toContain('alice-private-chat secret');
  });

  // spawn-free: executeCli uses the injected in-process client and does not spawn a child.
  test('admitted CLI watch is revoked before the next private frame and action', async () => {
    let revoked = false;
    const barrier = createBarrier();
    const host = await authenticatedHost(() => revoked, {
      extraAgents: { agents: createBarrierAgents(barrier) },
    });
    const https = await authenticatedHttpsFixture(host);
    const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-watch-'));
    homes.push(directory);
    const preferencesPath = join(directory, 'preferences.json');
    const base = { preferencesPath, environment: { ALICE: 'alice' } };
    await executeCli(
      [
        'connection',
        'add',
        'alice',
        '--url',
        https.url.toString(),
        '--credential-reference',
        'ALICE',
      ],
      base,
    );
    const controlRun = await host.bureau.tasks.start(BARRIER_AGENT_NAME, 'control sentinel', {
      principal: 'owner-alice',
    });
    await waitUntil(() => barrier.waiting() === 1, { message: 'the control barrier admission' });
    const controlAdmitted = Promise.withResolvers<void>();
    const controlChunks: string[] = [];
    const controlFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await https.fetch(input, init);
      if (
        (input instanceof Request ? new URL(input.url) : new URL(input)).pathname.includes(
          '/v1/subscriptions/',
        )
      )
        controlAdmitted.resolve();
      return response;
    };
    const controlWatch = executeCli(
      [
        'runs',
        'watch',
        '--kind',
        'task',
        controlRun.id,
        '--connection',
        'alice',
        '--output',
        'jsonl',
      ],
      { ...base, fetch: controlFetch, writeStdout: (chunk) => controlChunks.push(chunk) },
    );
    await controlAdmitted.promise;
    barrier.release();
    const controlResult = await controlWatch;
    expect(controlResult.exitCode).toBe(0);
    expect(controlChunks.join('')).toContain(BARRIER_FIRST_REPLY);

    const revokedRun = await host.bureau.tasks.start(BARRIER_AGENT_NAME, 'private sentinel', {
      principal: 'owner-alice',
    });
    await waitUntil(() => barrier.waiting() === 1, { message: 'the revoked barrier admission' });
    const revokedAdmitted = Promise.withResolvers<void>();
    const revokedSnapshot = Promise.withResolvers<void>();
    const revokedChunks: string[] = [];
    const revokedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await https.fetch(input, init);
      if (
        (input instanceof Request ? new URL(input.url) : new URL(input)).pathname.includes(
          '/v1/subscriptions/',
        )
      )
        revokedAdmitted.resolve();
      return response;
    };
    const watched = executeCli(
      [
        'runs',
        'watch',
        '--kind',
        'task',
        revokedRun.id,
        '--connection',
        'alice',
        '--output',
        'jsonl',
      ],
      {
        ...base,
        fetch: revokedFetch,
        writeStdout: (chunk) => {
          revokedChunks.push(chunk);
          if (chunk.includes('task.snapshot')) revokedSnapshot.resolve();
        },
      },
    );
    await revokedAdmitted.promise;
    await revokedSnapshot.promise;
    const snapshotChunkCount = revokedChunks.length;
    revoked = true;
    barrier.release();
    const watchedResult = await watched;
    expect(watchedResult.exitCode).toBe(1);
    expect(watchedResult.stderr).toContain('Run event stream ended before a terminal event');
    const afterRevocation = revokedChunks.slice(snapshotChunkCount).join('');
    expect(afterRevocation).not.toContain(BARRIER_FIRST_REPLY);
    expect(afterRevocation).not.toContain('private sentinel');
    const denied = await executeCli(['chats', 'list', '--connection', 'alice'], {
      ...base,
      fetch: https.fetch,
    });
    expect(denied.exitCode).toBe(3);
    expect(denied.stderr).toBe('Workspace membership required');
  });

  // spawn-free: executeCli uses the injected in-process client and does not spawn a child.
  test('connection switching gives each CLI watch a distinct server stream', async () => {
    const first = await authenticatedHost(() => false);
    const second = await authenticatedHost(() => false);
    const firstHttps = await authenticatedHttpsFixture(first);
    const secondHttps = await authenticatedHttpsFixture(second);
    const firstRun = await first.bureau.tasks.start('demo:echo', 'workspace-a-frame', {
      principal: 'owner-alice',
    });
    const secondRun = await second.bureau.tasks.start('demo:echo', 'workspace-b-frame', {
      principal: 'owner-alice',
    });
    const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-authority-switch-'));
    homes.push(directory);
    const preferencesPath = join(directory, 'preferences.json');
    const base = { preferencesPath, environment: { ALICE: 'alice' } };
    await executeCli(
      [
        'connection',
        'add',
        'first',
        '--url',
        firstHttps.url.toString(),
        '--credential-reference',
        'ALICE',
      ],
      base,
    );
    await executeCli(
      [
        'connection',
        'add',
        'second',
        '--url',
        secondHttps.url.toString(),
        '--credential-reference',
        'ALICE',
      ],
      base,
    );
    const firstWatch = await executeCli(
      ['runs', 'watch', '--kind', 'task', firstRun.id, '--connection', 'first', '--output', 'json'],
      { ...base, fetch: firstHttps.fetch },
    );
    const secondWatch = await executeCli(
      [
        'runs',
        'watch',
        '--kind',
        'task',
        secondRun.id,
        '--connection',
        'second',
        '--output',
        'json',
      ],
      { ...base, fetch: secondHttps.fetch },
    );
    expect(firstWatch.exitCode).toBe(0);
    expect(secondWatch.exitCode).toBe(0);
    expect(firstWatch.stdout).toContain(firstRun.id);
    expect(firstWatch.stdout).not.toContain(secondRun.id);
    expect(secondWatch.stdout).toContain(secondRun.id);
    expect(secondWatch.stdout).not.toContain(firstRun.id);
  });

  // spawn-free: direct transport calls use injected dependencies and do not spawn a child.
  test('credential-bearing asset, stream, and A2A paths fail before fetch', async () => {
    const parsedResult = parseCliArguments(['status']);
    if ('exitCode' in parsedResult) throw new Error('status parser fixture unexpectedly failed');
    const target = {
      url: endpoint,
      headers: { 'x-api-key': 'alice-secret' },
      remote: true,
    } as const;
    let calls = 0;
    const dependencies = {
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    };
    expect(
      await rejectionOf(
        requestBytes(target, '/bureau/assets/asset/content', parsedResult, dependencies),
      ),
    ).toMatchObject({ exitCode: 3 });
    expect(
      await rejectionOf(stream(target, '/bureau/a2a/demo', parsedResult, dependencies)),
    ).toMatchObject({ exitCode: 3 });
    expect(
      await rejectionOf(request(target, '/jsonrpc', parsedResult, dependencies)),
    ).toMatchObject({
      exitCode: 3,
    });
    expect(calls).toBe(0);
  });
});
