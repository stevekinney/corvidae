import {
  principalFromApiKey,
  unauthenticatedLocalAuthContext,
  type Principal,
} from '@lostgradient/backchannel';
import { WEFT_SCOPE_VOCABULARY } from '@lostgradient/weft';
import { expect, test } from 'bun:test';
import {
  createPanelReviewEligibility,
  sharedPanelBrowserCredentials,
} from './panel-review-eligibility.ts';

test('forwards only a verified browser session with its valid write proof', async () => {
  const browser = {
    ...principalFromApiKey({ subject: 'person', scopes: [] }),
    method: 'browser-session' as const,
  };
  const credentials = sharedPanelBrowserCredentials(
    async () => ({ ...unauthenticatedLocalAuthContext(WEFT_SCOPE_VOCABULARY), principal: browser }),
    {
      browser: {
        validWrite: async (request) =>
          request.headers.get('origin') === 'https://app.example' &&
          request.headers.get('x-csrf-token') === 'proof',
      },
      publicRequest: (request) => request,
    },
  );
  if (credentials === undefined) throw new Error('Shared browser credentials must be configured');
  const request = (headers: Record<string, string>) =>
    new Request('https://app.example/', { method: 'POST', headers });
  const headers = {
    host: 'app.example',
    origin: 'https://app.example',
    cookie: 'session=one',
    'x-csrf-token': 'proof',
    'x-actor-id': 'forged',
  };
  const allowed = await credentials(request(headers), 'bureau.reviews.resolve');
  expect(allowed).toBeInstanceOf(Headers);
  expect((allowed as Headers).get('cookie')).toBe('session=one');
  expect((allowed as Headers).get('x-actor-id')).toBeNull();
  expect(
    await credentials(
      request({ host: 'app.example', origin: 'https://app.example', cookie: 'session=one' }),
      'bureau.reviews.resolve',
    ),
  ).toBeInstanceOf(Response);
  expect(
    await credentials(request({ ...headers, 'x-csrf-token': 'wrong' }), 'bureau.reviews.resolve'),
  ).toBeInstanceOf(Response);
  expect(
    await credentials(
      request({ ...headers, origin: 'https://evil.example' }),
      'bureau.reviews.resolve',
    ),
  ).toBeInstanceOf(Response);
  expect(
    await credentials(
      request({ ...headers, authorization: 'Bearer model' }),
      'bureau.reviews.resolve',
    ),
  ).toBeUndefined();
});

test('requires trusted human authority and current policy for a protected panel review', async () => {
  const request = new Request('http://localhost/');
  const membership = {
    version: 1 as const,
    workspaceId: 'workspace',
    actorId: 'person',
    actorKind: 'user' as const,
    owner: 'person',
    membershipRevision: '1',
    capabilities: [],
  };
  const person = {
    ...principalFromApiKey({ subject: 'person', scopes: [] }),
    method: 'browser-session' as const,
    workspace: membership,
  };
  const service = {
    ...principalFromApiKey({ subject: 'service', scopes: [] }),
    workspace: { ...membership, actorKind: 'service' as const },
  };
  let principal: Principal = person;
  let trusted = true;
  let policyAllows = true;
  let provenanceValid = true;
  let review = { kind: 'tool-approval', status: 'pending', round: 2, protected: true };
  const eligibility = createPanelReviewEligibility({
    read: async () => review,
    principal: async () => principal,
    isTrustedHuman: (identity) =>
      trusted && identity.method === 'browser-session' && identity.subject === 'person',
    isProtected: (current) => current.protected,
    verified: async () => provenanceValid,
    mayDecide: async () => policyAllows,
  });
  expect(await eligibility(request, 'id', 2, 'read')).toBe('authorized');
  expect(await eligibility(request, 'id', 1, 'read')).toBe('denied');
  // The commit operation, rather than a preflight read, atomically fences a stale round.
  expect(await eligibility(request, 'id', 1, 'resolve')).toBe('authorized');
  principal = { ...person, method: 'connector-token' };
  expect(await eligibility(request, 'id', 2, 'resolve')).toBe('denied');
  principal = service;
  expect(await eligibility(request, 'id', 2, 'resolve')).toBe('denied');
  principal = person;
  trusted = false;
  expect(await eligibility(request, 'id', 2, 'resolve')).toBe('denied');
  trusted = true;
  policyAllows = false;
  expect(await eligibility(request, 'id', 2, 'resolve')).toBe('denied');
  policyAllows = true;
  provenanceValid = false;
  expect(await eligibility(request, 'id', 2, 'resolve')).toBe('denied');
  review = { ...review, protected: false };
  expect(await eligibility(request, 'id', 2, 'resolve')).toBe('ordinary');
});
