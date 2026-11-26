import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRefundLedger } from './refund-ledger.ts';

const admissionOutcome = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refund-admission-'));
  const path = join(directory, 'ledger.sqlite');
  const child = spawnWithHangGuard(
    [
      process.execPath,
      '-e',
      `
      import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
      import { createRefundLedger } from './src/refund-ledger.ts';
      const ledger = createRefundLedger(new BunSQLiteStorage(process.argv[1]));
      await ledger.addCharge({ merchant: 'merchant', order: 'order', amount: 10000, currency: 'USD', paymentReference: 'charge', providerAccount: 'account' });
      const refund = await ledger.admit({ merchant: 'merchant', commandId: 'command', order: 'order', amount: 4200, toolRevision: '1.1.0', owner: 'alice' });
      const start = await ledger.claimStart(refund.id);
      console.log(JSON.stringify({ refundId: refund.id, start }));
      await Bun.stdin.text();
    `,
      path,
    ],
    { cwd: process.cwd(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const reader = child.stdout.getReader();
    const output = await reader.read();
    if (!output.value)
      throw new Error(`Child exited before admission: ${await new Response(child.stderr).text()}`);
    const saved = JSON.parse(new TextDecoder().decode(output.value)) as {
      refundId: string;
      start: { runId: string; sessionId: string; fence: number };
    };
    child.kill('SIGKILL');
    await child.exited;
    const storage = new BunSQLiteStorage(path);
    try {
      const ledger = createRefundLedger(storage);
      const replay = await ledger.admit({
        merchant: 'merchant',
        commandId: 'command',
        order: 'order',
        amount: 4200,
        toolRevision: '1.1.0',
        owner: 'alice',
      });
      expect(replay.id).toBe(saved.refundId);
      const successor = await ledger.claimStart(replay.id);
      expect(successor).toMatchObject({
        runId: saved.start.runId,
        sessionId: saved.start.sessionId,
        fence: saved.start.fence + 1,
      });
      expect(await ledger.completeStart(replay.id, saved.start.fence)).toBe(false);
    } finally {
      storage[Symbol.dispose]();
    }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
})().then(
  () => null,
  (error: unknown) => error,
);
it('recovers the committed instruction and exact run identity after its claimant dies', () => {
  expect(admissionOutcome).toBeNull();
});
