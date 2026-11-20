import { expect, it } from 'bun:test';

import {
  createAuthenticator,
  createScopeVocabulary,
  principalFromStdioLocal,
  principalFromUnauthenticatedLocal,
} from './index.ts';
import { signJWT } from './internals.ts';

it('uses each host’s vocabulary for credentials and local principals', async () => {
  const inventory = createScopeVocabulary(['inventory:read', 'inventory:write']);
  const reports = createScopeVocabulary(['reports:read']);
  const config = {
    jwt: { secret: 'host-vocabulary-test-secret' },
    auditSink: () => {},
  };
  const [authenticateInventory, authenticateReports] = await Promise.all([
    createAuthenticator(config, {
      scopeVocabulary: inventory,
      additionalScopes: ['probe.inventory:read'],
    }),
    createAuthenticator(config, { scopeVocabulary: reports }),
  ]);
  const token = await signJWT(
    {
      sub: 'test-user',
      scope: 'inventory:read',
      scp: 'probe.inventory:read',
      permissions: ['inventory:write', 'reports:read', 'workflows:admin'],
    },
    config.jwt.secret,
  );
  const request = new Request('https://probe.test/jsonrpc', {
    headers: { authorization: `Bearer ${token}` },
  });
  const a = await authenticateInventory(request);
  const b = await authenticateReports(request);
  expect(a.authenticated && [...(a.principal?.scopes ?? [])]).toEqual([
    'inventory:read',
    'probe.inventory:read',
    'inventory:write',
  ]);
  expect(b.authenticated && [...(b.principal?.scopes ?? [])]).toEqual(['reports:read']);
  expect([...principalFromStdioLocal(inventory).scopes]).toEqual([...inventory.scopes]);
  expect([...principalFromUnauthenticatedLocal(reports).scopes]).toEqual([...reports.scopes]);
  expect([...principalFromUnauthenticatedLocal().scopes]).toEqual([]);
});
