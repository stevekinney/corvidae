import { generateEncryptionKey } from '@lostgradient/cryptography';
import { withOAuthTokenRequestGate, type McpOAuthTokenRequestAdmission } from 'armorer';
import { expect, test } from 'bun:test';
import { memoryHome } from './tool-source-memory-home.test-support.ts';
import {
  createToolSourceOAuthSession,
  parseToolSourceOAuthClaim,
  type ToolSourceOAuthBinding,
} from './tool-source-oauth-session.ts';
import { createToolSourceVault } from './tool-source-vault.ts';

const binding: ToolSourceOAuthBinding = {
  workspaceId: 'fixture-workspace',
  actorId: 'administrator',
  owner: 'owner',
  flowId: 'flow',
};
const request = {
  grantType: 'refresh_token' as const,
  tokenEndpoint: 'https://issuer.example/token',
  credential: 'refresh-one',
};
async function fixture() {
  const home = memoryHome();
  const keys = { current: await generateEncryptionKey() };
  const vault = createToolSourceVault({ bungalow: home.bungalow, keys });
  await vault.write('source', {
    credentials: new Map(),
    oauth: {
      tokens: { access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh-one' },
      state: 'state',
      codeVerifier: 'verifier',
    },
    oauthBinding: binding,
  });
  const session = (authorize = async () => {}) =>
    createToolSourceOAuthSession({
      vault: createToolSourceVault({ bungalow: home.bungalow, keys }),
      sourceId: 'source',
      binding,
      authorize,
    });
  return { home, vault, session };
}
async function admission(
  value: ReturnType<ReturnType<typeof createToolSourceOAuthSession>['beforeTokenRequest']>,
): Promise<McpOAuthTokenRequestAdmission> {
  const receipt = await value;
  if (receipt === undefined) throw new Error('Expected claim receipt');
  return receipt;
}
async function refused(value: PromiseLike<unknown>) {
  const result = await Promise.resolve(value).then(
    () => false,
    () => true,
  );
  expect(result).toBe(true);
}

test('independent hosts permit only one token exchange for the committed refresh credential', async () => {
  const { session } = await fixture();
  let exchanges = 0;
  const clients = [session(), session()].map((client) =>
    withOAuthTokenRequestGate(async () => {
      exchanges += 1;
      return Response.json({ access_token: 'new' });
    }, client.beforeTokenRequest),
  );
  const results = await Promise.allSettled(
    clients.map((client) =>
      client(request.tokenEndpoint, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: request.credential,
        }),
      }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(exchanges).toBe(1);
});

for (const outcome of ['unknown', 'crash'] as const) {
  test(`a ${outcome} exchange cannot be replayed by a replacement host`, async () => {
    const { session, vault } = await fixture();
    const receipt = await admission(session().beforeTokenRequest(request));
    if (outcome === 'unknown') await receipt.settle('unknown');
    await refused(Promise.resolve(session().beforeTokenRequest(request)));
    const current = await vault.read('source');
    expect(current.oauthClaim?.state).toBe(outcome === 'unknown' ? 'unknown' : 'claimed');
  });
}

test('only the same live claimant gets one nonce retry', async () => {
  const { session } = await fixture();
  const claimant = session();
  const first = await admission(claimant.beforeTokenRequest(request));
  await first.settle('nonce-challenge');
  await refused(Promise.resolve(session().beforeTokenRequest(request)));
  const retry = await admission(claimant.beforeTokenRequest(request));
  await retry.settle('nonce-challenge');
  await refused(Promise.resolve(claimant.beforeTokenRequest(request)));
});

test('token publication is claim-fenced and a rotated credential never falls back', async () => {
  const { session, vault } = await fixture();
  const first = session();
  const receipt = await admission(first.beforeTokenRequest(request));
  await receipt.settle('response');
  await first.tokenStorage.save({
    tokens: { access_token: 'new-access', token_type: 'Bearer', refresh_token: 'refresh-two' },
  });
  await refused(Promise.resolve(session().beforeTokenRequest(request)));
  const next = session();
  await admission(next.beforeTokenRequest({ ...request, credential: 'refresh-two' }));
  await refused(
    Promise.resolve(
      first.tokenStorage.save({
        tokens: { access_token: 'stale', token_type: 'Bearer', refresh_token: 'refresh-one' },
      }),
    ),
  );
  const current = await vault.read('source');
  expect(current.oauth?.tokens?.refresh_token).toBe('refresh-two');
  expect(current.oauthClaim?.state).toBe('claimed');
});

test('setup saves cannot overwrite another host claim and old callback cleanup cannot erase a new flow', async () => {
  const { session, vault } = await fixture();
  const stale = session();
  await stale.tokenStorage.load();
  await admission(session().beforeTokenRequest(request));
  await refused(Promise.resolve(stale.tokenStorage.save({ codeVerifier: 'stale-verifier' })));
  const current = await vault.read('source');
  await vault.write('source', {
    ...current,
    oauthBinding: { ...binding, flowId: 'new-flow' },
    oauthClaim: undefined,
    oauth: { state: 'new-state' },
  });
  await refused(Promise.resolve(stale.tokenStorage.clear?.(['state'])));
  const replaced = await vault.read('source');
  expect(replaced.oauth?.state).toBe('new-state');
});

test('revocation during claim publication refuses dispatch and retains its non-replayable claim', async () => {
  const { session, vault } = await fixture();
  let checks = 0;
  let dispatches = 0;
  const client = session(async () => {
    checks += 1;
    if (checks === 4) throw new Error('removed');
  });
  const guarded = withOAuthTokenRequestGate(async () => {
    dispatches += 1;
    return new Response();
  }, client.beforeTokenRequest);
  await refused(
    guarded(request.tokenEndpoint, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: request.credential }),
    }),
  );
  expect(dispatches).toBe(0);
  const current = await vault.read('source');
  expect(current.oauthClaim?.state).toBe('claimed');
});

test('malformed durable claim state is rejected', () => {
  for (const value of [
    {},
    {
      id: 'id',
      grantType: 'refresh_token',
      credentialDigest: 'x'.repeat(64),
      attempt: 0,
      state: 'published',
    },
    {
      id: 'id',
      grantType: 'refresh_token',
      credentialDigest: 'a'.repeat(64),
      attempt: 2,
      state: 'claimed',
    },
  ])
    expect(() => parseToolSourceOAuthClaim(value)).toThrow('Invalid stored OAuth claim');
});
