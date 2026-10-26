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

import {
  createGovernedMemory,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  createWeftMemoryRecordStorage,
  type MemoryGovernanceNotification,
} from '@lostgradient/memory';
import {
  createAgent,
  createMockGenerate,
  stopWhen,
  waitForRunState,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import { createBureau } from './index';
import type { AgentDefinitions } from './agent-catalog';

/**
 * Where a run's memory lives (COR-1546): the Bureau's identifier is the tenant, the run's owner of
 * record is the owner (`anonymous:local` when a run names none), and the agent is the collection.
 * Every Bureau below is created with this identifier.
 */
const BUREAU_ID = 'bureau';
const LOCAL_OWNER = 'anonymous:local';
const DEFAULT_AGENT = 'default';

let databasePath = '';

beforeEach(() => {
  // A fresh directory per test: the process id repeats across runs, so it cannot name the file.
  databasePath = createTemporaryPath('bureau-memory-governance-guide', '.sqlite');
});

afterEach(() => {
  removeTemporaryPath(databasePath);
});

/**
 * Governed memory that also collects every governance notification, from any
 * tenant, and awaits `onNotification` with each one when given.
 */
function governedMemory(
  onNotification?: (notification: MemoryGovernanceNotification) => Promise<void>,
) {
  const storage = new MemoryStorage();
  const notifications: MemoryGovernanceNotification[] = [];
  const memory = createGovernedMemory({
    storage: createWeftMemoryRecordStorage(storage),
    ledger: createMemoryGovernanceLedger(storage),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
    onEvent: async (notification) => {
      notifications.push(notification);
      await onNotification?.(notification);
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

    const bureau = await createBureau<AgentDefinitions>({
      id: 'acme', // the tenant: memory is partitioned by the Bureau's identifier
      agents: {
        default: createAgent({
          generate: createMockGenerate([{ content: 'Booked seat 14C for Alice.', toolCalls: [] }]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      memory,
      // A caller-supplied request authority is re-validated before every run.
      requestAuthorityValidator: () => true,
    });

    const run = await bureau.createRun({
      agentName: 'default',
      message: 'Book the 9:40 to Denver.',
      principal: 'alice', // the run's owner of record, whose partition its memory is written to
      sessionId: 'session-42', // the memory belongs to the agent, so every chat of Alice's shares it
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
    const [stored] = await bureau.memory!.list(auditor, { collection: 'default' }); // the agent's name
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
  it('partitions a run’s memory by the Bureau’s identifier and its owner of record, in its agent’s collection', async () => {
    const { memory } = governedMemory();
    const bureau = await createBureau<AgentDefinitions>({
      id: BUREAU_ID,
      agents: {
        default: createAgent({
          generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      memory,
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Remember this.',
        sessionId: 'session-1',
      });
      await waitForRunState(bureau, run.id);
      const [stored] = await memory.list(auditorFor(BUREAU_ID, LOCAL_OWNER), {
        collection: DEFAULT_AGENT,
      });
      expect(stored?.governance?.attribution).toMatchObject({
        principal: { kind: 'run', id: run.id },
        tenantId: BUREAU_ID,
        ownerId: LOCAL_OWNER,
      });
      // The collection is the agent, so the chat that wrote the record is named in its metadata.
      expect(stored?.metadata['sessionId']).toBe('session-1');
    } finally {
      await bureau.dispose();
    }
  });

  it('writes a createRun answer with a <runId>:<step> dedupe key under a service principal with id bureau', async () => {
    const { memory } = governedMemory();
    const bureau = await createBureau<AgentDefinitions>({
      id: BUREAU_ID,
      agents: {
        default: createAgent({
          generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      memory,
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Remember this.',
        sessionId: 'session-1',
      });
      await waitForRunState(bureau, run.id);
      const [stored] = await memory.list(auditorFor(BUREAU_ID, LOCAL_OWNER), {
        collection: DEFAULT_AGENT,
      });
      expect(stored?.metadata).toEqual({
        step: 0,
        replay: 'effectful',
        sessionId: 'session-1',
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
      const bureau = await createBureau<AgentDefinitions>({
        id: BUREAU_ID,
        agents: {
          default: createAgent({
            generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        memory,
      });
      try {
        const run = await bureau.createRun({
          agentName: 'default',
          message: 'Remember this.',
          sessionId: 'session-1',
        });
        const settled = await waitForRunState(bureau, run.id);
        expect(settled.status).toBe('error');
        const reader = createGovernedMemory({
          storage: createWeftMemoryRecordStorage(storage),
          ledger: createMemoryGovernanceLedger(storage),
          embedder: createMockEmbedder(64),
          policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
        });
        const stored = await reader.list(auditorFor(BUREAU_ID, LOCAL_OWNER), {
          collection: DEFAULT_AGENT,
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
        const bureau = await createBureau<AgentDefinitions>({
          id: BUREAU_ID,
          agents: {
            default: createAgent({
              generate: createMockGenerate([{ content: 'Noted.', toolCalls: [] }]),
              stopWhen: stopWhen.noToolCalls(),
            }),
          },
          memory,
          memoryAuthority:
            grant.runCapabilities === undefined ? {} : { runCapabilities: grant.runCapabilities },
          requestAuthorityValidator: () => true,
        });
        try {
          const run = await bureau.createRun({
            agentName: 'default',
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
            const auditor = auditorFor(BUREAU_ID, LOCAL_OWNER);
            expect(await memory.list(auditor, { collection: DEFAULT_AGENT })).toEqual([]);
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
        id: BUREAU_ID,
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
