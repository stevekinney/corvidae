import type { WorkspaceMembership } from '@lostgradient/bureau';
import { expect, test } from 'bun:test';
import { createHostMutationContext } from './host-mutation-context.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { createToolSourceOAuthAuthority } from './tool-source-oauth-authority.ts';
import { createToolSourceVault } from './tool-source-vault.ts';

async function fixture() {
  const home = memoryHome('local');
  const vault = createToolSourceVault({ bungalow: home.bungalow, keys: await keysOf() });
  let member: WorkspaceMembership | null = {
    version: 1,
    workspaceId: home.bungalow.workspaceId,
    actorId: 'admin',
    actorKind: 'user',
    owner: 'owner-admin',
    membershipRevision: '1',
    capabilities: ['workspace:use', 'workspace:manage'],
  };
  const identity = member;
  const authority = createToolSourceOAuthAuthority({
    home: home.bungalow,
    vault,
    workspace: {
      workspaceId: identity.workspaceId,
      resolveMembership: async () => member,
      resolveOwnerMembership: async () => member,
    },
  });
  const snapshot = await home.bungalow.readConfiguration();
  const mutation = createHostMutationContext(
    identity,
    { operationId: 'sign-in', expectedRevision: snapshot.revision },
    async () => member ?? undefined,
  );
  return {
    home,
    vault,
    authority,
    mutation,
    revoke: () => {
      member = null;
    },
  };
}

test('injected authority refuses existing unbound credentials', async () => {
  const { vault, authority } = await fixture();
  await vault.write('source', {
    credentials: new Map(),
    oauth: { tokens: { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer' } },
  });
  expect(
    await authority
      .session('source', 'description', async () => true)
      .then(
        () => undefined,
        (error: unknown) => error,
      ),
  ).toMatchObject({
    code: 'forbidden',
  });
});

test('explicit sign-in binds its initiating administrator and checks later refresh authority', async () => {
  const { vault, authority, mutation, revoke } = await fixture();
  const binding = await authority.begin('source', 'description', mutation);
  expect(binding).toMatchObject({
    actorId: mutation.actorId,
    owner: mutation.owner,
    workspaceId: mutation.workspaceId,
  });
  const session = await authority.session(
    'source',
    'description',
    async () => true,
    'take',
    binding,
  );
  await session.tokenStorage.save({ state: 'state', codeVerifier: 'verifier' });
  revoke();
  expect(
    await Promise.resolve()
      .then(() =>
        session.beforeTokenRequest({
          grantType: 'authorization_code',
          credential: 'code',
          tokenEndpoint: 'https://issuer.test/token',
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      ),
  ).toMatchObject({ code: 'forbidden' });
  const persisted = await vault.read('source');
  expect(persisted.oauthClaim).toBeUndefined();
});

test('a repeated sign-in ID observes its flow but cannot change source intent', async () => {
  const { vault, authority, mutation, home } = await fixture();
  const binding = await authority.begin('source', 'description', mutation);
  const session = await authority.session(
    'source',
    'description',
    async () => true,
    'take',
    binding,
  );
  await session.tokenStorage.save({ state: 'kept-state' });
  const snapshot = await home.bungalow.readConfiguration();
  expect(await authority.begin('source', 'description', mutation)).toEqual(binding);
  expect(await home.bungalow.readConfiguration()).toEqual(snapshot);
  const persisted = await vault.read('source');
  expect(persisted.oauth?.state).toBe('kept-state');
  expect(
    await authority.begin('source', 'different-description', mutation).then(
      () => undefined,
      (error: unknown) => error,
    ),
  ).toMatchObject({
    code: 'conflict',
  });
});
