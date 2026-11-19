/**
 * COR-2522 — `bureau.schedules.cancel` and `bureau.hooks.delete` with `dryRun: true`.
 */
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createReceiver, SIGNING_SECRET } from '../../hooks/hooks.test-support.ts';
import {
  dryRunResultOf,
  expectNothingWritten,
  expectSameFaultAsTheRealCall,
  withBureau,
} from './dry-run.test-support.ts';
import { answering, rpc } from './management-fixtures.test-support.ts';

const writer = createAgent({
  name: 'writer',
  generate: async () => ({ content: 'ok', toolCalls: [] }),
});

describe('bureau.schedules.cancel with dryRun', () => {
  const open = <T>(body: Parameters<typeof withBureau<T>>[1]) =>
    withBureau<T>({ agents: { writer }, a2aAgents: ['writer'], generate: answering() }, body);

  async function createSchedule(opened: Parameters<Parameters<typeof open>[0]>[0]) {
    const created = await rpc(
      opened.handler,
      'bureau.schedules.create',
      { agentName: 'writer', spec: '1h', input: 'a report' },
      'alice-key',
    );
    expect(created.error).toBeUndefined();
    return created.result!['id'] as string;
  }

  it('counts the occurrences it would drop, writes nothing and leaves the schedule active', async () => {
    await open(async (opened, subject) => {
      const scheduleId = await createSchedule(opened);
      const before = await opened.bureau.schedules.get(scheduleId);

      const body = await expectNothingWritten(subject, () =>
        rpc(opened.handler, 'bureau.schedules.cancel', { scheduleId, dryRun: true }, 'alice-key'),
      );

      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'schedule', id: scheduleId },
        effects: [{ kind: 'queued-runs', count: 0 }],
      });
      const after = await opened.bureau.schedules.get(scheduleId);
      expect(after?.status).toBe('active');
      expect(after?.revision).toBe(before?.revision);

      // The real call then cancels it.
      const real = await rpc(
        opened.handler,
        'bureau.schedules.cancel',
        { scheduleId },
        'alice-key',
      );
      expect(real.result).toMatchObject({ id: scheduleId, status: 'cancelled' });
    });
  });

  it('answers a StaleRevision when `expectedRevision` is not the schedule’s, as the real call does', async () => {
    await open(async (opened) => {
      const scheduleId = await createSchedule(opened);
      const params = { scheduleId, expectedRevision: 99 };
      const real = await rpc(opened.handler, 'bureau.schedules.cancel', params, 'alice-key');
      const dry = await rpc(
        opened.handler,
        'bureau.schedules.cancel',
        { ...params, dryRun: true },
        'alice-key',
      );
      expect(real.error?.data?.httpStatus).toBe(409);
      expect(dry.error).toEqual(real.error);
      const schedule = await opened.bureau.schedules.get(scheduleId);
      expect(schedule?.status).toBe('active');
    });
  });

  it('answers the fault the real call answers for a schedule that is missing or another owner’s', async () => {
    await open(async (opened) => {
      const scheduleId = await createSchedule(opened);
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.schedules.cancel',
        { scheduleId: 'no-such-schedule' },
        'alice-key',
      );
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.schedules.cancel',
        { scheduleId },
        'bob-key',
      );
    });
  });
});

describe('bureau.hooks.delete with dryRun', () => {
  async function open<T>(body: Parameters<typeof withBureau<T>>[1]): Promise<T> {
    const receiver = createReceiver((_call, index) =>
      index === 0 ? new Response('pong', { status: 200 }) : new Response('again'),
    );
    return withBureau<T>(
      {
        storage: new MemoryStorage(),
        bureauOptions: {
          hooks: {},
          answerEncryption: { current: await generateEncryptionKey() },
          webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
        },
      },
      body,
    );
  }

  const NEW_HOOK = {
    url: 'https://receiver.example/hook',
    events: ['run.settled'],
    signingSecret: SIGNING_SECRET,
  };

  async function hookWithADelivery(opened: Parameters<Parameters<typeof open>[0]>[0]) {
    const created = await rpc(
      opened.handler,
      'bureau.hooks.create',
      NEW_HOOK,
      'alice-observer-key',
    );
    expect(created.error).toBeUndefined();
    const hookId = (created.result as { id: string }).id;
    const tested = await rpc(opened.handler, 'bureau.hooks.test', { hookId }, 'alice-observer-key');
    expect(tested.error).toBeUndefined();
    return hookId;
  }

  it('counts the delivery records it would remove, writes nothing and keeps the hook', async () => {
    await open(async (opened, subject) => {
      const hookId = await hookWithADelivery(opened);

      const body = await expectNothingWritten(subject, () =>
        rpc(opened.handler, 'bureau.hooks.delete', { hookId, dryRun: true }, 'alice-observer-key'),
      );

      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'hook', id: hookId },
        effects: [
          { kind: 'delivery-records', count: 1 },
          { kind: 'deliveries-in-flight', count: 0 },
        ],
      });
      const kept = await rpc(opened.handler, 'bureau.hooks.get', { hookId }, 'alice-observer-key');
      expect(kept.error).toBeUndefined();

      // The real call then deletes it.
      const real = await rpc(
        opened.handler,
        'bureau.hooks.delete',
        { hookId },
        'alice-observer-key',
      );
      expect(real.result).toEqual({ hookId, deleted: true });
    });
  });

  it('answers the fault the real call answers for a hook that is missing or another owner’s', async () => {
    await open(async (opened) => {
      const hookId = await hookWithADelivery(opened);
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.hooks.delete',
        { hookId: 'no-such-hook' },
        'alice-observer-key',
      );
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.hooks.delete',
        { hookId },
        'bob-observer-key',
      );
    });
  });
});
