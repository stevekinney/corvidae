import { principalFromApiKey, type Principal } from '@lostgradient/backchannel';
import { expect, test } from 'bun:test';
import { createPanelReviewEligibility } from './panel-review-eligibility.ts';

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
      trusted && identity.method !== 'unauthenticated' && identity.subject === 'person',
    isProtected: (current) => current.protected,
    verified: async () => provenanceValid,
    mayDecide: async () => policyAllows,
  });
  expect(await eligibility(request, 'id', 2, 'read')).toBe('authorized');
  expect(await eligibility(request, 'id', 1, 'read')).toBe('denied');
  // The commit operation, rather than a preflight read, atomically fences a stale round.
  expect(await eligibility(request, 'id', 1, 'resolve')).toBe('authorized');
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
