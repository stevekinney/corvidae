/**
 * COR-1247 — executable copies of the governed-memory examples in this
 * package's README and in `documentation/memory-governance.md`, plus checks of
 * the limits those documents state.
 *
 * The example test reproduces the documented example as written, except that
 * `./index` stands in for `@lostgradient/bureau` and each `console.log`
 * becomes an assertion of the value its comment names. The limit tests check
 * what the documents say Bureau does not do. Change the examples and the
 * documentation together.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type MemoryGovernanceNotification,
  createGovernedMemory,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  createWeftMemoryRecordStorage,
} from '@lostgradient/memory';
import {
  createAgent,
  createMockGenerate,
  stopWhen,
  waitForCondition,
  waitForRunState,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './index';

const databasePath = join(tmpdir(), `bureau-memory-governance-guide-${process.pid}.sqlite`);

afterEach(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
});

/** Governed memory that also collects every governance notification, from any tenant. */
function governedMemory() {
  const storage = new MemoryStorage();
  const notifications: MemoryGovernanceNotification[] = [];
  const memory = createGovernedMemory({
    storage: createWeftMemoryRecordStorage(storage),
    ledger: createMemoryGovernanceLedger(storage),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
    onEvent: (notification) => {
      notifications.push(notification);
    },
  });
  return { memory, notifications };
}

/** Reads every record in one owner's collection, as a governance auditor. */
function auditorFor(tenantId: string, ownerId: string) {
  return createMemoryAuthority({
    principal: { kind: 'governance', id: 'governance:auditor' },
    tenantId,
    ownerId,
    purpose: 'audit',
    capabilities: ['memory:list', 'memory:inspect'],
    policyRevision: 'audit:1',
    projection: 'audit',
  });
}

describe('packages/bureau/README.md — Governed memory', () => {
  it('stores a run’s final answer under the run’s delegated authority', async () => {
    const storage = new MemoryStorage();
    const memory = createGovernedMemory({
      storage: createWeftMemoryRecordStorage(storage),
      ledger: createMemoryGovernanceLedger(storage),
      embedder: createMockEmbedder(64), // use a real embedder in production
      policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
    });

    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate([{ content: 'Booked seat 14C for Alice.', toolCalls: [] }]),
      stopWhen: stopWhen.noToolCalls(),
      memory,
      // A caller-supplied request authority is re-validated before every run.
      requestAuthorityValidator: () => true,
    });

    const run = await bureau.createRun({
      message: 'Book the 9:40 to Denver.',
      sessionId: 'session-42', // the memory collection this run recalls from and writes to
      requestContext: {
        authority: {
          principalId: 'user:alice',
          tenantId: 'acme',
          ownerId: 'alice',
          capabilities: ['tools:execute'],
          authorizationRevision: 'authorization:7',
        },
      },
    });
    await waitForRunState(bureau, run.id);

    // The host reads memory with its own authority, never with the run's.
    const auditor = createMemoryAuthority({
      principal: { kind: 'governance', id: 'governance:auditor' },
      tenantId: 'acme',
      ownerId: 'alice',
      purpose: 'audit',
      capabilities: ['memory:list', 'memory:inspect'],
      policyRevision: 'authorization:7',
      projection: 'audit',
    });
    const [stored] = await bureau.memory!.list(auditor, { collection: 'session-42' });
    expect(stored?.content).toBe('Booked seat 14C for Alice.'); // 'Booked seat 14C for Alice.'
    expect(stored?.source).toBe('conversation'); // 'conversation'
    expect(stored?.trust).toBe('untrusted'); // 'untrusted'
    expect(
      stored?.governance?.attribution.delegationChain.map((link) => link.principal.kind),
    ).toEqual(['service', 'user', 'run']); // ['service', 'user', 'run']

    await bureau.dispose();
  });
});

describe('documented Bureau memory limits', () => {
  it('gives a run without a request authority the default bureau partition', async () => {
    const { memory } = governedMemory();
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
      stopWhen: stopWhen.noToolCalls(),
      memory,
    });
    try {
      const run = await bureau.createRun({ message: 'Remember this.', sessionId: 'session-1' });
      await waitForRunState(bureau, run.id);
      const [stored] = await memory.list(auditorFor('bureau', 'bureau'), {
        collection: 'session-1',
      });
      expect(stored?.governance?.attribution).toMatchObject({
        principal: { kind: 'run', id: run.id },
        tenantId: 'bureau',
        ownerId: 'bureau',
      });
    } finally {
      await bureau.dispose();
    }
  });

  it('writes a createRun answer with a <runId>:<step> dedupe key under a service principal with id bureau', async () => {
    const { memory } = governedMemory();
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
      stopWhen: stopWhen.noToolCalls(),
      memory,
    });
    try {
      const run = await bureau.createRun({ message: 'Remember this.', sessionId: 'session-1' });
      await waitForRunState(bureau, run.id);
      const [stored] = await memory.list(auditorFor('bureau', 'bureau'), {
        collection: 'session-1',
      });
      expect(stored?.metadata).toEqual({
        step: 0,
        replay: 'effectful',
        dedupeKey: `${run.id}:0`,
      });
      expect(stored?.governance?.attribution.delegationChain.map((link) => link.principal)).toEqual(
        [
          { kind: 'service', id: 'bureau' },
          { kind: 'run', id: `run:${run.id}` },
          { kind: 'run', id: run.id },
        ],
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('writes a submitSchedulerTask answer with no dedupe key, as the task id, into the task id collection', async () => {
    const { memory } = governedMemory();
    const bureau = await createBureau({
      agents: {},
      generate: createMockGenerate([{ content: 'Scheduled answer.', toolCalls: [] }]),
      stopWhen: stopWhen.noToolCalls(),
      scheduler: { enabled: true, idleDelay: 1 },
      memory,
    });
    try {
      const { taskId } = await bureau.submitSchedulerTask({ message: 'Remember this.' });
      await waitForCondition(
        () => bureau.scheduler?.getState().completedCount === 1,
        'scheduled task did not complete',
      );
      const [stored] = await memory.list(auditorFor('bureau', 'bureau'), { collection: taskId });
      expect(stored?.content).toBe('Scheduled answer.');
      expect(stored?.metadata).toEqual({ step: 0, replay: 'effectful' });
      expect(stored?.governance?.attribution.delegationChain.map((link) => link.principal)).toEqual(
        [
          { kind: 'service', id: 'bureau' },
          { kind: 'service', id: 'service:scheduler' },
          { kind: 'run', id: taskId },
        ],
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('fails a run whose memory hook throws, even after the final answer was stored', async () => {
    const outcomes: Record<string, { error: unknown; stored: string[] }> = {};
    // An audit sink that throws on every event, or only on the final answer's admission.
    for (const failOn of ['every event', 'memory.write.admitted']) {
      const storage = new MemoryStorage();
      const memory = createGovernedMemory({
        storage: createWeftMemoryRecordStorage(storage),
        ledger: createMemoryGovernanceLedger(storage),
        embedder: createMockEmbedder(64),
        policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
        onEvent: (notification) => {
          if (failOn === 'every event' || notification.type === failOn) {
            throw new Error('audit sink down');
          }
        },
      });
      const bureau = await createBureau({
        agents: {},
        generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
        stopWhen: stopWhen.noToolCalls(),
        memory,
      });
      try {
        const run = await bureau.createRun({ message: 'Remember this.', sessionId: 'session-1' });
        const settled = await waitForRunState(bureau, run.id);
        expect(settled.status).toBe('error');
        const reader = createGovernedMemory({
          storage: createWeftMemoryRecordStorage(storage),
          ledger: createMemoryGovernanceLedger(storage),
          embedder: createMockEmbedder(64),
          policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
        });
        const stored = await reader.list(auditorFor('bureau', 'bureau'), {
          collection: 'session-1',
        });
        outcomes[failOn] = {
          error: JSON.parse(settled.error!),
          stored: stored.map((record) => record.content),
        };
      } finally {
        await bureau.dispose();
      }
    }
    // Step 0's recall throws, so the run ends before any answer is written.
    expect(outcomes['every event']).toEqual({
      error: expect.objectContaining({
        name: 'AgentRunError',
        kind: 'generate',
        message: 'audit sink down',
      }),
      stored: [],
    });
    // The final answer's write throws after storing it.
    expect(outcomes['memory.write.admitted']).toEqual({
      error: expect.objectContaining({
        name: 'AgentRunError',
        kind: 'policy',
        message: 'audit sink down',
      }),
      stored: ['Noted.'],
    });
  });

  // An empty grant, or explicit request capabilities that share nothing with it,
  // leaves both hooks attached: every run's recall and write are refused.
  const emptyGrants = [
    { name: 'runCapabilities: []', runCapabilities: [], requestCapabilities: undefined },
    {
      name: 'request memory capabilities disjoint from runCapabilities',
      runCapabilities: undefined,
      requestCapabilities: ['memory:delete'],
    },
  ] as const;
  for (const grant of emptyGrants) {
    it(`keeps both memory hooks attached under ${grant.name}, recording each refusal`, async () => {
      const outcomes: Record<string, { status: string; events: string[] }> = {};
      for (const sink of ['collecting', 'throwing'] as const) {
        const storage = new MemoryStorage();
        const events: string[] = [];
        const memory = createGovernedMemory({
          storage: createWeftMemoryRecordStorage(storage),
          ledger: createMemoryGovernanceLedger(storage),
          embedder: createMockEmbedder(64),
          policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
          onEvent: (notification) => {
            events.push(`${notification.type}:${notification.outcome}`);
            if (sink === 'throwing') throw new Error('audit sink down');
          },
        });
        const bureau = await createBureau({
          agents: {},
          generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
          stopWhen: stopWhen.noToolCalls(),
          memory,
          memoryAuthority:
            grant.runCapabilities === undefined ? {} : { runCapabilities: grant.runCapabilities },
          requestAuthorityValidator: () => true,
        });
        try {
          const run = await bureau.createRun({
            message: 'Remember this.',
            sessionId: 'session-1',
            ...(grant.requestCapabilities === undefined
              ? {}
              : {
                  requestContext: {
                    authority: {
                      principalId: 'user:alice',
                      tenantId: 'bureau',
                      ownerId: 'bureau',
                      capabilities: [...grant.requestCapabilities],
                      authorizationRevision: 'authorization:7',
                    },
                  },
                }),
          });
          const settled = await waitForRunState(bureau, run.id);
          outcomes[sink] = { status: settled.status, events: [...events] };
          if (sink === 'collecting') {
            // Nothing was written, and the ledger holds both refusals.
            const auditor = auditorFor('bureau', 'bureau');
            expect(await memory.list(auditor, { collection: 'session-1' })).toEqual([]);
            const denials = await memory.listEvents(auditor, { type: 'memory.access.denied' });
            expect(denials.map((event) => event.reason)).toEqual([
              'missing-capability',
              'missing-capability',
            ]);
          }
        } finally {
          await bureau.dispose();
        }
      }
      // The step-0 recall and the final write are each refused and passed to onEvent.
      expect(outcomes['collecting']).toEqual({
        status: 'completed',
        events: ['memory.access.denied:denied', 'memory.access.denied:denied'],
      });
      // A sink that throws still fails the run, on the first refusal.
      expect(outcomes['throwing']).toEqual({
        status: 'error',
        events: ['memory.access.denied:denied'],
      });
    });
  }

  for (const durability of ['in-memory', 'durable'] as const) {
    it(`attaches no memory hooks to a ${durability} catalog run dispatched through bureau.run`, async () => {
      const { memory, notifications } = governedMemory();
      const assistant = createAgent({
        name: 'assistant',
        generate: createMockGenerate([{ content: 'Catalog answer.', toolCalls: [] }]),
      });
      const bureau = await createBureau({
        agents: { assistant },
        memory,
        ...(durability === 'durable'
          ? { storage: { type: 'sqlite' as const, path: databasePath } }
          : {}),
      });
      try {
        const run = bureau.run('assistant', 'Remember this.');
        const result = await run.result();
        expect(result.content).toBe('Catalog answer.');
        expect(run.snapshot().durability === 'durable').toBe(durability === 'durable');
        // No recall, no write, no denial: governed memory never heard from the run.
        expect(notifications).toEqual([]);
      } finally {
        await bureau.dispose();
      }
    });
  }
});
