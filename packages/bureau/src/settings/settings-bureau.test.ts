/**
 * COR-1710 — `bureau.settings` on a whole Bureau: a restart key, an ephemeral Bureau, two Bureaus
 * on one store, a locked key, and an agent file that changes a key through `settings-update`.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { startWorkflowToolsBureau } from '../testing/workflow-tools-bureau.test-support';
import type { Bureau, BureauOptions } from '../types';

const agents: AgentDefinitions = {
  anchor: createAgent({ name: 'anchor', generate: async () => ({ content: 'a', toolCalls: [] }) }),
};

function open(options: Partial<BureauOptions<AgentDefinitions>> = {}) {
  return createBureau<AgentDefinitions>({ agents, durable: false, ...options });
}

async function revisionOf(bureau: Bureau<AgentDefinitions>): Promise<number> {
  const { revision } = await bureau.settings.get();
  return revision;
}

describe('bureau.settings on a Bureau', () => {
  it('stores a restart key, reports it pendingRestart, and applies it in a new Bureau on the same store', async () => {
    const storage = new MemoryStorage();
    const first = await open({ storage, maintenance: 'automatic' });
    try {
      const result = await first.settings.update(
        { maintenance: 'manual' },
        { expectedRevision: await revisionOf(first) },
      );
      expect(result).toEqual({ outcome: 'applied', revision: 1, pendingRestart: ['maintenance'] });
      const snapshot = await first.settings.get();
      expect(snapshot.keys.maintenance.pendingRestart).toBe(true);
      expect(snapshot.keys.maintenance.apply).toBe('restart');
    } finally {
      await first.dispose();
    }
    const second = await open({ storage, maintenance: 'automatic' });
    try {
      const snapshot = await second.settings.get();
      expect(snapshot.values.maintenance).toBe('manual');
      expect(snapshot.keys.maintenance.pendingRestart).toBe(false);
      expect(snapshot.revision).toBe(1);
      await second.maintain();
    } finally {
      await second.dispose();
    }
  });

  it('reports persisted: false on an ephemeral Bureau and still applies a live update', async () => {
    const bureau = await open();
    try {
      const before = await bureau.settings.get();
      expect(before.persisted).toBe(false);
      expect(before.values['tools.wakeup']).toBe(true);
      const result = await bureau.settings.update(
        { 'tools.wakeup': false },
        { expectedRevision: before.revision },
      );
      expect(result).toMatchObject({ outcome: 'applied', revision: 1, pendingRestart: [] });
      const after = await bureau.settings.get();
      expect(after.values['tools.wakeup']).toBe(false);
      expect(after.persisted).toBe(false);
    } finally {
      await bureau.dispose();
    }
  });

  it('shows a second Bureau on the same store a change after its maintain()', async () => {
    const storage = new MemoryStorage();
    const first = await open({ storage, maintenance: 'manual' });
    const second = await open({ storage, maintenance: 'manual' });
    try {
      const result = await first.settings.update(
        { 'tools.wakeup': false },
        { expectedRevision: 0 },
      );
      expect(result).toMatchObject({ outcome: 'applied', revision: 1 });
      const unseen = await second.settings.get();
      expect(unseen.values['tools.wakeup']).toBe(true);

      await second.maintain();
      const seen = await second.settings.get();
      expect(seen.values['tools.wakeup']).toBe(false);
      expect(seen.revision).toBe(1);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('refuses a locked key with `locked` and reports it locked', async () => {
    const bureau = await open({
      storage: new MemoryStorage(),
      settings: { locked: { 'tools.humanInput': 'deployment' } },
    });
    try {
      const result = await bureau.settings.update(
        { 'tools.humanInput': false },
        { expectedRevision: 0 },
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        reason: 'locked',
        keys: ['tools.humanInput'],
        currentRevision: 0,
      });
      const snapshot = await bureau.settings.get();
      expect(snapshot.keys['tools.humanInput'].locked).toBe(true);
      expect(snapshot.keys['tools.wakeup'].locked).toBe(false);
      expect(snapshot.revision).toBe(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('reports a reason for every locked key and none for an unlocked one', async () => {
    const bureau = await open({
      storage: new MemoryStorage(),
      settings: {
        locked: {
          'tools.humanInput': 'deployment',
          'durableOwnership.ownership': 'shared-storage',
        },
      },
    });
    try {
      const { keys } = await bureau.settings.get();
      const locked = Object.entries(keys).filter(([, state]) => state.locked);
      expect(locked.map(([key, state]) => [key, state.lockReason])).toEqual([
        ['tools.humanInput', 'deployment'],
        ['durableOwnership.ownership', 'shared-storage'],
      ]);
      expect(Object.values(keys).filter((state) => !state.locked && 'lockReason' in state)).toEqual(
        [],
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a locked list, an unknown key, and an unknown reason at construction', async () => {
    for (const locked of [
      ['tools.humanInput'],
      { 'tools.teleport': 'deployment' },
      { durable: 'because' },
    ]) {
      const failure = await rejectionOf(
        open({ storage: new MemoryStorage(), settings: { locked } as never }),
      );
      expect(String(failure)).toContain('options.settings.locked');
    }
  });

  it('lets an agent file that lists settings-update change a key, audited by key and revision and no value', async () => {
    const harness = await startWorkflowToolsBureau({ agents: [] });
    try {
      await harness.putAgent('tuner', ['settings-update']);
      const called = await harness.callTool(
        'settings-update',
        {
          patch: { 'decisions.fallbackModel': 'anthropic/VALUE-SENTINEL-4e2' },
          expectedRevision: 0,
        },
        { agent: 'tuner', principal: 'user:tuner' },
      );
      expect(called.outcome).toBe('success');
      expect(called.result).toMatchObject({ outcome: 'applied', revision: 1 });

      const snapshot = await harness.bureau.settings.get();
      expect(snapshot.values['decisions.fallbackModel']).toBe('anthropic/VALUE-SENTINEL-4e2');

      const records =
        (await harness.bureau.internals.auditTrail?.query({ type: 'settings.changed' })) ?? [];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        principal: 'user:tuner',
        detail: { keys: 'decisions.fallbackModel', revision: 1 },
      });
      expect(JSON.stringify(records)).not.toContain('VALUE-SENTINEL');
    } finally {
      await harness.dispose();
    }
  });
});

describe('a stored value the engine refuses', () => {
  it('a Bureau boots over a record whose claim timing Weft refuses, without it, and keeps the rest', async () => {
    const storage = new MemoryStorage();
    await textValueStore(storage, { disposeUnderlyingStorage: false }).set(
      'settings',
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        values: {
          'engine.workflowClaimTtl': 1_000,
          'engine.schedulerPollIntervalMs': 1.5,
          'engine.retentionSweepBatchSize': 25,
        },
        updatedAt: '2026-10-27T00:00:00.000Z',
      }),
    );
    const diagnostics: { scope: string; message: string }[] = [];
    const bureau = await open({
      storage,
      durable: true,
      maintenance: 'manual',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      const { values, revision } = await bureau.settings.get();
      expect(revision).toBe(3);
      expect(values['engine.workflowClaimTtl']).toBeUndefined();
      expect(values['engine.schedulerPollIntervalMs']).toBeUndefined();
      expect(values['engine.retentionSweepBatchSize']).toBe(25);
      const settingsMessages = diagnostics
        .filter((diagnostic) => diagnostic.scope === 'settings')
        .map((diagnostic) => diagnostic.message)
        .join('\n');
      expect(settingsMessages).toContain('"engine.workflowClaimTtl"');
      expect(settingsMessages).toContain('"engine.schedulerPollIntervalMs"');
      expect(settingsMessages).not.toContain('refused the settings');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('retention.audit and the automatic maintenance timer on a key-value-only Bureau', () => {
  it('a stored audit window starts the timer, live and after a restart', async () => {
    const storage = new MemoryStorage();
    const firstRuntime = createManualRuntimeServices();
    const first = await open({ storage, runtime: firstRuntime });
    try {
      expect(firstRuntime.pendingTimers()).toHaveLength(0);
      await first.settings.update(
        { 'retention.audit': { olderThan: 60_000 } },
        { expectedRevision: await revisionOf(first) },
      );
      expect(firstRuntime.pendingTimers().length).toBeGreaterThan(0);
    } finally {
      await first.dispose();
    }
    const secondRuntime = createManualRuntimeServices();
    const second = await open({ storage, runtime: secondRuntime });
    try {
      expect(secondRuntime.pendingTimers().length).toBeGreaterThan(0);
    } finally {
      await second.dispose();
    }
  });
});
