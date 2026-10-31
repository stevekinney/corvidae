/**
 * COR-1911 — `bureau.agents.try` builds an agent from a definition that is not saved and starts a
 * throwaway context with it. It answers, writes no memory and no agent file, cannot schedule,
 * start a child or write memory, and is gone with its context.
 */
import { readdir } from 'node:fs/promises';

import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  type GovernedMemory,
  createMemoryVectorStore,
  createTestEmbedders,
} from '@lostgradient/memory';
import { MemoryStorage, textValueStore, type Storage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileError } from './agent-file';
import { isTryAgentName, tryToolProblem } from './agent-try';
import { createAgent } from '@lostgradient/operative';
import { BureauError, createBureau, UnknownScheduleAgentError } from './create-bureau';
import { SESSION_AGENT_DEFINITION_HASH_METADATA_KEY } from './runtime-composition';
import { runTask, taskContent, waitForCondition, waitForTaskState } from './test';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import {
  type FileBureauHarness,
  type Observation,
  startFileBureau,
} from './testing/agent-file-bureau.test-support';
import type { Bureau, BureauDiagnostic, TryAgentResult } from './types';

const harnesses: FileBureauHarness[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function start(options?: Parameters<typeof startFileBureau>[0]) {
  const harness = await startFileBureau(options);
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const MODEL = 'claude-opus-5-5';
const DEFINITION = {
  name: 'Sketch',
  model: KNOWN_MODEL,
  tools: ['lookup-order'],
  instructions: 'You are a sketch of an agent.\n',
};
const ALICE = 'alice';

/** Every key the storage holds, sorted. */
async function keysOf(storage: Storage): Promise<string[]> {
  const keys: string[] = [];
  if (storage.keys === undefined) throw new Error('Expected a storage that lists its keys.');
  for await (const key of storage.keys('')) keys.push(key);
  return keys.toSorted();
}

/** The keys the storage holds now that `before` did not. */
async function keysAddedSince(storage: Storage, before: readonly string[]): Promise<string[]> {
  const now = await keysOf(storage);
  return now.filter((key) => !before.includes(key));
}

/** The files in an agent directory that are not dotfiles. */
async function filesIn(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => !name.startsWith('.')).toSorted();
}

/** A governed memory that counts the writes it is asked for. */
function countingMemory() {
  const memory = createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage(),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    ...createTestEmbedders(createMockEmbedder(64), 64),
    vectors: createMemoryVectorStore(new MemoryStorage()),
    policy: createMemoryGovernancePolicy({ revision: 'governance:agent-try' }),
    propagation: { caches: 'not-retained', 'managed-asset-bytes': 'not-retained' },
  });
  const calls = { writes: 0, searches: 0 };
  const served: GovernedMemory = {
    ...memory,
    init: () => memory.init(),
    close: () => memory.close(),
    write: (...parameters: Parameters<GovernedMemory['write']>) => {
      calls.writes += 1;
      return memory.write(...parameters);
    },
    search: (...parameters: Parameters<GovernedMemory['search']>) => {
      calls.searches += 1;
      return memory.search(...parameters);
    },
  };
  return { served, calls };
}

/** Sends a follow-up to a tried chat and waits for its answer. */
async function followUp(bureau: Bureau, tried: TryAgentResult, message: string, principal = ALICE) {
  const task = await bureau.tasks.start(tried.agentName, message, {
    contextId: tried.contextId,
    principal,
  });
  return taskContent(task);
}

function lastObserved(observed: readonly Observation[]): Observation {
  const last = observed.at(-1);
  if (last === undefined) throw new Error('Expected the model to have been called.');
  return last;
}

describe('trying an unsaved agent definition (COR-1911)', () => {
  it('answers in a new context whose origin is try, and writes no agent file', async () => {
    const harness = await start({ scripts: { [MODEL]: () => 'a sketch answers' } });
    const { bureau, directory } = harness;
    const before = await filesIn(directory);

    const tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });

    expect(isTryAgentName(tried.agentName)).toBe(true);
    const task = await bureau.tasks.get(tried.taskId);
    expect(task).toMatchObject({ contextId: tried.contextId, agentName: tried.agentName });
    await waitForTaskState(bureau, tried.taskId);
    expect(await followUp(bureau, tried, 'again')).toBe('a sketch answers');
    const context = await bureau.contexts.get(tried.contextId);
    expect(context?.agentName).toBe(tried.agentName);
    expect(context?.metadata['sessionOrigin']).toBe('try');
    expect(await filesIn(directory)).toEqual(before);
    expect(bureau.agents.list().map((listing) => listing.id)).not.toContain(tried.agentName);
    expect(bureau.agents.find(tried.agentName)).toBeUndefined();
  });

  it('runs the definition it was given: its instructions and its tools', async () => {
    const harness = await start();

    const tried = await harness.bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await waitForTaskState(harness.bureau, tried.taskId);

    expect(lastObserved(harness.observed)).toMatchObject({
      model: MODEL,
      systemPrompt: expect.stringContaining('a sketch of an agent'),
    });
    expect(lastObserved(harness.observed).tools).toContain('lookup-order');
  });

  it('refuses a definition that would not load as a file, naming the field, and creates nothing', async () => {
    const storage = new MemoryStorage();
    const harness = await start({ overrides: { storage } });
    const { bureau } = harness;
    const before = await keysOf(storage);

    const wrongModel = await rejectionOf(
      bureau.agents.try({ ...DEFINITION, model: 'anthropic/no-such-model' }, 'hi', {
        principal: ALICE,
      }),
    );
    const wrongTool = await rejectionOf(
      bureau.agents.try({ ...DEFINITION, tools: ['lookup-order', 'no-such-tool'] }, 'hi', {
        principal: ALICE,
      }),
    );
    const wrongStepLimit = await rejectionOf(
      bureau.agents.try({ ...DEFINITION, stepLimit: 0 }, 'hi', { principal: ALICE }),
    );

    for (const error of [wrongModel, wrongTool, wrongStepLimit]) {
      expect(error).toBeInstanceOf(AgentFileError);
    }
    expect((wrongModel as AgentFileError).code).toBe('unknown-model');
    expect((wrongModel as AgentFileError).problem?.issues?.map((issue) => issue.path)).toEqual([
      'model',
    ]);
    expect((wrongTool as AgentFileError).problem?.issues?.map((issue) => issue.path)).toEqual([
      'tools.1',
    ]);
    expect((wrongStepLimit as AgentFileError).problem?.issues?.[0]?.path).toBe('stepLimit');
    expect(await keysOf(storage)).toEqual(before);
    expect(await bureau.contexts.list()).toEqual([]);
  });

  it('refuses references, which name documents beside an agent file there is none of', async () => {
    const harness = await start();

    const error = await rejectionOf(
      harness.bureau.agents.try({ ...DEFINITION, references: ['notes.md'] }, 'hi'),
    );

    expect(error).toBeInstanceOf(AgentFileError);
    expect((error as AgentFileError).problem?.issues?.[0]?.path).toBe('references');
  });

  it('is a Bureau without an agent source that cannot try a definition', async () => {
    const bureau = await createBureau({
      agents: {
        alpha: createAgent({ generate: async () => ({ content: 'alpha', toolCalls: [] }) }),
      },
    });
    cleanups.push(() => bureau.dispose());

    const error = await rejectionOf(bureau.agents.try(DEFINITION, 'hi'));

    expect(error).toBeInstanceOf(AgentFileError);
    expect((error as AgentFileError).code).toBe('agent-directory-not-configured');
  });
});

describe('what a tried run cannot do (COR-1911)', () => {
  it.each([
    ['memory_store', 'writes memory'],
    ['memory_forget', 'writes memory'],
    ['scheduleSelf', 'schedules work'],
    ['scheduleWakeup', 'schedules work'],
    ['bureau:workflows-create', 'workflows'],
    ['bureau:workflows-pause', 'workflows'],
    ['settings-update', 'settings'],
    ['transfer_to_billing', 'hands the conversation'],
  ])('refuses the tool %s, naming its place in the definition', async (tool, reason) => {
    const harness = await start();
    const before = await harness.bureau.contexts.list();

    const error = await rejectionOf(
      harness.bureau.agents.try({ ...DEFINITION, tools: ['lookup-order', tool] }, 'hi', {
        principal: ALICE,
      }),
    );

    expect(error).toBeInstanceOf(AgentFileError);
    const issues = (error as AgentFileError).problem?.issues ?? [];
    expect(issues.map((issue) => issue.path)).toEqual(['tools.1']);
    expect(issues[0]?.message).toContain(reason);
    expect(await harness.bureau.contexts.list()).toEqual(before);
  });

  it('reports every refused tool, not only the first', () => {
    const problem = tryToolProblem({
      model: KNOWN_MODEL,
      instructions: '',
      tools: ['memory_store', 'lookup-order', 'scheduleSelf'],
    });

    expect(problem?.issues?.map((issue) => issue.path)).toEqual(['tools.0', 'tools.2']);
  });

  it('writes no memory, where the same definition saved as a file does', async () => {
    const control = countingMemory();
    const tried = countingMemory();
    const saved = await start({ overrides: { id: 'agent-try-saved', memory: control.served } });
    await saved.put(
      'sketch.md',
      `---\nname: Sketch\nmodel: ${KNOWN_MODEL}\n---\nYou are a sketch of an agent.\n`,
    );
    await saved.bureau.agents.refresh();
    await runTask(saved.bureau, 'sketch', 'hello', { principal: ALICE });
    expect(control.calls.writes).toBeGreaterThan(0);

    const harness = await start({ overrides: { id: 'agent-try-tried', memory: tried.served } });
    const result = await harness.bureau.agents.try(
      { name: 'Sketch', model: KNOWN_MODEL, instructions: 'You are a sketch of an agent.\n' },
      'hello',
      { principal: ALICE },
    );
    await followUp(harness.bureau, result, 'and again');

    expect(tried.calls.writes).toBe(0);
    expect(tried.calls.searches).toBe(0);
  });

  it('is offered neither scheduleWakeup nor decide, where a saved agent is offered both', async () => {
    const harness = await start();
    await harness.put(
      'sketch.md',
      `---\nname: Sketch\nmodel: ${KNOWN_MODEL}\n---\nYou are a sketch of an agent.\n`,
    );
    await harness.bureau.agents.refresh();
    await runTask(harness.bureau, 'sketch', 'hello', { principal: ALICE });
    const savedTools = lastObserved(harness.observed).tools;
    expect(savedTools).toContain('scheduleWakeup');
    expect(savedTools).toContain('decide');

    const tried = await harness.bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await followUp(harness.bureau, tried, 'again');

    const triedTools = lastObserved(harness.observed).tools;
    expect(triedTools).toContain('lookup-order');
    expect(triedTools).not.toContain('scheduleWakeup');
    expect(triedTools).not.toContain('decide');
  });

  it('cannot be the parent of a child run, whatever asks', async () => {
    const harness = await start();
    const tried = await harness.bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });

    const dispatched = await harness.bureau.children.dispatch({
      parentRunId: tried.taskId,
      agentName: 'alpha',
      input: 'work',
    });

    expect(dispatched.outcome).toBe('not-found');
    expect(await harness.bureau.children.list(tried.taskId)).toEqual([]);
  });

  it('cannot be scheduled, run by another owner, or given a second context', async () => {
    const harness = await start();
    const { bureau } = harness;
    const tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });

    const scheduled = await rejectionOf(
      bureau.schedules.create({ agentName: tried.agentName, input: 'x', spec: '1m' }),
    );
    // Another owner cannot run it, and it cannot start a second context of its own.
    const other = await rejectionOf(
      bureau.tasks.start(tried.agentName, 'hello', {
        contextId: tried.contextId,
        principal: 'bob',
      }),
    );
    const elsewhere = await rejectionOf(
      bureau.tasks.start(tried.agentName, 'hello', { principal: ALICE }),
    );

    expect(scheduled).toBeInstanceOf(UnknownScheduleAgentError);
    for (const error of [other, elsewhere]) {
      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('NOT_FOUND');
    }
    expect(bureau.agents.find(tried.agentName)).toBeUndefined();
    expect(await bureau.contexts.list({ origin: 'try' })).toHaveLength(1);
  });
});

describe('continuing a tried chat (COR-1911)', () => {
  it('cannot be branched, because the branch would have no agent to run', async () => {
    const harness = await start();
    const { bureau } = harness;
    const tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await waitForTaskState(bureau, tried.taskId);

    const error = await rejectionOf(
      bureau.contexts.fork(tried.contextId, {
        owner: ALICE,
        commandId: 'fork-1',
        throughMessageId: null,
      }),
    );

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');
    expect(await bureau.contexts.list({ origin: 'chat' })).toEqual([]);
  });
});

describe('deleting a tried chat (COR-1911)', () => {
  async function deleted(bureau: Bureau, contextId: string) {
    const report = await bureau.contexts.delete(contextId);
    expect(report.deleted).toBe(true);
  }

  /**
   * What a deleted chat may leave in storage, by key prefix. The same as a deleted chat of any
   * other origin leaves (COR-1934 purges its content):
   *
   * - `audit:v1:` and `audit-sequence:v1:`: the audit trail's entries and its counter. Its entries
   *   stay, with their content redacted, and the `session.deleted` entry stays.
   * - `fleet-event:`, `fleet-event-by-workflow:` and `fleet-event-tail`: on a persistent store
   *   only the `session.deleted` event, which holds no content, and the feed's tail. A store
   *   opened as ephemeral writes none of it, so on MemoryStorage these are absent.
   * - `outbox-dedupe:session:`: the deletion marker of that one event.
   * - `agent-session-outbox:v1:ordinal`: the session outbox's counter.
   * - `wf-gen:` and `wf-owner-epoch:`: the engine's tombstones, which keep a run id from being
   *   used twice.
   * - `chat-content-purge-pending:v1:`: the finished purge's record, kept settled until the second
   *   pass takes a run admitted after the delete began.
   * - `chat-content-purge-tombstone:v1:`: each run's fence, which a late write of its process is
   *   refused by (the run id and when it was purged), kept as long as the audit retention.
   * - `appmbx:`: the chat's purged input mailbox keeps its header, sealed, so an admission that
   *   raced the purge is refused rather than recreating the mailbox.
   */
  const KEPT = [
    'audit:v1:',
    'audit-sequence:v1:',
    'fleet-event:',
    'fleet-event-by-workflow:',
    'fleet-event-tail',
    'outbox-dedupe:session:',
    'agent-session-outbox:v1:ordinal',
    'wf-gen:',
    'wf-owner-epoch:',
    'chat-content-purge-pending:v1:',
    'chat-content-purge-tombstone:v1:',
    'appmbx:',
  ];

  /** The prefixes of the keys that are the chat, its runs, its tasks, its workflow and its agent. */
  const GONE = [
    'agent-session-v2',
    'bureau-task:v1:',
    'bureau-task-context:v1:',
    'durable-run:',
    'ev:',
    'steering-log:v1:',
    'wf:',
    'wf-cleanup',
    'wf-has-services:',
    'wf-terminal:',
    'tag:',
  ];

  /** Starts a chat, answers it twice, deletes it, and reads what storage kept. */
  async function deleteAnsweredChat(storage: Storage) {
    const harness = await start({
      overrides: { storage, durable: true, durableOwnership: { ownership: 'none' } },
    });
    const { bureau, directory } = harness;
    const keysBefore = await keysOf(storage);
    const filesBefore = await filesIn(directory);

    const tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await waitForTaskState(bureau, tried.taskId);
    await followUp(bureau, tried, 'once more');
    const created = await keysAddedSince(storage, keysBefore);
    expect(created.some((key) => key.includes(tried.contextId))).toBe(true);

    await deleted(bureau, tried.contextId);

    const left = await keysAddedSince(storage, keysBefore);
    expect(left.filter((key) => !KEPT.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    expect(left.filter((key) => GONE.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    expect(await filesIn(directory)).toEqual(filesBefore);
    expect(await bureau.contexts.get(tried.contextId)).toBeUndefined();
    expect(await bureau.tasks.get(tried.taskId)).toBeUndefined();
    expect(bureau.tasks.detail(tried.taskId)).toBeUndefined();
    const error = await rejectionOf(
      bureau.tasks.start(tried.agentName, 'again', {
        contextId: tried.contextId,
        principal: ALICE,
      }),
    );
    expect((error as BureauError).code).toBe('NOT_FOUND');
    return { left, created, tried };
  }

  it('leaves no storage key, no file and no listing that the chat created', async () => {
    await deleteAnsweredChat(new MemoryStorage());
  });

  it('on a persistent store, leaves only redacted audit entries and the deletion marker of the chat', async () => {
    const fixture = createSqliteStorageFixture();
    cleanups.push(() => fixture.dispose());
    const { left, created } = await deleteAnsweredChat(fixture.storage);

    // Every kind of key that is the chat was written, so its absence above is a deletion.
    for (const prefix of GONE) expect(created.some((key) => key.startsWith(prefix))).toBe(true);

    // The audit entries stay, and of the durable event history only the session's deletion marker.
    expect(left.some((key) => key.startsWith('audit:v1:'))).toBe(true);
    expect(left.filter((key) => key.startsWith('fleet-event:'))).toHaveLength(1);
    expect(left.filter((key) => key.startsWith('fleet-event-by-workflow:'))).toHaveLength(1);
    expect(left.filter((key) => key.startsWith('outbox-dedupe:session:'))).toEqual([
      expect.stringContaining(':session.deleted:'),
    ]);
  });

  it('writes no agent definition, snapshot, revision or version while it lives', async () => {
    const storage = new MemoryStorage();
    const harness = await start({ overrides: { storage } });
    const keysBefore = await keysOf(storage);

    const tried = await harness.bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await waitForTaskState(harness.bureau, tried.taskId);

    const created = await keysAddedSince(storage, keysBefore);
    const definitionPrefixes = [
      'bureau-agent-revision:v1:',
      'bureau-agent-run:v1:',
      'bureau-agent-snapshot:v1:',
      'bureau-agent-version:v1:',
    ];
    expect(created.filter((key) => definitionPrefixes.some((p) => key.startsWith(p)))).toEqual([]);
    expect(created.filter((key) => key.includes(tried.agentName))).toEqual([]);
    const session = await harness.bureau.contexts.get(tried.contextId);
    expect(session?.metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY] ?? null).toBeNull();
  });

  it('leaves nothing either when the chat is deleted while its run is working', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const storage = new MemoryStorage();
    const harness = await start({
      overrides: { storage },
      scripts: {
        [MODEL]: async () => {
          entered();
          await gate;
          return 'too late';
        },
      },
    });
    const { bureau } = harness;
    const keysBefore = await keysOf(storage);
    const tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await started;

    const deletion = bureau.contexts.delete(tried.contextId);
    release();
    const report = await deletion;
    await Promise.all(report.tasks.map((task) => task.closed));

    expect(report.deleted).toBe(true);
    const left = await keysAddedSince(storage, keysBefore);
    expect(left.filter((key) => !KEPT.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    expect(await bureau.tasks.get(tried.taskId)).toBeUndefined();
  });

  it('cannot be started again under its id the moment the delete commits', async () => {
    // The session store's delete has committed when `session.deleted` is raised, and the agent
    // must be gone by then, or its owner could recreate the id, a context nothing would clean up.
    const attempts: Promise<unknown>[] = [];
    let tried: TryAgentResult | undefined;
    const harness = await start({
      overrides: {
        onEvent: (event) => {
          if (event.type !== 'session.deleted' || tried === undefined) return;
          attempts.push(
            rejectionOf(
              harness.bureau.tasks.start(tried.agentName, 'again', {
                contextId: tried.contextId,
                principal: ALICE,
              }),
            ),
          );
        },
      },
    });
    const { bureau } = harness;
    tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await waitForTaskState(bureau, tried.taskId);

    await deleted(bureau, tried.contextId);

    expect(attempts).toHaveLength(1);
    const error = await attempts[0];
    expect((error as BureauError).code).toBe('NOT_FOUND');
    expect(await bureau.contexts.get(tried.contextId)).toBeUndefined();
    expect(await bureau.contexts.list({ origin: 'chat' })).toEqual([]);
  });

  it('drops the agent, so the chat cannot be continued once deleted', async () => {
    const harness = await start();
    const { bureau } = harness;
    const tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await deleted(bureau, tried.contextId);

    const error = await rejectionOf(
      bureau.tasks.start(tried.agentName, 'hello', {
        contextId: tried.contextId,
        principal: ALICE,
      }),
    );

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('NOT_FOUND');
  });
});

describe('a tried run that a restart interrupts (COR-1911)', () => {
  it('is listed as a failed run, and a diagnostic says the agent was held in memory only', async () => {
    const fixture = createSqliteStorageFixture();
    cleanups.push(() => fixture.dispose());
    const diagnostics: BureauDiagnostic[] = [];
    const hold = new Promise<never>(() => undefined);
    const overrides = {
      durable: true,
      durableOwnership: { ownership: 'none' as const },
      maintenance: 'manual' as const,
      onDiagnostic: (diagnostic: BureauDiagnostic) => void diagnostics.push(diagnostic),
      // Each Bureau these options open gets its own handle on the store.
      get storage() {
        return fixture.open();
      },
    };
    const first = await start({ scripts: { [MODEL]: () => hold }, overrides });
    const tried = await first.bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await waitForCondition(() => first.observed.length > 0, 'the tried run is calling the model');

    const second = await start({ scripts: { [MODEL]: () => 'resumed' }, overrides });
    const report = await second.bureau.recovery();

    expect(report?.perRunFailures.map((failure) => failure.runId)).toEqual([tried.taskId]);
    const named = diagnostics.filter(
      (diagnostic) =>
        diagnostic.scope === 'agent-try' &&
        diagnostic.message.includes('try agent not reconstructable after restart') &&
        diagnostic.message.includes(tried.taskId),
    );
    expect(named).toHaveLength(1);
    expect(named[0]?.level).toBe('warn');
  });
});

describe('deleting a tried chat after a restart (COR-1911)', () => {
  it('removes the tasks the run store and the ownership map no longer name', async () => {
    const fixture = createSqliteStorageFixture();
    cleanups.push(() => fixture.dispose());
    const overrides = {
      durable: true,
      durableOwnership: { ownership: 'none' as const },
      maintenance: 'manual' as const,
      onDiagnostic: () => undefined,
      get storage() {
        return fixture.open();
      },
    };
    const first = await start({ overrides });
    const tried = await first.bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });
    await waitForTaskState(first.bureau, tried.taskId);
    await followUp(first.bureau, tried, 'once more');

    // The second Bureau holds no run of the first, and the context no longer names its runs'
    // owners, as it does once their event history has expired.
    const kv = textValueStore(fixture.storage);
    const [sessionKey] = await kv.list('agent-session-v2');
    const raw = sessionKey === undefined ? null : await kv.get(sessionKey);
    if (sessionKey === undefined || raw === null) throw new Error('Expected the tried session.');
    const stored = JSON.parse(raw) as { metadata: Record<string, unknown> };
    expect(Object.keys(stored.metadata)).toContain('lastRunOwningPrincipals');
    delete stored.metadata['lastRunOwningPrincipals'];
    await kv.set(sessionKey, JSON.stringify(stored));
    const second = await start({ overrides });
    const inherited = await second.bureau.tasks.get(tried.taskId);
    expect(inherited?.id).toBe(tried.taskId);

    await second.bureau.contexts.delete(tried.contextId);

    expect(await second.bureau.tasks.get(tried.taskId)).toBeUndefined();
    const left = await keysOf(fixture.storage);
    expect(left.filter((key) => key.startsWith('bureau-task'))).toEqual([]);
  });
});

describe('where a tried chat is listed (COR-1911)', () => {
  it('is left out of the contexts and the tasks unless asked for', async () => {
    const harness = await start();
    const { bureau } = harness;
    await runTask(bureau, 'alpha', 'a chat', { principal: ALICE });
    const tried = await bureau.agents.try(DEFINITION, 'hello', { principal: ALICE });

    const contexts = await bureau.contexts.list();
    const tries = await bureau.contexts.list({ origin: 'try' });
    const tasks = await bureau.internals.taskRegistry.enumerate({ limit: 50, offset: 0 });
    const triedTasks = await bureau.internals.taskRegistry.enumerate({
      contextId: tried.contextId,
      limit: 50,
      offset: 0,
    });

    expect(contexts.map((context) => context.id)).not.toContain(tried.contextId);
    expect(contexts).toHaveLength(1);
    expect(tries.map((context) => context.id)).toEqual([tried.contextId]);
    expect(tasks.tasks.map((view) => view.agentName)).not.toContain(tried.agentName);
    expect(triedTasks.tasks.map((view) => view.id)).toEqual([tried.taskId]);
  });
});
