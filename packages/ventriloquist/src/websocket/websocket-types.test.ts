import { expect, test } from 'bun:test';

import type { Authentication, Authorization, DenialReason } from './websocket-types.ts';

test('the host callback types are erased at runtime and the module still loads', async () => {
  expect(Object.keys(await import('./websocket-types.ts'))).toEqual([]);
});

test('a denial carries only a typed reason, and an acceptance carries a trusted subject and lifetime', () => {
  const reasons: DenialReason[] = ['unauthenticated', 'expired', 'forbidden', 'unavailable'];
  const refused: Authentication = { ok: false, denial: 'expired' };
  const accepted: Authentication = { ok: true, subject: 'user', expiresInMilliseconds: 1 };
  // @ts-expect-error a denial cannot invent a reason
  const invented: Authorization = { allowed: false, denial: 'because I said so' };
  expect([reasons.length, refused.ok, accepted.ok, invented.allowed]).toEqual([
    4,
    false,
    true,
    false,
  ]);
});
