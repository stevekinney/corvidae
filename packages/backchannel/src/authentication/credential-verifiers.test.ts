import { expect, it } from 'bun:test';

import {
  createApiKeyVerifier,
  createAuthenticator,
  createJwtVerifier,
  createMutualTlsVerifier,
  createRotatingApiKeyStore,
  principalFromApiKey,
  type AuthAuditEvent,
  type CredentialVerifier,
} from '../index.ts';

it('tries a fourth verifier in order and names it in the admission audit', async () => {
  const audit: AuthAuditEvent[] = [];
  const testVerifier: CredentialVerifier = {
    method: 'test-header',
    verify(request, { explicitCredentialAttempted }) {
      if (request.headers.get('x-test-identity') !== 'local-test-identity')
        return { kind: 'absent' };
      expect(explicitCredentialAttempted).toBe(true);
      return {
        kind: 'admit',
        authentication: {
          method: 'api-key',
          principal: principalFromApiKey({ subject: 'test-user', scopes: [] }),
        },
      };
    },
  };
  const authenticate = await createAuthenticator({
    verifiers: [
      await createApiKeyVerifier({ apiKeys: ['known-test-key'] }),
      await createJwtVerifier({ secret: 'test-signing-key' }),
      createMutualTlsVerifier({ verifyClientCertificate: () => true }),
      testVerifier,
    ],
    auditSink: (event) => {
      audit.push(event);
    },
  });
  const baseUrl = 'https://probe.test/jsonrpc';
  expect(
    await authenticate(
      new Request(baseUrl, {
        headers: { Authorization: 'Bearer unrecognized-test-credential' },
      }),
    ),
  ).toEqual({ authenticated: false, error: 'No valid credentials provided' });

  const admitted = await authenticate(
    new Request(baseUrl, {
      headers: {
        Authorization: 'Bearer unrecognized-test-credential',
        'x-test-identity': 'local-test-identity',
      },
    }),
  );
  expect(admitted).toMatchObject({ authenticated: true, principal: { subject: 'test-user' } });
  expect(audit.at(-1)).toMatchObject({
    outcome: 'success',
    method: 'test-header',
    subject: 'test-user',
  });
});

it('counts key registrations after pending additions and revocations', async () => {
  const store = createRotatingApiKeyStore();
  const add = store.add('test-key', { subject: 'test-user' });
  const afterAdd = store.count();
  const revoke = store.revoke('test-key');
  const afterRevoke = store.count();
  expect(await Promise.all([add, afterAdd, revoke, afterRevoke])).toEqual([undefined, 1, true, 0]);
});
