/**
 * COR-1710 — the `bureau.settings.*` operations over a real Bureau and its handler: the scopes that
 * gate them, every key round-tripped through `get` and `update`, the fault for each refusal, the
 * audit record that names keys and never values, and the change subscription.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { SETTING_KEYS, type SettingKey } from '../../settings/settings-schema.ts';
import type { BureauOptions } from '../../types.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { openBureau, type OpenedBureau, rpc } from './management-fixtures.test-support.ts';
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
    const iterator = subscription.iterable[Symbol.asyncIterator]();
    const next = iterator.next();
    await opened.bureau.settings.update({ 'tools.wakeup': false }, { expectedRevision: 0 });
    const delivered = await next;
    expect(delivered.value).toEqual({ revision: 1, keys: ['tools.wakeup'] });
    await subscription.close();
  });
});
