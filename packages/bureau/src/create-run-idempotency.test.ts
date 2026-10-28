/**
 * COR-424 — `createRun` through the command ledger, end to end: a retried
 * run-creation request with the same caller, agent, request id, and payload
 * returns the original run and receipt instead of creating a second run.
 *
 * Receipts are offered only by a bureau whose runs survive a restart, so
 * every ledgered scenario here runs a durable bureau over SQLite.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  type RunResult,
  stopWhen,
  waitForCondition,
} from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { BureauLedgerConflictError } from './command-ledger';
import { BureauError, createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { Bureau, BureauOptions } from './types';
import { startTaskFrom } from './test/task-start-request.ts';
import { listHeldTasks } from './test';

const ORIGIN = '2026-10-13T00:00:00.000Z';

/** A generate that holds every run at its first step until `release()`. */
function heldGenerate(): { generate: GenerateFunction; release(): void } {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    generate: async () => {
      await released;
      return { content: 'done', toolCalls: [] };
    },
    release: () => release(),
  };
}

const REQUEST = {
  agentName: 'default',
  input: 'Summarize the quarter.',
  principal: 'alice',
  commandId: 'request-1',
} as const;

type ExtraOptions = Pick<BureauOptions, 'flowControl'> & {
  /** What the `default` catalog agent declares for itself. */
  readonly systemPrompt?: string;
  readonly maximumSteps?: number;
  /** What the `researcher` catalog agent declares for itself. */
  readonly researcher?: { readonly instructions?: string; readonly maximumSteps?: number };
};

/**
 * Runs `body` against a durable bureau over a fresh SQLite file whose runs
 * are held until `release()`, then tears both down.
 */
async function withDurableBureau(
  body: (bureau: Bureau, release: () => void) => Promise<void>,
  extra: ExtraOptions = {},
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  const held = heldGenerate();
  const { researcher, systemPrompt, maximumSteps, ...bureauOptions } = extra;
  const bureau = await createBureau<AgentDefinitions>({
    ...bureauOptions,
    // `researcher` is the second agent the tests that name one dispatch to.
    agents: {
      researcher: createAgent({
        generate: held.generate,
        toolbox: createToolbox<readonly Tool[]>([]),
        ...researcher,
      }),
      default: createAgent({
        generate: held.generate,
        stopWhen: stopWhen.noToolCalls(),
        toolbox: createToolbox<readonly Tool[]>([]),
        ...(systemPrompt === undefined ? {} : { instructions: systemPrompt }),
        ...(maximumSteps === undefined ? {} : { maximumSteps }),
      }),
    },
    runtime,
    storage: fixture.configuration,
    durable: true,
    durableOwnership: { ownership: 'none' },
  });
  try {
    await body(bureau, held.release);
  } finally {
    held.release();
    await bureau.dispose();
    await fixture.dispose();
  }
}

/** A run result with each `Conversation` instance replaced by its messages, for deep equality. */
function plainResult(result: RunResult): unknown {
  return {
    ...result,
    conversation: result.conversation.getMessages(),
    steps: result.steps.map((step) => ({ ...step, conversation: step.conversation.getMessages() })),
  };
}

async function durableRunIds(bureau: Bureau): Promise<string[] | undefined> {
  const page = await bureau.tasks.workflows();
  return page?.items.map((run) => run.id).toSorted();
}

describe('tasks.start with a run-creation request id', () => {
  it('returns the same run and the original receipt on an exact retry, persisting one run', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await startTaskFrom(bureau, REQUEST);
      const retry = await startTaskFrom(bureau, REQUEST);

      expect(first.receipt).toEqual({
        runId: first.id,
        requestId: 'request-1',
        createdAt: ORIGIN,
        status: 'running',
      });
      expect(retry.id).toBe(first.id);
      expect(retry.contextId).toBe(first.contextId);
      expect(retry.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
      expect(listHeldTasks(bureau).map((run) => run.id)).toEqual([first.id]);
    });
  });

  it('settles a replayed task this process does not hold with the original full result', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const fixture = createSqliteStorageFixture({ runtime });
    const open = () =>
      createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate: async () => ({
              content: 'done',
              toolCalls: [],
              usage: { prompt: 3, completion: 5, total: 8 },
            }),
            stopWhen: stopWhen.noToolCalls(),
            toolbox: createToolbox<readonly Tool[]>([]),
          }),
        },
        runtime,
        storage: fixture.configuration,
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
    try {
      const first = await open();
      const task = await startTaskFrom(first, REQUEST);
      const original = await task.result();
      await first.dispose();

      // A new process over the same store: the retry replays a task it never held.
      const second = await open();
      try {
        const retry = await startTaskFrom(second, REQUEST);
        expect(listHeldTasks(second)).toEqual([]);
        // A `Conversation` is a live instance with bound methods, so each result's transcripts
        // are compared by their messages; every other field is compared as it is.
        expect(plainResult(await retry.result())).toEqual(plainResult(original));
      } finally {
        await second.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('creates one run for two identical requests issued concurrently', async () => {
    await withDurableBureau(async (bureau) => {
      const [first, second] = await Promise.all([
        startTaskFrom(bureau, REQUEST),
        startTaskFrom(bureau, REQUEST),
      ]);

      expect(second.id).toBe(first.id);
      expect(second.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
    });
  });

  it('rejects the same request id with a different payload as a typed conflict carrying the original receipt', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await startTaskFrom(bureau, REQUEST);
      const conflict = await rejectionOf(
        startTaskFrom(bureau, { ...REQUEST, input: 'Summarize the year.' }),
      );

      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect(conflict).not.toBeInstanceOf(BureauError);
      expect(conflict).toMatchObject({
        requestId: 'request-1',
        reason: 'payload-mismatch',
        originalReceipt: first.receipt,
      });
      expect(listHeldTasks(bureau).map((run) => run.id)).toEqual([first.id]);

      // The original entry is unaffected: an exact retry still replays it.
      const retry = await startTaskFrom(bureau, REQUEST);
      expect(retry.receipt).toEqual(first.receipt);
    });
  });

  it('creates one run per published agent for one request id', async () => {
    await withDurableBureau(async (bureau) => {
      const forBureau = await startTaskFrom(bureau, REQUEST);
      const forResearcher = await startTaskFrom(bureau, { ...REQUEST, agentName: 'researcher' });
      const researcherRetry = await startTaskFrom(bureau, { ...REQUEST, agentName: 'researcher' });

      expect(forResearcher.id).not.toBe(forBureau.id);
      expect(researcherRetry.id).toBe(forResearcher.id);
      expect(await durableRunIds(bureau)).toEqual([forBureau.id, forResearcher.id].toSorted());
    });
  });

  it('scopes the request id to the caller', async () => {
    await withDurableBureau(async (bureau) => {
      const alice = await startTaskFrom(bureau, REQUEST);
      const bob = await startTaskFrom(bureau, { ...REQUEST, principal: 'bob' });

      expect(bob.id).not.toBe(alice.id);
      expect(listHeldTasks(bureau)).toHaveLength(2);
    });
  });

  it('keys the request id without surrounding whitespace', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await startTaskFrom(bureau, REQUEST);
      const retry = await startTaskFrom(bureau, { ...REQUEST, commandId: ' request-1 ' });

      expect(retry.id).toBe(first.id);
      expect(retry.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
    });
  });

  it('keys the principal exactly as the run records its owner', async () => {
    await withDurableBureau(async (bureau) => {
      const padded = await startTaskFrom(bureau, { ...REQUEST, principal: ' alice ' });
      const exact = await startTaskFrom(bureau, REQUEST);

      // A padded principal is a different owner, so it never replays to `alice`.
      expect(exact.id).not.toBe(padded.id);
      expect(await durableRunIds(bureau)).toEqual([padded.id, exact.id].toSorted());
      const located = await bureau.tasks.receipt({
        principal: 'alice',
        commandId: 'request-1',
        agentName: 'default',
      });
      expect(located.status === 'recorded' && located.receipt.runId).toBe(exact.id);
    });
  });

  it('requires an authenticated principal to own the request id', async () => {
    await withDurableBureau(async (bureau) => {
      for (const request of [
        { agentName: 'default', input: 'hi', commandId: 'request-1' },
        { agentName: 'default', input: 'hi', principal: ' ', commandId: 'request-1' },
        { agentName: 'default', input: 'hi', principal: 'alice', commandId: ' ' },
      ]) {
        const rejection = await rejectionOf(startTaskFrom(bureau, request));
        expect(rejection).toBeInstanceOf(BureauError);
        expect((rejection as BureauError).code).toBe('BAD_REQUEST');
      }
      expect(listHeldTasks(bureau)).toEqual([]);
    });
  });

  it('offers no receipts without a durable engine', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'done', toolCalls: [] }),
          toolbox: createToolbox<readonly Tool[]>([]),
        }),
      },
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const rejection = await rejectionOf(startTaskFrom(bureau, REQUEST));
      expect(rejection).toBeInstanceOf(BureauError);
      expect(rejection).toMatchObject({ code: 'NOT_CONFIGURED', subject: 'durable' });
      expect(listHeldTasks(bureau)).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('leaves a request without a request id unledgered', async () => {
    const held = heldGenerate();
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: held.generate,
          toolbox: createToolbox<readonly Tool[]>([]),
        }),
      },
      runtime: createManualRuntimeServices({ origin: ORIGIN }),
    });
    try {
      const first = await bureau.tasks.start('default', 'hi', { principal: 'alice' });
      const second = await bureau.tasks.start('default', 'hi', { principal: 'alice' });

      expect(first.receipt).toBeUndefined();
      expect(second.id).not.toBe(first.id);
    } finally {
      held.release();
      await bureau.dispose();
    }
  });

  it('replays an exact retry instead of letting flow control reject it as a duplicate', async () => {
    await withDurableBureau(
      async (bureau) => {
        const first = await startTaskFrom(bureau, REQUEST);
        const retry = await startTaskFrom(bureau, REQUEST);

        expect(retry.id).toBe(first.id);
        expect(retry.receipt).toEqual(first.receipt);
      },
      { flowControl: { singleton: { key: (trigger) => trigger.message } } },
    );
  });

  it('releases the claim when flow control rejects a fresh request, so a later retry starts the run', async () => {
    await withDurableBureau(
      async (bureau, release) => {
        const occupying = await bureau.tasks.start('default', 'first', { principal: 'alice' });
        const rejected = await rejectionOf(startTaskFrom(bureau, REQUEST));
        expect(rejected).toBeInstanceOf(BureauError);
        expect((rejected as BureauError).code).toBe('RATE_LIMITED');

        release();
        await waitForCondition(
          () => bureau.tasks.detail(occupying.id)?.status === 'completed',
          'the occupying run did not complete',
        );

        const retry = await startTaskFrom(bureau, REQUEST);
        expect(retry.id).not.toBe(occupying.id);
        expect(retry.receipt).toMatchObject({ runId: retry.id, requestId: 'request-1' });
        expect(
          listHeldTasks(bureau)
            .map((run) => run.id)
            .toSorted(),
        ).toEqual([occupying.id, retry.id].toSorted());
      },
      { flowControl: { concurrency: { limit: 1, key: () => 'all-runs' } } },
    );
  });
});

describe('tasks.start on a session bound to an agent (COR-1577)', () => {
  // Deliberately names no agent: the session's own agent is inherited, which the type no longer
  // lets a caller write.
  const SESSION_REQUEST = {
    input: 'Carry on.',
    principal: 'alice',
    contextId: 'bound',
    commandId: 'request-1',
  } as const;

  /** Binds `bound` to `researcher` with a first run, and lets that run finish. */
  async function bindSession(bureau: Bureau, release: () => void): Promise<string> {
    const creator = await bureau.tasks.start('researcher', 'Start.', {
      contextId: 'bound',
      principal: 'alice',
    });
    release();
    await waitForCondition(
      () => bureau.tasks.detail(creator.id)?.status === 'completed',
      'the session-creating run did not complete',
    );
    return creator.id;
  }

  it('locates the one receipt by the session, by the spelled agent, or by both', async () => {
    await withDurableBureau(async (bureau, release) => {
      await bindSession(bureau, release);
      const omitted = await startTaskFrom(bureau, { ...SESSION_REQUEST, agentName: 'researcher' });
      const key = { principal: 'alice', commandId: 'request-1' } as const;

      const bySession = await bureau.tasks.receipt({ ...key, contextId: 'bound' });
      const byAgent = await bureau.tasks.receipt({ ...key, agentName: 'researcher' });
      const byBoth = await bureau.tasks.receipt({
        ...key,
        agentName: 'researcher',
        contextId: 'bound',
      });
      // With neither, there is no agent to look under (COR-323: no implicit default exists).
      const byNeither = await rejectionOf(bureau.tasks.receipt(key));

      for (const located of [bySession, byAgent, byBoth]) {
        expect(located.status === 'recorded' && located.receipt.runId).toBe(omitted.id);
      }
      expect((byNeither as BureauError).code).toBe('BAD_REQUEST');
    });
  });

  it('locates a session that does not exist under the agent the request stated, and refuses a contradiction', async () => {
    await withDurableBureau(async (bureau, release) => {
      await bindSession(bureau, release);
      const omitted = await startTaskFrom(bureau, { ...SESSION_REQUEST, agentName: 'researcher' });
      const key = { principal: 'alice', commandId: 'request-1' } as const;

      // No such session: the stated agent alone keys the request, as it does for a new session.
      const unknownSession = await bureau.tasks.receipt({
        ...key,
        agentName: 'researcher',
        contextId: 'no-such-session',
      });
      // A session bound to `researcher` cannot be asked about as `bureau`, as a run cannot name it.
      const contradiction = await rejectionOf(
        bureau.tasks.receipt({ ...key, agentName: 'default', contextId: 'bound' }),
      );

      // An unseen session with no stated agent leaves nothing to look under.
      const unseenWithoutAgent = await rejectionOf(
        bureau.tasks.receipt({ ...key, contextId: 'no-such-session' }),
      );

      expect((unseenWithoutAgent as BureauError).code).toBe('BAD_REQUEST');
      expect(unknownSession.status === 'recorded' && unknownSession.receipt.runId).toBe(omitted.id);
      expect(contradiction).toBeInstanceOf(BureauError);
      expect((contradiction as BureauError).code).toBe('BAD_REQUEST');
    });
  });
});
