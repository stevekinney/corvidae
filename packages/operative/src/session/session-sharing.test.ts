import { expect, test } from 'bun:test';

import {
  SESSION_READ_GRANTS_METADATA_KEY,
  sessionHasReadGrant,
  sessionReadGrantOf,
  sessionWasReadGrantedTo,
  withSessionReadGrant,
  withSessionReadRevocation,
} from './session-sharing.ts';

const initial = withSessionReadGrant({}, {
  owner: 'workspace-a:bob',
  grantedBy: 'workspace-a:alice',
  grantedAt: '2026-11-23T00:00:00.000Z',
});

test('read grants are explicit and a revocation retains former-reader evidence', () => {
  expect(sessionHasReadGrant(initial, 'workspace-a:bob')).toBe(true);
  const revoked = withSessionReadRevocation(
    initial,
    'workspace-a:bob',
    'workspace-a:alice',
    '2026-11-23T01:00:00.000Z',
  );
  expect(sessionHasReadGrant(revoked, 'workspace-a:bob')).toBe(false);
  expect(sessionWasReadGrantedTo(revoked, 'workspace-a:bob')).toBe(true);
  expect(sessionReadGrantOf(revoked, 'workspace-a:bob')).toEqual({
    owner: 'workspace-a:bob',
    grantedBy: 'workspace-a:alice',
    grantedAt: '2026-11-23T00:00:00.000Z',
    revokedBy: 'workspace-a:alice',
    revokedAt: '2026-11-23T01:00:00.000Z',
  });
});

test('malformed sharing metadata fails closed', () => {
  const metadata = { [SESSION_READ_GRANTS_METADATA_KEY]: [{ owner: 'bob' }] };
  expect(sessionHasReadGrant(metadata, 'bob')).toBe(false);
  expect(sessionWasReadGrantedTo(metadata, 'bob')).toBe(false);
});

test('a later grant restores access without leaving stale revocation state', () => {
  const revoked = withSessionReadRevocation(
    initial,
    'workspace-a:bob',
    'workspace-a:alice',
    '2026-11-23T01:00:00.000Z',
  );
  const restored = withSessionReadGrant(revoked, {
    owner: 'workspace-a:bob',
    grantedBy: 'workspace-a:alice',
    grantedAt: '2026-11-23T02:00:00.000Z',
  });
  expect(sessionHasReadGrant(restored, 'workspace-a:bob')).toBe(true);
  expect(sessionReadGrantOf(restored, 'workspace-a:bob')?.revokedAt).toBeUndefined();
});
