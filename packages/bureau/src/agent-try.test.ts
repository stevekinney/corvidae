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
} from '@lostgradient/memory';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileError } from './agent-file';
import { isTryAgentName, tryToolProblem } from './agent-try';
import { createAgent } from '@lostgradient/operative';
import { BureauError, createBureau, UnknownScheduleAgentError } from './create-bureau';
import { SESSION_AGENT_DEFINITION_HASH_METADATA_KEY } from './runtime-composition';
import { runTask, taskContent, waitForTaskState } from './test';
import { KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import {
  type FileBureauHarness,
  type Observation,
  startFileBureau,
} from './testing/agent-file-bureau.test-support';
import type { Bureau, TryAgentResult } from './types';

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
async function keysOf(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.keys('')) keys.push(key);
  return keys.toSorted();
}

/** The keys the storage holds now that `before` did not. */
async function keysAddedSince(
  storage: MemoryStorage,
  before: readonly string[],
): Promise<string[]> {
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
    embedder: createMockEmbedder(64),
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
    ['workflows-create', 'workflows'],
    ['workflows-pause', 'workflows'],
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
   * What a deleted chat may leave in storage, by key prefix: the audit trail's evidence and its
   * counter, and the engine's tombstones, which keep a run id from being used twice, and the
   * session outbox's counter. None of them holds the chat, its agent, or what the agent said.
   */
  const KEPT = [
    'audit:v1:',
    'audit-sequence:v1:',
    'agent-session-outbox:v1:ordinal',
    'wf-gen:',
    'wf-owner-epoch:',
    // The sweep's index of a retired session's mailbox, removed once retention has emptied it.
    'session-input-open:v2:',
  ];

  it('leaves no storage key, no file and no listing that the chat created', async () => {
    const storage = new MemoryStorage();
    const harness = await start({ overrides: { storage } });
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
    expect(await filesIn(directory)).toEqual(filesBefore);
    expect(await bureau.contexts.get(tried.contextId)).toBeUndefined();
    expect(await bureau.tasks.get(tried.taskId)).toBeUndefined();
    expect(bureau.tasks.detail(tried.taskId)).toBeUndefined();
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
