/**
 * COR-1710 — a task's tools are read from `bureau.settings` once, when it starts, and recorded on
 * its admission record. A task parked across a change keeps its grant, a task started after the
 * change gets the new one, and a task recorded before grants were recorded resumes with the
 * settings at resume, which are then recorded on it.
 */
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { encodeStorageKeyComponent, MemoryStorage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { TASK_RECORD_KEY_PREFIX } from '../task-registry';
import { waitForCondition } from '../test';
import type { Bureau } from '../types';
import {
  createSqliteStorageFixture,
  type PersistentBureauStorageFixture,
} from '../test/storage-fixtures';

/** The tool names offered at each step, by agent. */
type Offered = Map<string, string[][]>;

/**
 * Records its tools at each step under its name and, as `parker`, parks on `requestHumanInput` at
 * its first step when it has the tool.
 */
function recordingAgent(offered: Offered, name: 'parker' | 'plain') {
  const generate: GenerateFunction = async (context: GenerateContext) => {
    const tools = context.toolbox.tools().map((tool) => tool.name);
    offered.set(name, [...(offered.get(name) ?? []), tools]);
    if (name === 'parker' && context.step === 0 && tools.includes('requestHumanInput')) {
      return {
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'requestHumanInput', arguments: { signalName: 'answer' } },
        ],
      };
    }
    return { content: 'done', toolCalls: [] };
  };
  return createAgent({
    generate,
    toolbox: createToolbox([]),
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });
}

function agentsFor(offered: Offered): AgentDefinitions {
  return { parker: recordingAgent(offered, 'parker'), plain: recordingAgent(offered, 'plain') };
}

/** A Bureau over a new handle on `database`, as a new process would open. */
async function open(
  database: PersistentBureauStorageFixture,
  offered: Offered,
): Promise<Bureau<AgentDefinitions>> {
  return createBureau<AgentDefinitions>({
    agents: agentsFor(offered),
    storage: database.open(),
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
}

async function parked(bureau: Bureau<AgentDefinitions>, runId: string): Promise<string> {
  await waitForCondition(
    () => bureau.reviews.list().some((review) => review.runId === runId),
    'the task to park on requestHumanInput',
  );
  const review = bureau.reviews.list().find((candidate) => candidate.runId === runId);
  if (review === undefined) throw new Error('unreachable');
  return review.id;
}

describe('tool grants', () => {
  it('a task started before tools.humanInput is turned off keeps it; one started after does not', async () => {
    const offered: Offered = new Map();
    const bureau = await createBureau<AgentDefinitions>({
      agents: agentsFor(offered),
      storage: new MemoryStorage(),
      durable: true,
    });
    try {
      const before = await bureau.tasks.start('parker', 'park');
      const reviewId = await parked(bureau, before.id);
      const { revision } = await bureau.settings.get();
      expect(
        await bureau.settings.update({ 'tools.humanInput': false }, { expectedRevision: revision }),
      ).toMatchObject({ outcome: 'applied' });

      const after = await bureau.tasks.start('plain', 'later');
      await waitForCondition(() => offered.has('plain'), 'the later task to step');
      expect(offered.get('plain')?.flat()).not.toContain('requestHumanInput');
      const afterRecord = await bureau.internals.taskRegistry.record(after.id);
      expect(afterRecord?.tools?.humanInput).toBe(false);

      await bureau.reviews.resolve({ id: reviewId, decision: 'approve', principal: 'operator' });
      await waitForCondition(
        () => (offered.get('parker')?.length ?? 0) >= 2,
        'the parked task to resume',
      );
      expect(offered.get('parker')?.[1]).toContain('requestHumanInput');
    } finally {
      await bureau.dispose();
    }
  });

  it('a parked task resumed by another process keeps the grant it started with', async () => {
    const database = createSqliteStorageFixture();
    const first = await open(database, new Map());
    const offered: Offered = new Map();
    let second: Bureau<AgentDefinitions> | undefined;
    try {
      const task = await first.tasks.start('parker', 'park');
      await parked(first, task.id);
      const { revision } = await first.settings.get();
      await first.settings.update({ 'tools.humanInput': false }, { expectedRevision: revision });

      // The first process is abandoned while the task is parked, as a crash would leave it.
      second = await open(database, offered);
      const recovered = await second.settings.get();
      expect(recovered.values['tools.humanInput']).toBe(false);
      const reviewId = await parked(second, task.id);
      await second.reviews.resolve({ id: reviewId, decision: 'approve', principal: 'operator' });
      await waitForCondition(() => offered.has('parker'), 'the recovered task to resume');
      expect(offered.get('parker')?.[0]).toContain('requestHumanInput');

      await second.tasks.start('plain', 'fresh');
      await waitForCondition(() => offered.has('plain'), 'the fresh task to step');
      expect(offered.get('plain')?.flat()).not.toContain('requestHumanInput');
    } finally {
      await first.dispose();
      await second?.dispose();
      await database.dispose();
    }
  });

  it('a task recorded before grants were resumes with the settings at resume, recorded once', async () => {
    const database = createSqliteStorageFixture();
    const first = await open(database, new Map());
    const offered: Offered = new Map();
    let second: Bureau<AgentDefinitions> | undefined;
    try {
      const task = await first.tasks.start('parker', 'park');
      await parked(first, task.id);
      // The record as an older build wrote it: no `tools`.
      const kv = first.internals.kv;
      if (kv === undefined) throw new Error('expected a key-value store');
      const key = `${TASK_RECORD_KEY_PREFIX}${encodeStorageKeyComponent(task.id)}`;
      const stored = JSON.parse((await kv.get(key)) ?? '{}') as Record<string, unknown>;
      expect(stored['tools']).toEqual({ humanInput: {}, wakeup: true, decide: true });
      delete stored['tools'];
      await kv.set(key, JSON.stringify(stored));
      const { revision } = await first.settings.get();
      await first.settings.update({ 'tools.wakeup': false }, { expectedRevision: revision });

      second = await open(database, offered);
      const reviewId = await parked(second, task.id);
      const legacy = await second.internals.taskRegistry.record(task.id);
      expect(legacy?.tools).toEqual({
        humanInput: {},
        wakeup: false,
        decide: true,
      });
      await second.reviews.resolve({ id: reviewId, decision: 'approve', principal: 'operator' });
      await waitForCondition(() => offered.has('parker'), 'the recovered task to resume');
      expect(offered.get('parker')?.[0]).not.toContain('scheduleWakeup');
      expect(offered.get('parker')?.[0]).toContain('requestHumanInput');
    } finally {
      await first.dispose();
      await second?.dispose();
      await database.dispose();
    }
  });
});
