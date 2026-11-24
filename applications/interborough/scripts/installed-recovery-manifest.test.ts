import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  assertOneRefundResult,
  assertRecoveryManifest,
  recoveryManifest,
  verifyRecovery,
} from './installed-recovery-manifest.ts';

test('detects schema, content and identity mismatches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recovery-manifest-'));
  try {
    const database = new Database(join(home, 'database.sqlite'));
    database.exec(
      'PRAGMA user_version = 4; CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)',
    );
    const digest = createHash('sha256')
      .update(new Uint8Array([0, 255, 1]))
      .digest('hex');
    const key = `asset:v1:blob:sha256:${digest}`;
    database.query('INSERT INTO kv VALUES (?, ?)').run(key, Buffer.from('AP8B'));
    database.close();
    const before = await recoveryManifest(home, [digest], { review: 'review-1' });
    expect(before.schemaVersion).toBe(4);
    expect(before.schema.join(' ')).toContain('CREATE TABLE kv');
    assertRecoveryManifest(await recoveryManifest(home, [digest], { review: 'review-1' }), before);
    expect(() => assertRecoveryManifest({ ...before, schemaVersion: 5 }, before)).toThrow();
    expect(() =>
      assertRecoveryManifest({ ...before, identities: { review: 'review-2' } }, before),
    ).toThrow();
    expect(() => assertRecoveryManifest({ ...before, content: {} }, before)).toThrow();
    const changed = new Database(join(home, 'database.sqlite'));
    changed.query('UPDATE kv SET value = ? WHERE key = ?').run(Buffer.from('AP8C'), key);
    changed.close();
    expect(
      await throwingRejectionOf(recoveryManifest(home, [digest], { review: 'review-1' })),
    ).toThrow('Asset digest mismatch');
    expect(await throwingRejectionOf(recoveryManifest(home, ['../asset'], {}))).toThrow(
      'Invalid asset digest',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('requires exactly one successful durable result for the resumed call', () => {
  const row = {
    toolResult: {
      callId: 'call-1',
      outcome: 'success',
      content: { orderId: 'order-1001', refundedCents: 4200 },
    },
  };
  assertOneRefundResult({ first: row }, 'call-1');
  expect(() => assertOneRefundResult({}, 'call-1')).toThrow('exactly one');
  expect(() => assertOneRefundResult({ first: row, duplicate: row }, 'call-1')).toThrow(
    'exactly one',
  );
  expect(() => assertOneRefundResult({ first: row }, 'another-call')).toThrow('exactly one');
});

test('requires the restored review and setting from host readback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'recovery-readback-'));
  let reviewId = 'review-1';
  let wakeup = false;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { method: string };
      return Response.json({
        result:
          body.method === 'bureau.reviews.list'
            ? { reviews: [{ id: reviewId, runId: 'run-1', sessionId: 'session-1' }] }
            : { values: { 'tools.wakeup': wakeup } },
      });
    },
  });
  try {
    const database = new Database(join(home, 'database.sqlite'));
    database.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)');
    database.close();
    const manifest = await recoveryManifest(home, [], {
      reviewId,
      runId: 'run-1',
      sessionId: 'session-1',
      wakeup: 'false',
    });
    const path = join(home, 'manifest.json');
    await writeFile(path, JSON.stringify(manifest));
    await verifyRecovery(home, server.url.href.replace(/\/$/, ''), path);
    wakeup = true;
    expect(
      await throwingRejectionOf(verifyRecovery(home, server.url.href.replace(/\/$/, ''), path)),
    ).toThrow('Recovery manifest mismatch');
    wakeup = false;
    reviewId = 'different-review';
    expect(
      await throwingRejectionOf(verifyRecovery(home, server.url.href.replace(/\/$/, ''), path)),
    ).toThrow('Saved review is not pending');
  } finally {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
