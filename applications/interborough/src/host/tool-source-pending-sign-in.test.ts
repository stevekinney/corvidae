/**
 * COR-2436, owner decision 3: an OAuth sign-in for a tool source that is not saved yet. The host
 * generates the `state`, keeps the sign-in in memory for the administrator who started it, settles
 * it from one callback bound to that state (a second, a forged, a stale, or a refused one never
 * yields tokens), answers its outcome to its owner alone, and lets one save take its tokens by
 * reference; a retry of that save takes it again, any other save is refused. Nothing is written
 * before the save, and no token reaches an answer.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { createHostMutationContext } from './host-mutation-context.ts';
import {
  createToolSourceManager,
  ToolSourceInputError,
  type ToolSourceManager,
} from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import { startOAuthMcpServer, type OAuthMcpServer } from './tool-source-servers.test-support.ts';
import { localWorkspaceMembership } from './workspace-principal.ts';

const ORIGIN = 'http://127.0.0.1:7234';
const OWNER = 'anonymous:local';

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function fixture() {
  const server: OAuthMcpServer = await startOAuthMcpServer();
  closers.push(() => server.stop());
  const home = memoryHome();
  let time = Date.parse('2026-11-17T10:00:00.000Z');
  const keys = await keysOf();
  const managerOf = () => {
    const manager = createToolSourceManager({
      bungalow: home.bungalow,
      keys,
      audit: async () => {},
      origin: () => ORIGIN,
      now: () => time,
    });
    closers.push(() => manager.close());
    return manager;
  };
  const source = {
    id: 'notes',
    kind: 'mcp',
    transport: { type: 'http', url: `${server.origin}/`, authentication: { type: 'oauth' } },
  } as const;
  return {
    server,
    home,
    source,
    manager: managerOf(),
    managerOf,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

/** A mutation as the routes make one, for `owner`. */
async function mutationFor(owner = OWNER, operationId: string = crypto.randomUUID()) {
  const member =
    await localWorkspaceMembership('fixture-workspace').resolveOwnerMembership?.(OWNER);
  if (member == null) throw new Error('Missing local fixture member');
  const identity = owner === OWNER ? member : { ...member, owner, actorId: owner };
  return createHostMutationContext(
    identity,
    { operationId, expectedRevision: null },
    async () => identity,
  );
}

async function begin(manager: ToolSourceManager, source: Record<string, unknown>) {
  const started = await manager.beginSignIn(
    { id: 'notes', source, principal: OWNER, openerOrigin: 'http://127.0.0.1:5173' },
    await mutationFor(),
  );
  if (started.authorized) throw new Error('expected a sign-in to start');
  return started;
}

/** The callback the provider sends the browser back to, after the person approves. */
async function approve(authorizationUrl: string): Promise<string> {
  const redirect = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = redirect.headers.get('location');
  if (location === null) throw new Error('expected the provider to redirect back');
  return location;
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('starting a sign-in for a source that is not saved', () => {
  test('answers the provider address with the state the host generated, and writes nothing', async () => {
    const { manager, source, home } = await fixture();
    const started = await begin(manager, source);

    const state = new URL(started.authorizationUrl).searchParams.get('state');
    expect(state?.length).toBeGreaterThanOrEqual(43);
    expect(started.signIn).not.toBe(state);
    expect(home.state.configuration).toBeUndefined();
    expect(home.state.secrets.size).toBe(0);
  });

  test('is refused for an origin that is not one, and for a source already saved', async () => {
    const { manager, source } = await fixture();
    const badOrigin = await failureOf(
      manager.beginSignIn(
        { id: 'notes', source, principal: OWNER, openerOrigin: 'http://evil.example/path' },
        await mutationFor(),
      ),
    );
    expect((badOrigin as ToolSourceInputError).field).toBe('origin');
  });
});

describe('the callback of a sign-in', () => {
  test('settles it once, for the opener’s origin, with no token in the answer', async () => {
    const { manager, source, server } = await fixture();
    const started = await begin(manager, source);
    const callback = await approve(started.authorizationUrl);

    const settled = await manager.completePendingSignIn('notes', callback);
    expect(settled).toEqual({
      signIn: started.signIn,
      outcome: 'succeeded',
      openerOrigin: 'http://127.0.0.1:5173',
    });
    for (const token of server.issuedAccessTokens) {
      expect(JSON.stringify(settled)).not.toContain(token);
    }
    // A second callback with the same state is refused and changes nothing.
    const again = await manager.completePendingSignIn('notes', callback);
    expect(again).toMatchObject({ outcome: 'refused', reason: 'used' });
    expect(server.issuedAccessTokens).toHaveLength(1);
  });

  test('two callbacks at once: one exchanges, the other is refused as used', async () => {
    const { manager, source, server } = await fixture();
    const started = await begin(manager, source);
    const callback = await approve(started.authorizationUrl);

    const [first, second] = await Promise.all([
      manager.completePendingSignIn('notes', callback),
      manager.completePendingSignIn('notes', callback),
    ]);

    expect(first?.outcome).toBe('succeeded');
    expect(second).toMatchObject({ outcome: 'refused', reason: 'used' });
    expect(server.issuedAccessTokens).toHaveLength(1);
  });

  test('does not take a callback whose state the host did not generate', async () => {
    const { manager, source } = await fixture();
    const started = await begin(manager, source);
    const forged = new URL(await approve(started.authorizationUrl));
    forged.searchParams.set('state', 'incorrect');
    expect(await manager.completePendingSignIn('notes', forged.href)).toBeUndefined();
    expect(
      await manager.completePendingSignIn('other', await approve(started.authorizationUrl)),
    ).toBeUndefined();
  });

  test('reads a refusal into its closed set, and never the provider’s words', async () => {
    const { manager, source } = await fixture();
    const denied = await begin(manager, source);
    const deniedState = new URL(denied.authorizationUrl).searchParams.get('state') ?? '';
    const canceled = await manager.completePendingSignIn(
      'notes',
      `${ORIGIN}/host/oauth/callback/notes?state=${deniedState}&error=access_denied`,
    );
    expect(canceled).toMatchObject({ outcome: 'canceled', reason: 'denied' });

    const refused = await begin(manager, source);
    const refusedState = new URL(refused.authorizationUrl).searchParams.get('state') ?? '';
    const answer = await manager.completePendingSignIn(
      'notes',
      `${ORIGIN}/host/oauth/callback/notes?state=${refusedState}&error=invalid_request&error_description=PROVIDER-WORDS`,
    );
    expect(answer).toMatchObject({ outcome: 'refused', reason: 'invalid_request' });
    expect(JSON.stringify(answer)).not.toContain('PROVIDER-WORDS');
  });

  test('is refused once the sign-in window has passed', async () => {
    const { manager, source, advance, server } = await fixture();
    const started = await begin(manager, source);
    const callback = await approve(started.authorizationUrl);
    advance(10 * 60_000 + 1);
    expect(await manager.completePendingSignIn('notes', callback)).toMatchObject({
      outcome: 'expired',
    });
    expect(server.issuedAccessTokens).toEqual([]);
  });
});

describe('the callback page', () => {
  test('posts the outcome to the opener’s origin only, allows only its own script, and holds no token or code', async () => {
    const { manager, source, server } = await fixture();
    const routes = toolSourceRoutes(manager, () => undefined, {
      mutation: async () => mutationFor(),
    });
    const start = await routes['/host/tool-source-sign-ins'].POST(
      new Request(`${ORIGIN}/host/tool-source-sign-ins`, {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ id: 'notes', source }),
      }),
    );
    const started = (await start.json()) as { signIn: string; authorizationUrl: string };
    const callback = await approve(started.authorizationUrl);
    const code = new URL(callback).searchParams.get('code') ?? '';

    const page = await routes['/host/oauth/callback/:id'].GET(
      Object.assign(new Request(callback), { params: { id: 'notes' } }) as never,
    );
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain('"http://127.0.0.1:5173"');
    expect(html).not.toContain('"*"');
    expect(html).toContain(`"signIn":"${started.signIn}"`);
    expect(html).toContain('"outcome":"succeeded"');
    expect(html).not.toContain(code);
    for (const token of server.issuedAccessTokens) expect(html).not.toContain(token);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'sha256-/);
    expect(page.headers.get('cache-control')).toBe('no-store');
  });

  test('a start with no origin of its own is refused', async () => {
    const { manager, source } = await fixture();
    const routes = toolSourceRoutes(manager, () => undefined, {
      mutation: async () => mutationFor(),
    });
    const start = await routes['/host/tool-source-sign-ins'].POST(
      new Request(`${ORIGIN}/host/tool-source-sign-ins`, {
        method: 'POST',
        body: JSON.stringify({ id: 'notes', source }),
      }),
    );
    expect(start.status).toBe(400);
  });
});

describe('the outcome of a sign-in', () => {
  test('is read by its owner, and anyone else reads none', async () => {
    const { manager, source } = await fixture();
    const started = await begin(manager, source);
    expect(await manager.pendingSignIn(started.signIn, await mutationFor())).toEqual({
      signIn: started.signIn,
      outcome: 'waiting',
    });
    const other = await failureOf(
      manager.pendingSignIn(started.signIn, await mutationFor('someone-else')),
    );
    expect(other).toBeInstanceOf(ToolSourceInputError);
    expect((other as ToolSourceInputError).kind).toBe('unknown-source');
  });
});

describe('saving a source with a sign-in', () => {
  test('takes the tokens by reference, once, and loads with them after a restart and a refresh', async () => {
    const { manager, managerOf, source, server, home } = await fixture();
    const started = await begin(manager, source);
    await manager.completePendingSignIn('notes', await approve(started.authorizationUrl));

    // Test connection lists the tools with the sign-in, and keeps nothing.
    const probe = await manager.probe(
      { id: 'notes', source, principal: OWNER, signIn: started.signIn },
      await mutationFor(),
    );
    expect(probe).toMatchObject({
      outcome: 'listed',
      tools: [expect.objectContaining({ tool: 'echo' })],
    });

    // Someone else cannot take it.
    const stolen = await failureOf(
      manager.connect(
        {
          id: 'notes',
          source,
          principal: 'someone-else',
          signIn: started.signIn,
          createOnly: true,
        },
        await mutationFor('someone-else'),
      ),
    );
    expect((stolen as ToolSourceInputError).field).toBe('signIn');

    const operationId = crypto.randomUUID();
    const saved = await manager.connect(
      { id: 'notes', source, principal: OWNER, signIn: started.signIn, createOnly: true },
      await mutationFor(OWNER, operationId),
    );
    expect(saved.changed).toBe(true);
    expect(home.state.configuration).toContain('"notes"');

    // A retry of that same save takes it again; any other save is refused.
    const retried = await manager.connect(
      { id: 'notes', source, principal: OWNER, signIn: started.signIn, createOnly: true },
      await mutationFor(OWNER, operationId),
    );
    expect(retried.changed).toBe(false);
    const reused = await failureOf(
      manager.connect(
        { id: 'notes', source, principal: OWNER, signIn: started.signIn },
        await mutationFor(),
      ),
    );
    expect((reused as ToolSourceInputError).field).toBe('signIn');

    // The next start loads it with the tokens the sign-in got, and a refresh works.
    const restarted = managerOf();
    await restarted.start();
    const afterRestart = await restarted.snapshot();
    const [standing] = afterRestart.sources;
    expect(standing?.state).toBe('loaded');
    server.expireAccessTokens();
    expect(await restarted.test('notes', await mutationFor())).toMatchObject({ outcome: 'listed' });
    expect(server.refreshRequests.length).toBeGreaterThan(0);
  });

  test('is refused for a sign-in that did not succeed', async () => {
    const { manager, source } = await fixture();
    const started = await begin(manager, source);
    const refusal = await failureOf(
      manager.connect(
        { id: 'notes', source, principal: OWNER, signIn: started.signIn, createOnly: true },
        await mutationFor(),
      ),
    );
    expect((refusal as ToolSourceInputError).field).toBe('signIn');
  });
});
