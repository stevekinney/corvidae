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
  stopWhen,
  waitForCondition,
} from '@lostgradient/operative';
import { createToolbox, type Tool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { BureauLedgerConflictError } from './command-ledger';
import { BureauError, createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, BureauOptions, CreateRunRequest } from './types';

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
  message: 'Summarize the quarter.',
  principal: 'alice',
  runCreationRequestId: 'request-1',
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
    durableExecution: true,
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

async function durableRunIds(bureau: Bureau): Promise<string[] | undefined> {
  const page = await bureau.listDurableRuns();
  return page?.items.map((run) => run.id).toSorted();
}

describe('createRun with a run-creation request id', () => {
  it('returns the same run and the original receipt on an exact retry, persisting one run', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await bureau.createRun(REQUEST);
      const retry = await bureau.createRun(REQUEST);

      expect(first.receipt).toEqual({
        runId: first.id,
        requestId: 'request-1',
        createdAt: ORIGIN,
        status: 'running',
      });
      expect(retry.id).toBe(first.id);
      expect(retry.sessionId).toBe(first.sessionId);
      expect(retry.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
      expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);
    });
  });

  it('creates one run for two identical requests issued concurrently', async () => {
    await withDurableBureau(async (bureau) => {
      const [first, second] = await Promise.all([
        bureau.createRun(REQUEST),
        bureau.createRun(REQUEST),
      ]);

      expect(second.id).toBe(first.id);
      expect(second.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
    });
  });

  it('treats a retry that spells out the defaults it first omitted as the same command', async () => {
    await withDurableBureau(
      async (bureau) => {
        const first = await bureau.createRun(REQUEST);
        const retry = await bureau.createRun({
          ...REQUEST,
          agentName: 'default',
          systemPrompt: 'You keep the books.',
          maximumSteps: 7,
        });

        expect(retry.id).toBe(first.id);
        expect(retry.receipt).toEqual(first.receipt);
        expect(await durableRunIds(bureau)).toEqual([first.id]);

        // A value that differs from the default is a different command.
        const conflict = await rejectionOf(bureau.createRun({ ...REQUEST, maximumSteps: 8 }));
        expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      },
      { systemPrompt: 'You keep the books.', maximumSteps: 7 },
    );
  });

  it('reads a named run’s defaults from the agent, so the digest holds the values that win', async () => {
    await withDurableBureau(
      async (bureau) => {
        const named = { ...REQUEST, agentName: 'researcher' };
        const first = await bureau.createRun(named);

        // Spelling out what the agent declares is the same command: the agent's values beat the
        // Bureau's defaults, so they are what the digest holds.
        const retry = await bureau.createRun({
          ...named,
          systemPrompt: 'You are the researcher.',
          maximumSteps: 4,
        });
        expect(retry.id).toBe(first.id);

        // The Bureau's own defaults lost, so spelling them out is a different command.
        const bureauPrompt = await rejectionOf(
          bureau.createRun({ ...named, systemPrompt: 'You keep the books.' }),
        );
        expect(bureauPrompt).toBeInstanceOf(BureauLedgerConflictError);
        const bureauSteps = await rejectionOf(bureau.createRun({ ...named, maximumSteps: 7 }));
        expect(bureauSteps).toBeInstanceOf(BureauLedgerConflictError);
      },
      {
        systemPrompt: 'You keep the books.',
        maximumSteps: 7,
        researcher: { instructions: 'You are the researcher.', maximumSteps: 4 },
      },
    );
  });

  it('rejects the same request id with a different payload as a typed conflict carrying the original receipt', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await bureau.createRun(REQUEST);
      const conflict = await rejectionOf(
        bureau.createRun({ ...REQUEST, message: 'Summarize the year.' }),
      );

      expect(conflict).toBeInstanceOf(BureauLedgerConflictError);
      expect(conflict).not.toBeInstanceOf(BureauError);
      expect(conflict).toMatchObject({
        requestId: 'request-1',
        reason: 'payload-mismatch',
        originalReceipt: first.receipt,
      });
      expect(bureau.listRuns().map((run) => run.id)).toEqual([first.id]);

      // The original entry is unaffected: an exact retry still replays it.
      const retry = await bureau.createRun(REQUEST);
      expect(retry.receipt).toEqual(first.receipt);
    });
  });

  it('creates one run per published agent for one request id', async () => {
    await withDurableBureau(async (bureau) => {
      const forBureau = await bureau.createRun(REQUEST);
      const forResearcher = await bureau.createRun({ ...REQUEST, agentName: 'researcher' });
      const researcherRetry = await bureau.createRun({ ...REQUEST, agentName: 'researcher' });

      expect(forResearcher.id).not.toBe(forBureau.id);
      expect(researcherRetry.id).toBe(forResearcher.id);
      expect(await durableRunIds(bureau)).toEqual([forBureau.id, forResearcher.id].toSorted());
    });
  });

  it('scopes the request id to the caller', async () => {
    await withDurableBureau(async (bureau) => {
      const alice = await bureau.createRun(REQUEST);
      const bob = await bureau.createRun({ ...REQUEST, principal: 'bob' });

      expect(bob.id).not.toBe(alice.id);
      expect(bureau.listRuns()).toHaveLength(2);
    });
  });

  it('keys the request id without surrounding whitespace', async () => {
    await withDurableBureau(async (bureau) => {
      const first = await bureau.createRun(REQUEST);
      const retry = await bureau.createRun({ ...REQUEST, runCreationRequestId: ' request-1 ' });

      expect(retry.id).toBe(first.id);
      expect(retry.receipt).toEqual(first.receipt);
      expect(await durableRunIds(bureau)).toEqual([first.id]);
    });
  });

  it('keys the principal exactly as the run records its owner', async () => {
    await withDurableBureau(async (bureau) => {
      const padded = await bureau.createRun({ ...REQUEST, principal: ' alice ' });
      const exact = await bureau.createRun(REQUEST);

      // A padded principal is a different owner, so it never replays to `alice`.
      expect(exact.id).not.toBe(padded.id);
      expect(await durableRunIds(bureau)).toEqual([padded.id, exact.id].toSorted());
      const located = await bureau.locateRunCreationReceipt({
        principal: 'alice',
        agentName: 'default',
        runCreationRequestId: 'request-1',
      });
      expect(located.status === 'recorded' && located.receipt.runId).toBe(exact.id);
    });
  });

  it('requires an authenticated principal to own the request id', async () => {
    await withDurableBureau(async (bureau) => {
      for (const request of [
        { agentName: 'default', message: 'hi', runCreationRequestId: 'request-1' },
        { agentName: 'default', message: 'hi', principal: ' ', runCreationRequestId: 'request-1' },
        { agentName: 'default', message: 'hi', principal: 'alice', runCreationRequestId: ' ' },
      ]) {
        const rejection = await rejectionOf(bureau.createRun(request));
        expect(rejection).toBeInstanceOf(BureauError);
        expect((rejection as BureauError).code).toBe('BAD_REQUEST');
      }
      expect(bureau.listRuns()).toEqual([]);
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
      const rejection = await rejectionOf(bureau.createRun(REQUEST));
      expect(rejection).toBeInstanceOf(BureauError);
      expect(rejection).toMatchObject({ code: 'NOT_CONFIGURED', subject: 'durable' });
      expect(bureau.listRuns()).toEqual([]);
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
      const first = await bureau.createRun({
        agentName: 'default',
        message: 'hi',
        principal: 'alice',
      });
      const second = await bureau.createRun({
        agentName: 'default',
        message: 'hi',
        principal: 'alice',
      });

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
        const first = await bureau.createRun(REQUEST);
        const retry = await bureau.createRun(REQUEST);

        expect(retry.id).toBe(first.id);
        expect(retry.receipt).toEqual(first.receipt);
      },
      { flowControl: { singleton: { key: (trigger) => trigger.message } } },
    );
  });

  it('releases the claim when flow control rejects a fresh request, so a later retry starts the run', async () => {
    await withDurableBureau(
      async (bureau, release) => {
        const occupying = await bureau.createRun({
          agentName: 'default',
          message: 'first',
          principal: 'alice',
        });
        const rejected = await rejectionOf(bureau.createRun(REQUEST));
        expect(rejected).toBeInstanceOf(BureauError);
        expect((rejected as BureauError).code).toBe('RATE_LIMITED');

        release();
        await waitForCondition(
          () => bureau.getRun(occupying.id)?.status === 'completed',
          'the occupying run did not complete',
        );

        const retry = await bureau.createRun(REQUEST);
        expect(retry.id).not.toBe(occupying.id);
        expect(retry.receipt).toMatchObject({ runId: retry.id, requestId: 'request-1' });
        expect(
          bureau
            .listRuns()
            .map((run) => run.id)
            .toSorted(),
        ).toEqual([occupying.id, retry.id].toSorted());
      },
      { flowControl: { concurrency: { limit: 1, key: () => 'all-runs' } } },
    );
  });
});

describe('createRun on a session bound to an agent (COR-1577)', () => {
  // Deliberately names no agent: the session's own agent is inherited, which the type no longer
  // lets a caller write.
  const SESSION_REQUEST = {
    message: 'Carry on.',
    principal: 'alice',
    sessionId: 'bound',
    runCreationRequestId: 'request-1',
  } as const;

  /** Binds `bound` to `researcher` with a first run, and lets that run finish. */
  async function bindSession(bureau: Bureau, release: () => void): Promise<string> {
    const creator = await bureau.createRun({
      message: 'Start.',
      principal: 'alice',
      agentName: 'researcher',
      sessionId: 'bound',
    });
    release();
    await waitForCondition(
      () => bureau.getRun(creator.id)?.status === 'completed',
      'the session-creating run did not complete',
    );
    return creator.id;
  }

  async function runIds(bureau: Bureau): Promise<string[]> {
    return bureau
      .listRuns()
      .map((run) => run.id)
      .toSorted();
  }

  it('treats a retry that spells the inherited agent as the same command as one that omitted it', async () => {
    await withDurableBureau(async (bureau, release) => {
      const creatorId = await bindSession(bureau, release);

      const omitted = await bureau.createRun(SESSION_REQUEST as CreateRunRequest);
      const spelled = await bureau.createRun({ ...SESSION_REQUEST, agentName: 'researcher' });

      expect(spelled.id).toBe(omitted.id);
      expect(spelled.receipt).toEqual(omitted.receipt);
      expect(await runIds(bureau)).toEqual([creatorId, omitted.id].toSorted());
    });
  });

  it('treats a retry that omits the agent as the same command as one that spelled it', async () => {
    await withDurableBureau(async (bureau, release) => {
      const creatorId = await bindSession(bureau, release);

      const spelled = await bureau.createRun({ ...SESSION_REQUEST, agentName: 'researcher' });
      const omitted = await bureau.createRun(SESSION_REQUEST as CreateRunRequest);

      expect(omitted.id).toBe(spelled.id);
      expect(omitted.receipt).toEqual(spelled.receipt);
      expect(await runIds(bureau)).toEqual([creatorId, spelled.id].toSorted());
    });
  });

  it('locates the one receipt by the session, by the spelled agent, or by both', async () => {
    await withDurableBureau(async (bureau, release) => {
      await bindSession(bureau, release);
      const omitted = await bureau.createRun(SESSION_REQUEST as CreateRunRequest);
      const key = { principal: 'alice', runCreationRequestId: 'request-1' } as const;

      const bySession = await bureau.locateRunCreationReceipt({ ...key, sessionId: 'bound' });
      const byAgent = await bureau.locateRunCreationReceipt({ ...key, agentName: 'researcher' });
      const byBoth = await bureau.locateRunCreationReceipt({
        ...key,
        agentName: 'researcher',
        sessionId: 'bound',
      });
      // With neither, there is no agent to look under (COR-323: no implicit default exists).
      const byNeither = await rejectionOf(bureau.locateRunCreationReceipt(key));

      for (const located of [bySession, byAgent, byBoth]) {
        expect(located.status === 'recorded' && located.receipt.runId).toBe(omitted.id);
      }
      expect((byNeither as BureauError).code).toBe('BAD_REQUEST');
    });
  });

  it('locates a session that does not exist under the agent the request stated, and refuses a contradiction', async () => {
    await withDurableBureau(async (bureau, release) => {
      await bindSession(bureau, release);
      const omitted = await bureau.createRun(SESSION_REQUEST as CreateRunRequest);
      const key = { principal: 'alice', runCreationRequestId: 'request-1' } as const;

      // No such session: the stated agent alone keys the request, as it does for a new session.
      const unknownSession = await bureau.locateRunCreationReceipt({
        ...key,
        agentName: 'researcher',
        sessionId: 'no-such-session',
      });
      // A session bound to `researcher` cannot be asked about as `bureau`, as a run cannot name it.
      const contradiction = await rejectionOf(
        bureau.locateRunCreationReceipt({ ...key, agentName: 'default', sessionId: 'bound' }),
      );

      expect(unknownSession.status === 'recorded' && unknownSession.receipt.runId).toBe(omitted.id);
      expect(contradiction).toBeInstanceOf(BureauError);
      expect((contradiction as BureauError).code).toBe('BAD_REQUEST');
    });
  });
});
