/**
 * COR-771 — the effective-context epoch records which governed-memory bundle a
 * provider turn consumed, and a bundle recalled under one memory policy never
 * stays current under the next, in a direct run, a durable run, and a run
 * recovered by a restarted Bureau.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  type GovernedMemory,
} from '@lostgradient/memory';
import {
  type ContextEpochSealer,
  type ContextSourceRecord,
  createAgent,
  createContextEpochSealer,
  type GenerateFunction,
  MEMORY_EVIDENCE_METADATA_KEY,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { createTool, createToolbox, type ToolRequestContext } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { createMemoryRecallHook, createRunMemoryAuthority } from './runtime-composition';
import { waitForCondition, waitForRunState } from './test';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import type { Bureau } from './types';

const requestContext: ToolRequestContext = {
  authority: {
    principalId: 'api-key:alice',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    // Search only, so no run's answer is remembered and recalled by a later step.
    capabilities: ['tools:execute', 'memory:search'],
    authorizationRevision: 'gateway:1',
  },
};

const seeder = createMemoryAuthority({
  principal: { kind: 'user', id: 'owner-a:seed' },
  tenantId: 'tenant-a',
  ownerId: 'owner-a',
  purpose: 'conversation-memory',
  capabilities: ['memory:write'],
  policyRevision: 'gateway:1',
  projection: 'bureau',
});

const platformGovernance = createMemoryAuthority({
  principal: { kind: 'governance', id: 'governance:platform' },
  tenantId: 'platform',
  ownerId: 'platform-governance',
  purpose: 'policy',
  capabilities: ['memory:policy', 'memory:inspect'],
  policyRevision: 'gateway:1',
  projection: 'administrative',
});

function governedMemory(): GovernedMemory {
  return createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage(),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: (texts) => texts.map((text) => [text.includes('automobile') ? 1 : 0.1, 1]),
    policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
  });
}

async function seed(memory: GovernedMemory): Promise<string> {
  const receipt = await memory.write(seeder, 'The user drives an electric automobile.', {
    collection: 'scout',
    source: 'conversation',
  });
  return receipt.recordId!;
}

/** What one generate attempt saw: its epoch's memory-evidence source and the evidence rows in context. */
interface Turn {
  readonly step: number;
  readonly source: ContextSourceRecord | undefined;
  readonly rows: readonly {
    readonly content: string;
    readonly bundleRevision: string | undefined;
  }[];
}

function evidenceRows(conversation: Conversation): Turn['rows'] {
  return conversation.getMessages().flatMap((message) => {
    const entry = message.metadata?.[MEMORY_EVIDENCE_METADATA_KEY] as
      Record<string, unknown> | undefined;
    if (entry === undefined || typeof message.content !== 'string') return [];
    const bundleRevision = entry['bundleRevision'];
    return [
      {
        content: message.content,
        bundleRevision: typeof bundleRevision === 'string' ? bundleRevision : undefined,
      },
    ];
  });
}

/**
 * A generate function that records each turn, the turns it recorded, and the
 * per-run sealer factory with every sealer it made. Each run gets its own
 * sealer, and a turn reads the epoch of the run it belongs to.
 */
function recording(respond: GenerateFunction): {
  readonly generate: GenerateFunction;
  readonly turns: Turn[];
  readonly createContextEpoch: () => ContextEpochSealer;
  readonly sealers: ContextEpochSealer[];
} {
  const turns: Turn[] = [];
  const sealers: ContextEpochSealer[] = [];
  const createContextEpoch = () => {
    const created = createContextEpochSealer();
    sealers.push(created);
    return created;
  };
  const generate: GenerateFunction = async (context) => {
    // The tests run one run at a time, so the newest sealer is this run's.
    const sealer = sealers.at(-1);
    turns.push({
      step: context.step,
      source: sealer?.current()?.sources.find((source) => source.sourceId === 'memory-evidence'),
      rows: evidenceRows(context.conversation),
    });
    return respond(context);
  };
  return { generate, turns, createContextEpoch, sealers };
}

const probe = createTool({
  name: 'probe',
  description: 'does nothing, so the run takes a second step',
  input: z.object({}),
  execute: async () => 'ok',
});

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

const activateNextPolicy = (memory: GovernedMemory) =>
  memory.activatePolicy(
    platformGovernance,
    createMemoryGovernancePolicy({ revision: 'governance:2' }),
  );

describe('the epoch records the memory bundle a turn consumed (COR-771)', () => {
  it('names the bundle revision in a direct run, and is absent without governed memory', async () => {
    const memory = governedMemory();
    const car = await seed(memory);
    const { generate, turns, createContextEpoch } = recording(async () => ({
      content: 'noted',
      toolCalls: [],
    }));
    const bureau = await createBureau<AgentDefinitions>({
      id: 'tenant-a',
      agents: {
        scout: createAgent({ generate, createContextEpoch }),
      },
      memory,
      requestAuthorityValidator: () => true,
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({
      message: 'Which automobile?',
      sessionId: 'session-1',
      agentName: 'scout',
      principal: 'owner-a',
      requestContext,
    });
    await waitForRunState(bureau, run.id);

    const [turn] = turns;
    expect(turn?.rows).toHaveLength(1);
    expect(turn?.rows[0]?.content).toContain(car);
    expect(turn?.source).toMatchObject({
      trust: 'untrusted-retrieved',
      disposition: { kind: 'included' },
      revision: turn?.rows[0]?.bundleRevision,
    });

    const plain = await createBureau<AgentDefinitions>({
      id: 'tenant-a',
      agents: {
        scout: createAgent({ generate, createContextEpoch }),
      },
    });
    bureaus.push(plain);
    const unmemoried = await plain.createRun({
      message: 'Which automobile?',
      sessionId: 'session-2',
      agentName: 'scout',
    });
    await waitForRunState(plain, unmemoried.id);
    expect(turns.at(-1)?.source?.disposition).toEqual({ kind: 'absent-by-composition' });
  });

  it('withdraws a bundle a memory-policy change made stale, and the next epoch records the new one', async () => {
    const memory = governedMemory();
    await seed(memory);
    const { generate, turns, createContextEpoch } = recording(async (context) => {
      if (context.step > 0) return { content: 'done', toolCalls: [] };
      await activateNextPolicy(memory);
      return { content: '', toolCalls: [{ id: 'call-1', name: 'probe', arguments: {} }] };
    });
    const bureau = await createBureau<AgentDefinitions>({
      id: 'tenant-a',
      agents: {
        scout: createAgent({ generate, createContextEpoch, toolbox: createToolbox([probe]) }),
      },
      memory,
      requestAuthorityValidator: () => true,
    });
    bureaus.push(bureau);
    const run = await bureau.createRun({
      message: 'Which automobile?',
      sessionId: 'session-1',
      agentName: 'scout',
      principal: 'owner-a',
      requestContext,
    });
    await waitForRunState(bureau, run.id);

    const [first, second] = turns;
    expect(first?.source?.disposition).toEqual({ kind: 'included' });
    expect(second?.source?.disposition).toEqual({ kind: 'included' });
    expect(second?.source?.revision).not.toBe(first?.source?.revision);
    expect(second?.source?.revision).toBe(second?.rows.at(-1)?.bundleRevision);
    // The stale row stays in the transcript, withdrawn, so the model no longer reads it.
    expect(second?.rows).toHaveLength(2);
    expect(second?.rows[0]?.content).toContain('withdrawn');
  });
});

describe('a session’s next run (COR-771)', () => {
  it('seals its own epoch chain and recalls under the policy now in force', async () => {
    const memory = governedMemory();
    await seed(memory);
    const { generate, turns, createContextEpoch, sealers } = recording(async () => ({
      content: 'noted',
      toolCalls: [],
    }));
    const bureau = await createBureau<AgentDefinitions>({
      id: 'tenant-a',
      agents: {
        scout: createAgent({ generate, createContextEpoch }),
      },
      memory,
      requestAuthorityValidator: () => true,
    });
    bureaus.push(bureau);
    const ask = async () => {
      const run = await bureau.createRun({
        message: 'Which automobile?',
        sessionId: 'session-1',
        agentName: 'scout',
        principal: 'owner-a',
        requestContext,
      });
      await waitForRunState(bureau, run.id);
    };
    await ask();
    await activateNextPolicy(memory);
    await ask();

    const [first, second] = turns;
    expect(sealers).toHaveLength(2);
    expect(sealers[1]?.current()?.supersedes).toBeUndefined();
    expect(second?.rows).toHaveLength(1);
    expect(second?.source).toMatchObject({
      disposition: { kind: 'included' },
      revision: second?.rows[0]?.bundleRevision,
    });
    expect(second?.source?.revision).not.toBe(first?.source?.revision);
  });
});

describe('the recall hook at step 0 (COR-771)', () => {
  it('withdraws a row recalled under an older policy before it recalls again', async () => {
    const memory = governedMemory();
    await seed(memory);
    const authority = createRunMemoryAuthority(requestContext, {
      runId: 'run-1',
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
    });
    const hook = createMemoryRecallHook(memory, authority, {
      collection: 'scout',
      sessionId: 'session-1',
    });
    // A host-supplied conversation that already holds a row from an earlier run.
    const conversation = new Conversation();
    conversation.appendUserMessage('Which automobile?');
    await hook({ step: 0, conversation });
    await activateNextPolicy(memory);
    conversation.appendUserMessage('Which automobile again?');
    await hook({ step: 0, conversation });

    const rows = evidenceRows(conversation);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.content).toContain('withdrawn');
    expect(rows[1]?.content).toContain('<memory-evidence>');
  });
});

describe('the recall hook during a policy change (COR-771)', () => {
  it('recalls again when the policy changes while recall runs, so it never appends a stale bundle', async () => {
    const memory = governedMemory();
    await seed(memory);
    let calls = 0;
    const racing: GovernedMemory = {
      ...memory,
      get policyRevision() {
        return memory.policyRevision;
      },
      recallForModel: async (...parameters) => {
        calls += 1;
        const bundle = await memory.recallForModel(...parameters);
        // The policy moves after the first recall took its snapshot.
        if (calls === 1) await activateNextPolicy(memory);
        return bundle;
      },
    };
    const hook = createMemoryRecallHook(
      racing,
      createRunMemoryAuthority(requestContext, {
        runId: 'run-1',
        tenantId: 'tenant-a',
        ownerId: 'owner-a',
      }),
      { collection: 'scout', sessionId: 'session-1' },
    );
    const conversation = new Conversation();
    conversation.appendUserMessage('Which automobile?');
    await hook({ step: 0, conversation });

    expect(calls).toBe(2);
    const [row] = conversation.getMessages().filter((message) => message.role === 'system');
    expect(row?.metadata?.[MEMORY_EVIDENCE_METADATA_KEY]).toMatchObject({
      policyRevision: 'governance:2',
    });
  });

  it('withdraws a row carried from an earlier run when the policy moves mid-recall', async () => {
    const memory = governedMemory();
    await seed(memory);
    const authority = createRunMemoryAuthority(requestContext, {
      runId: 'run-1',
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
    });
    const target = { collection: 'scout', sessionId: 'session-1' };
    // An earlier run recalled this row under governance:1.
    const conversation = new Conversation();
    conversation.appendUserMessage('Which automobile?');
    await createMemoryRecallHook(memory, authority, target)({ step: 0, conversation });
    let calls = 0;
    const racing: GovernedMemory = {
      ...memory,
      get policyRevision() {
        return memory.policyRevision;
      },
      recallForModel: async (...parameters) => {
        calls += 1;
        const bundle = await memory.recallForModel(...parameters);
        if (calls === 1) await activateNextPolicy(memory);
        return bundle;
      },
    };
    conversation.appendUserMessage('Which automobile again?');
    await createMemoryRecallHook(racing, authority, target)({ step: 0, conversation });

    const rows = evidenceRows(conversation);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.content).toContain('withdrawn');
    expect(rows[1]?.content).toContain('<memory-evidence>');
  });
});

describe('a durable run recovered by a restarted Bureau (COR-771)', () => {
  async function recover(changePolicyWhileParked: boolean) {
    const memory = governedMemory();
    const car = await seed(memory);
    const { generate, turns, createContextEpoch } = recording(async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'answer', prompt: 'Which one?' },
              },
            ],
          }
        : { content: 'thanks', toolCalls: [] },
    );
    const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
    fixtures.push(fixture);
    const open = async () => {
      const bureau = await createBureau<AgentDefinitions>({
        id: 'tenant-a',
        agents: {
          scout: createAgent({ generate, createContextEpoch, toolbox: createToolbox([]) }),
        },
        memory,
        storage: fixture.configuration,
        durable: true,
        durableOwnership: { ownership: 'none' },
        requestAuthorityValidator: () => true,
      });
      bureaus.push(bureau);
      return bureau;
    };

    const crashed = await open();
    const run = await crashed.createRun({
      message: 'Which automobile?',
      sessionId: 'session-1',
      agentName: 'scout',
      principal: 'owner-a',
      requestContext,
    });
    await waitForCondition(
      () => crashed.reviews.list().some((review) => review.runId === run.id),
      'the run never parked',
    );
    if (changePolicyWhileParked) await activateNextPolicy(memory);
    // Not disposed: a graceful shutdown would cancel the parked run.
    const restarted = await open();
    await restarted.waitForRecovery?.();
    await waitForCondition(
      () => restarted.reviews.list().some((review) => review.runId === run.id),
      'the recovered run never parked again',
    );
    const [review] = restarted.reviews.list().filter((item) => item.runId === run.id);
    await restarted.reviews.resolve({
      id: review!.id,
      decision: 'approve',
      principal: 'owner-a',
      payload: 'the electric one',
    });
    await restarted.waitForDurableRun(run.id);
    return {
      car,
      first: turns.find((turn) => turn.step === 0),
      resumed: turns.findLast((turn) => turn.step === 1),
    };
  }

  it('keeps recording the same bundle across the restart when nothing changed', async () => {
    const { car, first, resumed } = await recover(false);
    expect(first?.rows[0]?.content).toContain(car);
    expect(first?.source).toMatchObject({ disposition: { kind: 'included' } });
    expect(resumed?.source).toMatchObject({
      disposition: { kind: 'included' },
      revision: first?.source?.revision,
    });
  });

  it('records a new bundle after a policy change while the run was parked', async () => {
    const { car, first, resumed } = await recover(true);
    expect(resumed?.source?.disposition).toEqual({ kind: 'included' });
    expect(resumed?.source?.revision).not.toBe(first?.source?.revision);
    expect(resumed?.rows.at(-1)?.content).toContain(car);
  });
});
