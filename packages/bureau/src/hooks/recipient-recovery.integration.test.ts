import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportEncryptionKey, generateEncryptionKey } from '@lostgradient/cryptography';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect, it } from 'bun:test';

import {
  expectScenarioPassed,
  settleScenario,
  type ScenarioScope,
} from '../test/hoisted-scenario.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import { fireRunEvents, openHooksBureau, waitForSettledDeliveries } from './hooks.test-support.ts';

type Wire = {
  event: string;
  run: string;
  delivery: string;
  hook: string;
  attempt: number;
  key: string;
  effects: number;
};

async function scenario(deduplicate: boolean, scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'recipient-recovery-'));
  const senderPath = join(directory, 'sender.sqlite');
  const ledger = new Database(join(directory, 'recipient.sqlite'));
  ledger.run('CREATE TABLE effects (operation_key TEXT NOT NULL)');
  ledger.run(
    'CREATE TABLE wire (event TEXT, run TEXT, delivery TEXT, hook TEXT, attempt INTEGER, operation_key TEXT, effects INTEGER)',
  );
  const storage = createSqliteStorageFixture({ path: senderPath });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const key = request.headers.get('Idempotency-Key')!;
      const delivery = request.headers.get('X-Delivery-Id')!;
      const hook = request.headers.get('X-Hook-Id')!;
      const attempt = Number(request.headers.get('X-Delivery-Attempt'));
      const event = request.headers.get('X-Event-Kind')!;
      const body = (await request.json()) as { payload: { runId: string } };
      ledger.transaction(() => {
        const exists = ledger
          .query('SELECT count(*) AS count FROM effects WHERE operation_key = ?')
          .get(key) as { count: number };
        if (!deduplicate || exists.count === 0) ledger.run('INSERT INTO effects VALUES (?)', [key]);
        const effects = (
          ledger
            .query('SELECT count(*) AS count FROM effects WHERE operation_key = ?')
            .get(key) as { count: number }
        ).count;
        ledger.run('INSERT INTO wire VALUES (?, ?, ?, ?, ?, ?, ?)', [
          event,
          body.payload.runId,
          delivery,
          hook,
          attempt,
          key,
          effects,
        ]);
      })();
      if (
        attempt === 1 &&
        (ledger.query('SELECT count(*) AS count FROM wire').get() as { count: number }).count === 1
      )
        await barrier;
      return new Response('ok');
    },
  });
  const key = await generateEncryptionKey();
  const child = spawnWithHangGuard(
    [
      'bun',
      join(import.meta.dir, 'recipient-recovery-child.ts'),
      senderPath,
      `http://127.0.0.1:${server.port}/hook`,
      await exportEncryptionKey(key),
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  let opened: Awaited<ReturnType<typeof openHooksBureau>> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      release();
      await opened?.dispose();
      await storage.dispose();
      server.stop(true);
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    })());
  scope.onHang(cleanup);
  const rows = () =>
    ledger
      .query(
        'SELECT event, run, delivery, hook, attempt, operation_key AS key, effects FROM wire ORDER BY rowid',
      )
      .all() as Wire[];
  try {
    await waitUntil(() => rows().length === 1, {
      message: 'recipient did not commit the first request',
    });
    const first = rows()[0]!;
    expect(first).toMatchObject({ event: 'run.registered', attempt: 1, effects: 1 });
    expect(first.delivery).toBe(first.key);
    child.kill('SIGKILL');
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    release();
    opened = await openHooksBureau({
      storage: storage.storage,
      fetch,
      key,
      now: () => 1_800_001_000_000,
      durable: false,
    });
    const [delivery] = await waitForSettledDeliveries(opened.bureau, first.hook, 1);
    expect(delivery!.status).toBe('delivered');
    expect(delivery!.attempts.map((attempt) => [attempt.number, attempt.outcome])).toEqual([
      [1, 'interrupted'],
      [2, 'response'],
    ]);
    await fireRunEvents(opened.bureau);
    await waitForSettledDeliveries(opened.bureau, first.hook, 2);
    const trace = rows();
    console.log(
      JSON.stringify({ control: deduplicate ? 'idempotent' : 'non-deduplicating', trace }),
    );
    expect(trace).toHaveLength(3);
    expect(trace[1]).toMatchObject({
      run: first.run,
      delivery: first.delivery,
      key: first.key,
      attempt: 2,
      effects: deduplicate ? 1 : 2,
    });
    expect(trace[2]).toMatchObject({ event: 'run.registered', attempt: 1, effects: 1 });
    expect(trace[2]!.key).not.toBe(first.key);
    expect(trace[2]!.run).not.toBe(first.run);
  } finally {
    await cleanup();
  }
}

const idempotent = await settleScenario((scope) => scenario(true, scope), 120_000);
const control = await settleScenario((scope) => scenario(false, scope), 120_000);

it('replays an accepted webhook once at an idempotent recipient and exposes a bad control', () => {
  expectScenarioPassed(idempotent);
  expectScenarioPassed(control);
});
