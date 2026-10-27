/**
 * COR-1629 — Bureau's maintenance pass sweeps governed memory's retention. A run's collection fills
 * to `maxRecordsPerCollection` and stays full unless something expires its records, and governed
 * memory runs nothing on a timer of its own. The pass, the manual `runDurableMaintenance()` and the
 * automatic timer both, calls `sweepRetention()` under a `service:bureau` authority before it
 * advances the deletions the sweep opened.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  type GovernedMemory,
  type MemoryAuthority,
  type MemoryDeletionPropagator,
  type MemoryRetentionSweep,
} from '@lostgradient/memory';
import {
  createAgent,
  type GenerateFunction,
  stopWhen,
  waitForCondition,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import {
  BUREAU_MAINTENANCE_MEMORY_CAPABILITIES,
  BUREAU_MAINTENANCE_POLICY_REVISION,
  createRunMemoryAuthority,
  DEFAULT_RUN_MEMORY_CAPABILITIES,
} from './runtime-composition';
import { waitForTaskState } from './test';
import type { Bureau } from './types';

const BUREAU_ID = 'retention-bureau';
const DAY = 86_400_000;

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** A user's authority over its own partition of the Bureau's tenant. */
function userAuthority(ownerId: string): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind: 'user', id: ownerId },
    tenantId: BUREAU_ID,
    ownerId,
    purpose: 'test',
    capabilities: ['memory:write', 'memory:list', 'memory:get'],
    policyRevision: 'bureau:test',
    projection: 'bureau',
  });
}

/** A governance principal that may place a legal hold. */
const counsel = createMemoryAuthority({
  principal: { kind: 'governance', id: 'governance:counsel' },
  tenantId: BUREAU_ID,
  ownerId: 'governance-office',
  purpose: 'legal-hold',
  capabilities: ['memory:legal-hold'],
  policyRevision: 'bureau:test',
  projection: 'administrative',
});

/** A propagator that reports pending on its first attempt and completed on every later one. */
function countingPropagator(): MemoryDeletionPropagator & { readonly attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    propagate: async () => (++attempts === 1 ? { status: 'pending' } : { status: 'completed' }),
  };
}

type Calls = ('sweepRetention' | 'processDeletionPropagation')[];

function fixture(
  options: {
    maxRecordsPerCollection?: number;
    sweep?: () => Promise<MemoryRetentionSweep>;
    /** Holds every sweep until it settles, so a test can overlap two passes. */
    gate?: Promise<void>;
  } = {},
) {
  const runtime = createManualRuntimeServices({ identifierSeed: 'memory-retention-sweep' });
  const ledger = createMemoryGovernanceLedger(new MemoryStorage());
  const propagator = countingPropagator();
  const memory = createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() }),
    ledger,
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({
      revision: 'governance:retention-sweep',
      ...(options.maxRecordsPerCollection === undefined
        ? {}
        : { admission: { maxRecordsPerCollection: options.maxRecordsPerCollection } }),
    }),
    propagation: {
      caches: 'not-retained',
      'managed-asset-bytes': 'not-retained',
      'external-processors': propagator,
    },
    runtime,
  });
  const calls: Calls = [];
  // The spy delegates to the real memory and records the order the maintenance pass calls it in.
  const served: GovernedMemory = {
    ...memory,
    init: () => memory.init(),
    close: () => memory.close(),
    sweepRetention: async (authority, sweepOptions) => {
      calls.push('sweepRetention');
      await options.gate;
      return options.sweep === undefined
        ? memory.sweepRetention(authority, sweepOptions)
        : options.sweep();
    },
    processDeletionPropagation: () => {
      calls.push('processDeletionPropagation');
      return memory.processDeletionPropagation();
    },
  };
  return { runtime, ledger, memory, served, calls, propagator };
}

type Diagnostic = { level: string; scope: string; message: string };

async function start(
  built: ReturnType<typeof fixture>,
  options: {
    manual?: boolean;
    withoutMemory?: boolean;
    agents?: AgentDefinitions;
  } = {},
) {
  const diagnostics: Diagnostic[] = [];
  const bureau = await createBureau<AgentDefinitions>({
    id: BUREAU_ID,
    agents: {
      ...options.agents,
      default: createAgent({
        generate: async () => ({ content: 'ok', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: { type: 'memory' },
    durable: false,
    ...(options.withoutMemory ? {} : { memory: built.served }),
    ...(options.manual === false ? {} : { maintenance: 'manual' as const }),
    runtime: built.runtime,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  bureaus.push(bureau);
  return { bureau, diagnostics };
}

async function remember(
  memory: GovernedMemory,
  ownerId: string,
  collection: string,
  content: string,
): Promise<string> {
  const receipt = await memory.write(userAuthority(ownerId), content, {
    collection,
    source: 'conversation',
    memoryClass: 'episodic',
  });
  return receipt.recordId!;
}

async function contentsOf(
  memory: GovernedMemory,
  ownerId: string,
  collection: string,
): Promise<string[]> {
  const records = await memory.list(userAuthority(ownerId), { collection });
  return records.map((record) => record.content).toSorted();
}

function sweptEvents(built: ReturnType<typeof fixture>) {
  return built.ledger.listEvents({ tenantId: BUREAU_ID, type: 'memory.retention.swept' });
}

describe('the maintenance pass sweeps governed memory retention (COR-1629)', () => {
  it('deletes an expired record on the automatic timer, with a receipt and a sweep event', async () => {
    const built = fixture();
    await start(built, { manual: false });
    const recordId = await remember(built.memory, 'alice', 'alpha', 'An old answer.');
    expect(await contentsOf(built.memory, 'alice', 'alpha')).toEqual(['An old answer.']);

    await built.runtime.advance(91 * DAY);
    await waitForCondition(async () => {
      const remaining = await contentsOf(built.memory, 'alice', 'alpha');
      return remaining.length === 0;
    }, 'expected the automatic maintenance timer to sweep the expired record');

    const receipts = await built.ledger.listReceipts({ tenantId: BUREAU_ID });
    expect(receipts.map((receipt) => [receipt.record.id, receipt.trigger])).toEqual([
      [recordId, 'retention-expiry'],
    ]);
    const swept = await sweptEvents(built);
    expect(swept).toHaveLength(1);
    expect(swept[0]?.recordIds).toEqual([recordId]);
    // The timer's pass sweeps first, and only then advances the deletions the sweep opened.
    await waitForCondition(
      async () => built.calls.includes('processDeletionPropagation'),
      'expected the automatic pass to propagate deletions',
    );
    expect(built.calls.slice(0, 2)).toEqual(['sweepRetention', 'processDeletionPropagation']);
  });

  it('deletes nothing under manual background tasks until runDurableMaintenance is called', async () => {
    const built = fixture();
    const { bureau, diagnostics } = await start(built);
    await remember(built.memory, 'alice', 'alpha', 'An old answer.');

    await built.runtime.advance(91 * DAY);
    await built.runtime.advance(DAY);
    expect(await contentsOf(built.memory, 'alice', 'alpha')).toEqual(['An old answer.']);
    expect(built.calls).toEqual([]);

    expect(await bureau.runDurableMaintenance()).toBe(true);

    expect(await contentsOf(built.memory, 'alice', 'alpha')).toEqual([]);
    expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
  });

  it('sweeps every scope of the tenant and keeps what is inside retention or under legal hold', async () => {
    const built = fixture();
    const { bureau } = await start(built);
    await remember(built.memory, 'alice', 'alpha', 'Alice alpha, expired.');
    await remember(built.memory, 'alice', 'beta', 'Alice beta, expired.');
    await remember(built.memory, 'bob', 'alpha', 'Bob alpha, expired.');
    const heldId = await remember(built.memory, 'bob', 'beta', 'Bob beta, held.');
    await built.memory.placeLegalHold(counsel, { id: heldId, collection: 'beta', ownerId: 'bob' });
    await built.runtime.advance(60 * DAY);
    await remember(built.memory, 'alice', 'alpha', 'Alice alpha, recent.');
    await built.runtime.advance(31 * DAY);

    expect(await bureau.runDurableMaintenance()).toBe(true);

    expect(await contentsOf(built.memory, 'alice', 'alpha')).toEqual(['Alice alpha, recent.']);
    expect(await contentsOf(built.memory, 'alice', 'beta')).toEqual([]);
    expect(await contentsOf(built.memory, 'bob', 'alpha')).toEqual([]);
    expect(await contentsOf(built.memory, 'bob', 'beta')).toEqual(['Bob beta, held.']);
  });

  it('runs the sweep before deletion propagation, so the deletions it opens advance in the same pass', async () => {
    const built = fixture();
    const { bureau } = await start(built);
    await remember(built.memory, 'alice', 'alpha', 'An old answer.');
    await built.runtime.advance(91 * DAY);

    await bureau.runDurableMaintenance();

    expect(built.calls).toEqual(['sweepRetention', 'processDeletionPropagation']);
    // Opening the sweep's deletion attempted its bounded-async target once, which reported
    // pending. Only the propagation step that follows in the same pass attempts it again.
    expect(built.propagator.attempts()).toBe(2);
    const [receipt] = await built.ledger.listReceipts({ tenantId: BUREAU_ID });
    expect(receipt?.targets.find((row) => row.target === 'external-processors')?.status).toBe(
      'completed',
    );
  });

  it('sweeps under exactly the service:bureau authority and gives no run authority a capability', async () => {
    const built = fixture();
    const { bureau } = await start(built);
    await remember(built.memory, 'alice', 'alpha', 'An old answer.');
    await built.runtime.advance(91 * DAY);

    await bureau.runDurableMaintenance();

    const [event] = await sweptEvents(built);
    expect(event?.attribution).toMatchObject({
      principal: { kind: 'service', id: 'bureau' },
      tenantId: BUREAU_ID,
      ownerId: BUREAU_ID,
      purpose: 'retention',
      capabilities: ['memory:retention', 'memory:delete'],
      policyRevision: 'bureau:maintenance',
      projection: 'bureau',
      delegationChain: [
        {
          principal: { kind: 'service', id: 'bureau' },
          capabilities: ['memory:retention', 'memory:delete'],
        },
      ],
    });
    expect(event?.attribution?.delegationChain).toHaveLength(1);
    expect(BUREAU_MAINTENANCE_POLICY_REVISION).toBe('bureau:maintenance');
    expect(BUREAU_MAINTENANCE_MEMORY_CAPABILITIES).toEqual(['memory:retention', 'memory:delete']);
    // A run's chain still starts at the same principal, and still holds only the run grant.
    expect(DEFAULT_RUN_MEMORY_CAPABILITIES).toEqual(['memory:search', 'memory:write']);
    const runAuthority = createRunMemoryAuthority(
      {
        authority: {
          principalId: 'api-key:alice',
          tenantId: 'tenant',
          ownerId: 'owner',
          capabilities: ['tools:execute'],
          authorizationRevision: 'gateway:1',
        },
      },
      { runId: 'run-1', tenantId: BUREAU_ID, ownerId: 'alice' },
    );
    expect(runAuthority.capabilities).toEqual(['memory:search', 'memory:write']);
  });

  it('records no sweep event for a held record whose receipt is already waiting on the hold', async () => {
    const built = fixture();
    const { bureau } = await start(built);
    const heldId = await remember(built.memory, 'alice', 'alpha', 'Held and expired.');
    await built.memory.placeLegalHold(counsel, {
      id: heldId,
      collection: 'alpha',
      ownerId: 'alice',
    });
    await built.runtime.advance(91 * DAY);

    await bureau.runDurableMaintenance();
    // The first pass opened the held record's exempt receipt.
    expect(await sweptEvents(built)).toHaveLength(1);
    const receipts = await built.ledger.listReceipts({ tenantId: BUREAU_ID });
    expect(receipts.filter((receipt) => receipt.awaitingHoldRelease)).toHaveLength(1);

    await bureau.runDurableMaintenance();

    // Nothing else expired or prunable: the second pass has nothing to say.
    expect(await sweptEvents(built)).toHaveLength(1);
    expect(await contentsOf(built.memory, 'alice', 'alpha')).toEqual(['Held and expired.']);
  });
});

describe('overlapping maintenance passes share one sweep (COR-1629)', () => {
  /** A promise a test settles by hand. */
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('lets a manual pass join the sweep the automatic timer has in flight', async () => {
    const gate = deferred();
    const built = fixture({ gate: gate.promise });
    const { bureau, diagnostics } = await start(built, { manual: false });
    const recordId = await remember(built.memory, 'alice', 'alpha', 'An old answer.');

    // The timer fires while the record is expired and parks inside its sweep.
    await built.runtime.advance(91 * DAY);
    await waitForCondition(
      async () => built.calls.includes('sweepRetention'),
      'expected the automatic pass to start its sweep',
    );
    const manual = bureau.runDurableMaintenance();
    await Promise.resolve();
    expect(built.calls.filter((call) => call === 'sweepRetention')).toHaveLength(1);

    gate.release();
    expect(await manual).toBe(true);

    expect(built.calls.filter((call) => call === 'sweepRetention')).toHaveLength(1);
    const receipts = await built.ledger.listReceipts({ tenantId: BUREAU_ID });
    expect(receipts.map((receipt) => [receipt.record.id, receipt.trigger])).toEqual([
      [recordId, 'retention-expiry'],
    ]);
    expect(await contentsOf(built.memory, 'alice', 'alpha')).toEqual([]);
    expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
  });

  it('runs one sweep for two concurrent manual passes and reports a failure once', async () => {
    const gate = deferred();
    const built = fixture({
      gate: gate.promise,
      sweep: () => Promise.reject(new Error('ledger unavailable')),
    });
    const { bureau, diagnostics } = await start(built);

    const first = bureau.runDurableMaintenance();
    const second = bureau.runDurableMaintenance();
    await Promise.resolve();
    gate.release();
    expect(await Promise.all([first, second])).toEqual([true, true]);

    expect(built.calls.filter((call) => call === 'sweepRetention')).toHaveLength(1);
    // Each pass still advanced deletions, and the one sweep that failed was reported once.
    expect(built.calls.filter((call) => call === 'processDeletionPropagation')).toHaveLength(2);
    expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toHaveLength(1);

    // The sweep is no longer in flight, so the next pass starts a fresh one.
    await bureau.runDurableMaintenance();
    expect(built.calls.filter((call) => call === 'sweepRetention')).toHaveLength(2);
  });
});

describe('a full collection accepts writes again after a maintenance pass (COR-1629)', () => {
  it('rejects the answer with quota-exceeded before a pass and stores it after one', async () => {
    const built = fixture({ maxRecordsPerCollection: 3 });
    const generate: GenerateFunction = async () => ({
      content: 'The newest answer.',
      toolCalls: [],
    });
    const { bureau, diagnostics } = await start(built, {
      agents: { alpha: createAgent({ generate }) },
    });
    for (const content of ['One.', 'Two.', 'Three.']) {
      await remember(built.memory, 'api-key:alice', 'alpha', content);
    }
    await built.runtime.advance(91 * DAY);

    const chat = async (sessionId: string) => {
      const run = await bureau.tasks.start('alpha', 'Anything new?', {
        contextId: sessionId,
        principal: 'api-key:alice',
      });
      await waitForTaskState(bureau, run.id);
    };

    await chat('chat-1');
    expect(
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.scope === 'memory' && diagnostic.message.includes('quota-exceeded'),
      ),
    ).toHaveLength(1);
    expect(await contentsOf(built.memory, 'api-key:alice', 'alpha')).toEqual([
      'One.',
      'Three.',
      'Two.',
    ]);

    await bureau.runDurableMaintenance();
    expect(await contentsOf(built.memory, 'api-key:alice', 'alpha')).toEqual([]);

    await chat('chat-2');
    expect(await contentsOf(built.memory, 'api-key:alice', 'alpha')).toEqual([
      'The newest answer.',
    ]);

    // The runs wrote under their own authority, which never held a retention or delete capability.
    const admitted = await built.ledger.listEvents({
      tenantId: BUREAU_ID,
      type: 'memory.write.admitted',
    });
    const runWrites = admitted.filter((event) => event.attribution?.principal.kind === 'run');
    expect(runWrites.length).toBeGreaterThan(0);
    for (const event of runWrites) {
      expect(event.attribution?.capabilities).not.toContain('memory:retention');
      expect(event.attribution?.capabilities).not.toContain('memory:delete');
    }
  });
});

describe('a failing retention sweep is isolated (COR-1629)', () => {
  const refused = (
    status: 'denied' | 'rejected',
    reason?: string,
  ): (() => Promise<MemoryRetentionSweep>) => {
    return async () => ({
      operationId: 'operation',
      status,
      ...(reason === undefined ? {} : { reason }),
      dryRun: false,
      policyRevision: 'governance:retention-sweep',
      expired: [],
      deletionIds: [],
      prunedEvents: 0,
      prunedReceipts: 0,
      prunedDerivations: 0,
    });
  };
  const failures: [string, () => Promise<MemoryRetentionSweep>][] = [
    ['throws', () => Promise.reject(new Error('ledger unavailable'))],
    ['is denied', refused('denied')],
    ['is rejected', refused('rejected', 'candidate-policy-requires-dry-run')],
  ];

  for (const [name, sweep] of failures) {
    it(`reports one error diagnostic per pass and still runs the rest of the pass when the sweep ${name}`, async () => {
      const built = fixture({ sweep });
      const { bureau, diagnostics } = await start(built);

      expect(await bureau.runDurableMaintenance()).toBe(true);
      expect(await bureau.runDurableMaintenance()).toBe(true);

      const errors = diagnostics.filter((diagnostic) => diagnostic.level === 'error');
      expect(errors).toHaveLength(2);
      expect(errors.every((diagnostic) => diagnostic.scope === 'durable-maintenance')).toBe(true);
      expect(
        errors.every((diagnostic) => diagnostic.message.includes('memory retention sweep')),
      ).toBe(true);
      // Deletion propagation still ran after the failed sweep, once per pass.
      expect(built.calls).toEqual([
        'sweepRetention',
        'processDeletionPropagation',
        'sweepRetention',
        'processDeletionPropagation',
      ]);
    });
  }
});

describe('a Bureau without governed memory (COR-1629)', () => {
  it('builds no maintenance authority and sweeps nothing', async () => {
    const built = fixture();
    const { bureau, diagnostics } = await start(built, { withoutMemory: true });
    await remember(built.memory, 'alice', 'alpha', 'An old answer.');
    await built.runtime.advance(91 * DAY);

    expect(bureau.memory).toBeUndefined();
    await bureau.runDurableMaintenance();

    expect(built.calls).toEqual([]);
    expect(await contentsOf(built.memory, 'alice', 'alpha')).toEqual(['An old answer.']);
    expect(diagnostics).toEqual([]);
  });
});
