/**
 * COR-1710 — the `bureau.settings.*` operations over a real Bureau and its handler: the scopes that
 * gate them, every key round-tripped through `get` and `update`, the fault for each refusal, the
 * audit record that names keys and never values, and the change subscription.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { encodeCursor } from '@lostgradient/weft';

import { SETTING_KEYS, type SettingKey } from '../../settings/settings-schema.ts';
import type { BureauOptions } from '../../types.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  openBureau,
  type OpenedBureau,
  readFrames,
  readWireBlocks,
  rpc,
  subscribeRequest,
} from './management-fixtures.test-support.ts';
import { bureauSettingsOperations, settingsEventsOperation } from './settings-operations.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function open(settings?: BureauOptions['settings']): Promise<OpenedBureau> {
  const opened = await openBureau(settings === undefined ? {} : { bureauOptions: { settings } });
  cleanups.push(() => opened.dispose());
  return opened;
}

/** A valid value for every key, different from its default. */
const SAMPLES: Readonly<Record<SettingKey, unknown>> = {
  'tools.humanInput': { inputSchemas: { approve: { type: 'string' } } },
  'tools.wakeup': false,
  'tools.decide': false,
  modelPolicy: { policyRevision: 2, deployment: { deniedProviders: ['openai'] } },
  'decisions.fallbackModel': 'anthropic/claude-haiku',
  'decisions.maximumPerTask': 3,
  'retention.audit': { olderThan: 86_400_000 },
  'retention.events': { olderThan: 3_600_000 },
  'retention.tasks': 'forever',
  'retention.receipts': { olderThan: 7_200_000 },
  'retention.memory': { olderThan: 604_800_000 },
  'retention.checkpoints': { keepLast: 4 },
  'sessionInput.sessionBacklogLimit': 7,
  'sessionInput.principalBacklogLimit': 9,
  'children.delegation.defaultTimeToLiveMilliseconds': 60_000,
  'engine.retention': { completed: 3_600_000 },
  'engine.retentionSweepInterval': 120_000,
  'engine.retentionSweepBatchSize': 50,
  'engine.history': { maxEvents: 5_000 },
  'engine.payloadSize': { maxBytes: 1_048_576 },
  'engine.checkpointSizeWarningThreshold': 2_000_000,
  'engine.schedulerPollIntervalMs': 2_000,
  'engine.checkpointHistory': 5,
  'engine.maxNestingDepth': 4,
  'engine.workflowClaimTtl': 30_000,
  'engine.workflowClaimRenewInterval': 10_000,
  durable: false,
  maintenance: 'manual',
  'durableOwnership.ownership': 'none',
  workflowVersion: 'v2',
};

type Snapshot = {
  values: Record<string, unknown>;
  revision: number;
  keys: Record<string, { apply: string; locked: boolean; pendingRestart: boolean }>;
};

async function snapshotOf(opened: OpenedBureau, key = 'settings-reader-key'): Promise<Snapshot> {
  const answered = await rpc(opened.handler, 'bureau.settings.get', {}, key);
  expect(answered.error).toBeUndefined();
  return answered.result as Snapshot;
}

const update = (
  opened: OpenedBureau,
  params: Record<string, unknown>,
  key = 'settings-writer-key',
) => rpc(opened.handler, 'bureau.settings.update', params, key);

describe('bureau.settings operations', () => {
  it('are served', () => {
    for (const operation of bureauSettingsOperations) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
    }
  });

  it('refuse a caller without the scope', async () => {
    const opened = await open();
    for (const key of ['alice-key', 'decisions-writer-key']) {
      const read = await rpc(opened.handler, 'bureau.settings.get', {}, key);
      expect(read.error?.data).toMatchObject({ httpStatus: 403 });
    }
    const written = await update(
      opened,
      { patch: { 'tools.wakeup': false }, expectedRevision: 0 },
      'settings-reader-key',
    );
    expect(written.error?.data).toMatchObject({ httpStatus: 403 });
    const after = await snapshotOf(opened);
    expect(after.revision).toBe(0);
  });

  it('round-trips every key through get and update', async () => {
    const opened = await open();
    for (const key of SETTING_KEYS) {
      const before = await snapshotOf(opened);
      const answered = await update(opened, {
        patch: { [key]: SAMPLES[key] },
        expectedRevision: before.revision,
      });
      expect(answered.error).toBeUndefined();
      expect(answered.result).toEqual({
        revision: before.revision + 1,
        pendingRestart: before.keys[key]?.apply === 'restart' ? [key] : [],
      });
      const after = await snapshotOf(opened);
      expect(after.values[key]).toEqual(SAMPLES[key]);
      expect(after.keys[key]?.pendingRestart).toBe(after.keys[key]?.apply === 'restart');
    }
  });

  it('publishes the schema with every key', async () => {
    const opened = await open();
    const answered = await rpc(opened.handler, 'bureau.settings.schema', {}, 'settings-reader-key');
    const schema = (answered.result as { schema: { properties: Record<string, unknown> } }).schema;
    expect(Object.keys(schema.properties).toSorted()).toEqual([...SETTING_KEYS].toSorted());
  });

  it('answers a stale revision with StaleRevision and the current revision', async () => {
    const opened = await open();
    await update(opened, { patch: { 'tools.wakeup': false }, expectedRevision: 0 });
    const stale = await update(opened, { patch: { 'tools.wakeup': true }, expectedRevision: 0 });
    expect(stale.error?.data).toMatchObject({ weftCode: 'StaleRevision', currentRevision: 1 });
  });

  it('answers a locked key with Unprocessable', async () => {
    const opened = await open({ locked: ['tools.humanInput'] });
    const locked = await update(opened, {
      patch: { 'tools.humanInput': false },
      expectedRevision: 0,
    });
    expect(locked.error?.data).toMatchObject({
      weftCode: 'Unprocessable',
      reason: 'locked',
    });
    const snapshot = await snapshotOf(opened);
    expect(snapshot.keys['tools.humanInput']?.locked).toBe(true);
  });

  it('answers an unknown key and an invalid value with InvalidParams', async () => {
    const opened = await open();
    const unknown = await update(opened, { patch: { 'tools.teleport': 1 }, expectedRevision: 0 });
    expect(unknown.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    const invalid = await update(opened, {
      patch: { 'decisions.maximumPerTask': -1 },
      expectedRevision: 0,
    });
    expect(invalid.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    const unchanged = await snapshotOf(opened);
    expect(unchanged.revision).toBe(0);
  });

  it('audits a change with its keys, revision, and principal, never its value', async () => {
    const opened = await open();
    await update(opened, {
      patch: { 'decisions.fallbackModel': 'anthropic/VALUE-SENTINEL-9c1' },
      expectedRevision: 0,
    });
    const records =
      (await opened.bureau.internals.auditTrail?.query({ type: 'settings.changed' })) ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      principal: 'api-key:settings-writer',
      detail: { keys: 'decisions.fallbackModel', revision: 1 },
    });
    expect(JSON.stringify(records)).not.toContain('VALUE-SENTINEL');
  });

  it('delivers each change to a subscription, by revision and keys', async () => {
    const opened = await open();
    const subscription = await settingsEventsOperation.invoke({
      input: {},
      host: { settings: opened.bureau.settings },
    } as never);
    expect(subscription.subscriptionId).toBe(subscription.envelope.subscriptionId);
    const iterator = subscription.iterable[Symbol.asyncIterator]();
    const next = iterator.next();
    await opened.bureau.settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 });
    const delivered = await next;
    expect(delivered.value).toMatchObject({
      kind: 'settings.changed',
      revision: 1,
      keys: ['tools.wakeup'],
    });
    await subscription.close();
  });
  it('serves the change subscription over SSE, one frame per applied change', async () => {
    const opened = await open();
    const response = await opened.handler(
      subscribeRequest('bureau.settings.events', {}, 'settings-reader-key'),
    );
    expect(response.status).toBe(200);
    const reading = readFrames(response, { stop: (frames) => frames.length >= 1 });
    const written = await update(opened, {
      patch: { 'tools.wakeup': false },
      expectedRevision: 0,
    });
    expect(written.error).toBeUndefined();
    const frames = await reading;
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toBe('settings.changed');
    expect(frames[0]?.data).toMatchObject({ revision: 1, keys: ['tools.wakeup'] });
    // The frame's id is the revision as a cursor, and it carries no value.
    expect(frames[0]?.id).toBeDefined();
    expect(JSON.stringify(frames)).not.toContain('false');
  });

  it('refuses the SSE subscription without bureau.settings:read', async () => {
    const opened = await open();
    for (const key of ['alice-key', 'decisions-writer-key']) {
      const response = await opened.handler(subscribeRequest('bureau.settings.events', {}, key));
      expect(response.status).toBe(403);
    }
  });

  it('rejects a malformed cursor as InvalidParams', async () => {
    const opened = await open();
    const response = await opened.handler(
      subscribeRequest(
        'bureau.settings.events',
        { fromCursor: 'not-a-cursor' },
        'settings-reader-key',
      ),
    );
    expect(response.status).toBe(400);
  });

  it('resumes from an older revision with one event for the current revision, then live changes', async () => {
    const opened = await open();
    await update(opened, { patch: { 'tools.wakeup': false }, expectedRevision: 0 });
    await update(opened, { patch: { 'tools.decide': false }, expectedRevision: 1 });
    const resumed = await opened.handler(
      subscribeRequest('bureau.settings.events', {}, 'settings-reader-key', encodeCursor(0)),
    );
    const reading = readFrames(resumed, { stop: (frames) => frames.length >= 2 });
    await update(opened, { patch: { maintenance: 'manual' }, expectedRevision: 2 });
    const frames = await reading;
    expect(frames.map((frame) => (frame.data as { revision: number }).revision)).toEqual([2, 3]);
    expect(frames[0]?.data).toMatchObject({ keys: [] });
    expect(frames[1]?.data).toMatchObject({ keys: ['maintenance'] });
    expect(frames.map((frame) => frame.id)).toEqual([encodeCursor(2), encodeCursor(3)]);
  });

  it('delivers nothing on resume at the current revision, then the next change', async () => {
    const opened = await open();
    await update(opened, { patch: { 'tools.wakeup': false }, expectedRevision: 0 });
    const resumed = await opened.handler(
      subscribeRequest('bureau.settings.events', {}, 'settings-reader-key', encodeCursor(1)),
    );
    const reading = readFrames(resumed, { stop: (frames) => frames.length >= 1 });
    await update(opened, { patch: { 'tools.decide': false }, expectedRevision: 1 });
    const frames = await reading;
    expect(frames.map((frame) => (frame.data as { revision: number }).revision)).toEqual([2]);
  });
  it('delivers a change made while a resume reads the revision once, not twice', async () => {
    let listener: ((change: { revision: number; keys: readonly string[] }) => void) | undefined;
    const settings = {
      subscribe: (next: typeof listener) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      // The change lands after the subscription and before the read answers, so the read already
      // includes it.
      get: () => {
        listener?.({ revision: 5, keys: ['tools.wakeup'] });
        return Promise.resolve({ revision: 5 });
      },
    };
    const subscription = await settingsEventsOperation.invoke({
      input: { fromCursor: encodeCursor(2) },
      host: { settings },
    } as never);
    const iterator = subscription.iterable[Symbol.asyncIterator]();
    const caughtUp = await iterator.next();
    expect(caughtUp.value).toMatchObject({ revision: 5, keys: [] });
    const second = iterator.next();
    listener?.({ revision: 6, keys: ['tools.decide'] });
    const live = await second;
    expect(live.value).toMatchObject({ revision: 6, keys: ['tools.decide'] });
    await subscription.close();
  });

  describe('replay completion marker on the wire', () => {
    it('sends the catch-up event before the replayComplete ping when resuming from an older revision', async () => {
      const opened = await open();
      await update(opened, { patch: { 'tools.wakeup': false }, expectedRevision: 0 });
      const resumed = await opened.handler(
        subscribeRequest('bureau.settings.events', {}, 'settings-reader-key', encodeCursor(0)),
      );
      const blocks = await readWireBlocks(resumed, (seen) =>
        seen.some((block) => block.event === 'ping' && block.data.replayComplete === true),
      );
      expect(blocks.map((block) => block.event)).toEqual(['settings.changed', 'ping']);
      expect(blocks[0]?.data).toMatchObject({ revision: 1, keys: [] });
      expect(blocks[1]?.data).toMatchObject({ replayComplete: true });
    });

    it('marks replay complete at once when no catch-up event is needed', async () => {
      const opened = await open();
      const live = await opened.handler(
        subscribeRequest('bureau.settings.events', {}, 'settings-reader-key'),
      );
      const blocks = await readWireBlocks(live, (seen) => seen.length >= 1);
      expect(blocks.map((block) => block.event)).toEqual(['ping']);
      expect(blocks[0]?.data).toMatchObject({ replayComplete: true });

      await update(opened, { patch: { 'tools.wakeup': false }, expectedRevision: 0 });
      const current = await opened.handler(
        subscribeRequest('bureau.settings.events', {}, 'settings-reader-key', encodeCursor(1)),
      );
      const atCurrent = await readWireBlocks(current, (seen) => seen.length >= 1);
      expect(atCurrent.map((block) => block.event)).toEqual(['ping']);
      expect(atCurrent[0]?.data).toMatchObject({ replayComplete: true });
    });
  });
});
