import { describe, expect, it } from 'bun:test';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectScenarioPassed, settleScenario } from './test/hoisted-scenario';
import { createBureau } from './create-bureau';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';

const ledgerModule = resolve(import.meta.dir, '../../../plugins/demo/src/refund-ledger.ts');
const processorModule = resolve(import.meta.dir, '../../../plugins/demo/src/refund-processor.ts');
const { createRefundLedger } = await import(ledgerModule);
const { createFakeProcessor, recoverRefund } = await import(processorModule);
const childPath = fileURLToPath(new URL('./test/refund-crash-child.ts', import.meta.url));
const admissionChildPath = fileURLToPath(
  new URL('./test/refund-admission-child.ts', import.meta.url),
);
const reviewChildPath = fileURLToPath(
  new URL('./test/refund-review-crash-child.ts', import.meta.url),
);

const admissionRows = [
  [4000, true, 2, 4000],
  [6000, false, 1, 6000],
  [4000, false, 2, 8000],
] as const;
const admissionOutcomes = await Promise.all(
  admissionRows.map(([amount, sameCommand, successes, reserved]) =>
    settleScenario(async (scope) => {
      const directory = createTemporaryDirectory('refund-admission');
      const path = join(directory, 'ledger.sqlite');
      const storage = new BunSQLiteStorage(path);
      const ledger = createRefundLedger(storage);
      const spawnAdmission = (commandId: string) =>
        spawnWithHangGuard(['bun', admissionChildPath, path, commandId, String(amount)], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      const children: ReturnType<typeof spawnAdmission>[] = [];
      try {
        await ledger.addCharge({
          merchant: 'merchant',
          order: 'order',
          amount: 10000,
          currency: 'USD',
          paymentReference: 'charge',
          providerAccount: 'account',
        });
        for (const commandId of ['one', sameCommand ? 'one' : 'two']) {
          children.push(spawnAdmission(commandId));
        }
        scope.onHang(() => {
          for (const child of children) child.kill();
        });
        const readers = children.map((child) => child.stdout.getReader());
        const ready = await Promise.all(readers.map((reader) => reader.read()));
        for (const message of ready)
          expect(new TextDecoder().decode(message.value)).toContain('ready');
        for (const child of children) {
          child.stdin.write('go');
          child.stdin.flush();
        }
        const messages = await Promise.all(readers.map((reader) => reader.read()));
        const results = messages.map(
          (message) =>
            JSON.parse(new TextDecoder().decode(message.value)) as { id?: string; error?: string },
        );
        expect(results.filter((result) => result.id !== undefined)).toHaveLength(successes);
        if (sameCommand) expect(results[0]?.id).toBe(results[1]?.id);
        expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved });
      } finally {
        for (const child of children) {
          child.kill();
          await child.exited;
        }
        storage[Symbol.dispose]();
        removeTemporaryPath(directory);
      }
    }, 120_000),
  ),
);

const points = ['before-send', 'after-acceptance', 'before-receipt'] as const;
const recoveryOutcomes = await Promise.all(
  points.map((point) =>
    settleScenario(async (scope) => {
      const directory = createTemporaryDirectory('refund-recovery');
      const ledgerPath = join(directory, 'ledger.sqlite');
      const processorPath = join(directory, 'processor.sqlite');
      const ledgerStorage = new BunSQLiteStorage(ledgerPath);
      const processorStorage = new BunSQLiteStorage(processorPath);
      const ledger = createRefundLedger(ledgerStorage);
      const processor = createFakeProcessor(processorStorage);
      try {
        await ledger.addCharge({
          merchant: 'merchant',
          order: 'order',
          amount: 10000,
          currency: 'USD',
          paymentReference: 'charge',
          providerAccount: 'account',
        });
        const refund = await ledger.admit({
          merchant: 'merchant',
          commandId: 'command',
          order: 'order',
          amount: 4000,
          toolRevision: '1.1.0',
          owner: 'alice',
        });
        const child = spawnWithHangGuard(
          ['bun', childPath, ledgerPath, processorPath, refund.id, point],
          { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        );
        scope.onHang(() => child.kill());
        try {
          const reader = child.stdout.getReader();
          const marker = await reader.read();
          expect(new TextDecoder().decode(marker.value)).toContain('barrier');
        } finally {
          child.kill('SIGKILL');
          await child.exited;
        }
        expect(child.signalCode).toBe('SIGKILL');
        await recoverRefund(ledger, processor, refund.id, 10);
        const refunds = await processor.refunds();
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({
          paymentReference: 'charge',
          providerAccount: 'account',
          currency: 'USD',
          amount: 4000,
        });
        expect(await ledger.get(refund.id)).toMatchObject({
          status: 'provider-pending',
          receipt: refunds[0].receipt,
        });
      } finally {
        ledgerStorage[Symbol.dispose]();
        processorStorage[Symbol.dispose]();
        removeTemporaryPath(directory);
      }
    }, 120_000),
  ),
);
const fenceOutcome = await settleScenario(async (scope) => {
  const directory = createTemporaryDirectory('refund-fence');
  const ledgerPath = join(directory, 'ledger.sqlite');
  const processorPath = join(directory, 'processor.sqlite');
  const ledgerStorage = new BunSQLiteStorage(ledgerPath);
  const processorStorage = new BunSQLiteStorage(processorPath);
  const ledger = createRefundLedger(ledgerStorage);
  const processor = createFakeProcessor(processorStorage);
  let stop: (() => void) | undefined;
  try {
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const child = spawnWithHangGuard(
      ['bun', childPath, ledgerPath, processorPath, refund.id, 'before-receipt'],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    stop = () => child.kill();
    scope.onHang(() => stop?.());
    const marker = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(marker.value)).toContain('barrier');
    await processor.update(refund.providerKey, 'succeeded');
    await recoverRefund(ledger, processor, refund.id, 10);
    const settled = await ledger.get(refund.id);
    child.stdin.end();
    expect(await child.exited).toBe(0);
    stop = undefined;
    expect(await ledger.get(refund.id)).toEqual(settled);
    expect(settled).toMatchObject({ status: 'succeeded' });
    expect(await ledger.balance('merchant', 'order')).toMatchObject({
      reserved: 0,
      settled: 4000,
    });
  } finally {
    stop?.();
    ledgerStorage[Symbol.dispose]();
    processorStorage[Symbol.dispose]();
    removeTemporaryPath(directory);
  }
}, 120_000);
const expiryOutcome = await settleScenario(async (scope) => {
  const directory = createTemporaryDirectory('refund-expiry');
  const ledgerPath = join(directory, 'ledger.sqlite');
  const processorPath = join(directory, 'processor.sqlite');
  const ledgerStorage = new BunSQLiteStorage(ledgerPath);
  const processorStorage = new BunSQLiteStorage(processorPath);
  const ledger = createRefundLedger(ledgerStorage);
  const processor = createFakeProcessor(processorStorage);
  let stop: (() => void) | undefined;
  try {
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const refund = await ledger.admit({
      merchant: 'merchant',
      commandId: 'command',
      order: 'order',
      amount: 4000,
      toolRevision: '1.1.0',
      owner: 'alice',
    });
    const child = spawnWithHangGuard(
      ['bun', childPath, ledgerPath, processorPath, refund.id, 'after-acceptance'],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    stop = () => child.kill();
    scope.onHang(() => stop?.());
    const marker = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(marker.value)).toContain('barrier');
    child.kill('SIGKILL');
    await child.exited;
    stop = undefined;
    await processor.expire(refund.providerKey);
    await recoverRefund(ledger, processor, refund.id, 101, false);
    await recoverRefund(ledger, processor, refund.id, 102, false);
    expect(await processor.submissions()).toBe(1);
    expect(await processor.refunds()).toHaveLength(1);
    expect(await ledger.get(refund.id)).toMatchObject({ status: 'needs-reconciliation' });
    expect(await ledger.balance('merchant', 'order')).toMatchObject({ reserved: 4000 });
  } finally {
    stop?.();
    ledgerStorage[Symbol.dispose]();
    processorStorage[Symbol.dispose]();
    removeTemporaryPath(directory);
  }
}, 120_000);

const terminalReleaseOutcome = await settleScenario(async (scope) => {
  const directory = createTemporaryDirectory('refund-review-release');
  const path = join(directory, 'bureau.sqlite');
  const child = spawnWithHangGuard(['bun', reviewChildPath, path], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  scope.onHang(() => child.kill());
  try {
    const marker = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(marker.value)).toContain('release-barrier');
    child.kill('SIGKILL');
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    const storage = new BunSQLiteStorage(path);
    const pluginModule = resolve(import.meta.dir, '../../../plugins/demo/src/plugin.ts');
    const { createDemoPlugin, DEMO_APPROVAL_SECRET } = await import(pluginModule);
    const diagnostics: string[] = [];
    const common = {
      agents: {},
      plugins: [
        {
          descriptor: createDemoPlugin({ seedOnStart: false }),
          source: 'package' as const,
          location: '@lostgradient/plugin-demo',
        },
      ],
      pluginSecrets: {
        get: async (key: string) => (key === DEMO_APPROVAL_SECRET ? 'fixture-secret' : undefined),
        watch: () => () => {},
      },
      storage,
      durable: true,
    };
    const unavailable = await createBureau({
      ...common,
      pluginConfiguration: { demo: { enabled: false } },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic.message);
      },
      runtime: createManualRuntimeServices({ origin: '2026-01-01T00:01:00.000Z' }),
    });
    await unavailable.recovery();
    await unavailable.maintain();
    const pending = await unavailable.internals.sessionStore!.outbox.pending();
    const instruction = pending.find(
      (entry) =>
        entry.kind === 'session.attachment' &&
        JSON.stringify(entry.payload).includes('terminalRelease'),
    );
    expect(instruction).toBeDefined();
    if (!instruction || instruction.kind !== 'session.attachment')
      throw new Error('Missing release');
    const locator = (instruction.payload as { terminalRelease: Record<string, unknown> })
      .terminalRelease;
    expect(Object.keys(locator).toSorted()).toEqual([
      'handler',
      'identifier',
      'reviewId',
      'round',
      'runId',
      'toolRevision',
    ]);
    expect(
      diagnostics.some((message) => message.includes('Terminal review release unavailable')),
    ).toBe(true);
    await unavailable.dispose();
    const bureau = await createBureau({
      ...common,
      pluginConfiguration: { demo: { enabled: true } },
      runtime: createManualRuntimeServices({ origin: '2026-01-01T00:02:00.000Z' }),
    });
    try {
      await bureau.recovery();
      await bureau.maintain();
      const intents = [];
      for await (const [, value] of storage.scan('plugin:demo:refund-ledger:refund:'))
        intents.push(JSON.parse(new TextDecoder().decode(value)));
      expect(intents).toHaveLength(1);
      expect(intents[0].status).toBe('failed');
      const { scopedStorage } = await import('@lostgradient/storage');
      const ledger = createRefundLedger(scopedStorage(storage, 'plugin:demo:refund-ledger'));
      expect(await ledger.balance(intents[0].merchant, intents[0].order)).toMatchObject({
        reserved: 0,
      });
      const sessionStore = bureau.internals.sessionStore!;
      await sessionStore.update(instruction.sessionId, (session) => session, {
        outbox: [
          { namespace: instruction.namespace, payload: instruction.payload },
          { namespace: instruction.namespace, payload: instruction.payload },
        ],
      });
      await bureau.maintain();
      const afterReplay = await sessionStore.outbox.pending();
      expect(
        afterReplay.some(
          (entry) =>
            entry.kind === 'session.attachment' &&
            JSON.stringify(entry.payload).includes('terminalRelease'),
        ),
      ).toBe(false);
      expect(await ledger.balance(intents[0].merchant, intents[0].order)).toMatchObject({
        reserved: 0,
      });
    } finally {
      await bureau.dispose();
      storage[Symbol.dispose]();
    }
  } finally {
    removeTemporaryPath(directory);
  }
}, 120_000);

describe('cross-process refund admission', () => {
  for (const [index, [amount, , , reserved]] of admissionRows.entries())
    it(`reserves ${reserved} cents for concurrent ${amount}-cent commands`, () =>
      expectScenarioPassed(admissionOutcomes[index]));
});
describe('refund recovery after process death', () => {
  for (const [index, point] of points.entries())
    it(`recovers ${point}`, () => expectScenarioPassed(recoveryOutcomes[index]));
  it('rejects a delayed response from a superseded process', () =>
    expectScenarioPassed(fenceOutcome));
  it('does not resubmit after acknowledgement loss and key expiry', () =>
    expectScenarioPassed(expiryOutcome));
  it('replays a terminal release after process death', () =>
    expectScenarioPassed(terminalReleaseOutcome));
});
