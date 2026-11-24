import { expect, test } from 'bun:test';

import {
  SESSION_READ_GRANTS_METADATA_KEY,
  sessionReadGrantHistoryOf,
  sessionHasReadGrant,
  sessionReadGrantOf,
  sessionWasReadGrantedTo,
  withSessionReadGrant,
  withSessionReadGrantAttempt,
  withSessionReadRevocation,
} from './session-sharing.ts';

const initial = withSessionReadGrant({}, {
  owner: 'workspace-a:bob',
  workspaceId: 'workspace-a',
  actorId: 'bob',
  sessionIncarnation: 'session-a',
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
    workspaceId: 'workspace-a',
    actorId: 'bob',
    sessionIncarnation: 'session-a',
    grantedBy: 'workspace-a:alice',
    grantedAt: '2026-11-23T00:00:00.000Z',
    revokedBy: 'workspace-a:alice',
    revokedAt: '2026-11-23T01:00:00.000Z',
  });
  expect(sessionReadGrantHistoryOf(revoked).map((event) => [event.kind, event.changed])).toEqual([
    ['granted', true],
    ['revoked', true],
  ]);
});

test('malformed sharing metadata fails closed', () => {
  const metadata = { [SESSION_READ_GRANTS_METADATA_KEY]: [{ owner: 'bob' }] };
  expect(sessionHasReadGrant(metadata, 'bob')).toBe(false);
  expect(sessionWasReadGrantedTo(metadata, 'bob')).toBe(false);
});

test('a duplicate or malformed durable row cannot revive an earlier grant', () => {
  const metadata = {
    [SESSION_READ_GRANTS_METADATA_KEY]: [
      {
        owner: 'workspace-a:bob',
        workspaceId: 'workspace-a',
        actorId: 'bob',
        sessionIncarnation: 'session-a',
        grantedBy: 'workspace-a:alice',
        grantedAt: '2026-11-23T00:00:00.000Z',
      },
      { owner: 'workspace-a:bob', workspaceId: 'workspace-a' },
    ],
  };
  expect(sessionHasReadGrant(metadata, 'workspace-a:bob')).toBe(false);
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
    workspaceId: 'workspace-a',
    actorId: 'bob',
    sessionIncarnation: 'session-a',
    grantedBy: 'workspace-a:alice',
    grantedAt: '2026-11-23T02:00:00.000Z',
  });
  expect(sessionHasReadGrant(restored, 'workspace-a:bob')).toBe(true);
  expect(sessionReadGrantOf(restored, 'workspace-a:bob')?.revokedAt).toBeUndefined();
  expect(sessionReadGrantHistoryOf(restored).map((event) => event.kind)).toEqual([
    'granted',
    'revoked',
    'granted',
  ]);
});

test('a grant copied to another session incarnation fails closed', () => {
  expect(sessionHasReadGrant(initial, 'workspace-a:bob', 'session-b')).toBe(false);
});

test('a repeated command records an unchanged audit outcome', () => {
  const repeated = withSessionReadGrantAttempt(
    initial,
    'workspace-a:bob',
    'granted',
    'workspace-a:alice',
    '2026-11-23T00:01:00.000Z',
  );
  expect(sessionReadGrantHistoryOf(repeated).map((event) => event.changed)).toEqual([true, false]);
});
