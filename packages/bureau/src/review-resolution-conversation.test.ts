/**
 * COR-855 — resolving a tool-approval review writes its outcome into the
 * session's conversation, and `createRun` starts a run from that conversation
 * with no new message.
 *
 * Bureau settles a run whose tool call needs approval and runs the approved tool
 * out of band, so before this the session kept the `action_required` row for
 * ever and the host had to splice the outcome in by hand. `resolveReview` does
 * it now, for every caller: these tests drive it directly, never through an
 * adapter.
 */
import {
  createScriptedGenerate,
  stopWhen,
  type Toolbox,
  waitForCondition,
  waitForRunState,
  createAgent,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import type { Message } from 'conversationalist';
import { z } from 'zod';

import {
  ApprovalOutcomeNotWrittenError,
  BureauError,
  createBureau,
  ReviewRoundChangedError,
} from './create-bureau';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

const APPROVAL_SECRET = 'review-resolution-secret';

function chargeCardTool(charges: number[]) {
  return createTool({
    name: 'charge-card',
    version: '1.0.0',
    description: 'Charge a payment card',
    input: z.object({ cents: z.number() }),
    async execute({ cents }) {
      charges.push(cents);
      return { charged: cents };
    },
  });
}

/** A toolbox whose policy parks every call on approval. */
function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox([chargeCardTool(charges)], {
    approvalSecret: APPROVAL_SECRET,
    policy: {
      beforeExecute: () => ({
        allow: false,
        status: 'needs_approval',
        reason: 'Operator approval required',
        action: { message: 'Approve charge' },
      }),
    },
  }) as unknown as Toolbox;
}

/** A toolbox that gates the call again each time it is resumed. */
function regatingToolbox(charges: number[]): Toolbox {
  let evaluations = 0;
  return createToolbox([chargeCardTool(charges)], {
    approvalSecret: APPROVAL_SECRET,
    policy: {
      beforeExecute: () => {
        evaluations += 1;
        return {
          allow: false,
          status: 'needs_approval',
          reason: `Operator approval required (evaluation ${evaluations})`,
          action: { message: 'Approve charge' },
        };
      },
    },
  }) as unknown as Toolbox;
}

async function settle(bureau: Bureau, runId: string): Promise<void> {
  await waitForRunState(bureau, runId);
  for (let turn = 0; turn < 10; turn++) await yieldToPortableEventLoop();
}

/** A Bureau whose first run asks to charge a card and stops at the approval. */
async function parkedBureau(toolbox: Toolbox, diagnostics: string[] = []) {
  let generations = 0;
  const seenByGenerate: Array<ReadonlyArray<Message>> = [];
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async (context) => {
          generations += 1;
          seenByGenerate.push(context.conversation.getMessages({ includeHidden: true }));
          return generations === 1
            ? {
                content: '',
                toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
              }
            : { content: 'Charged.', toolCalls: [] };
        },
        toolbox,
        stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      }),
    },
    persistence: textValueStore(new MemoryStorage()),
    sessionPersistenceRetryDelayMilliseconds: 0,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
  });
  const run = await bureau.createRun({ agentName: 'default', message: 'Charge the customer' });
  await settle(bureau, run.id);
  const [review] = bureau.listPendingReviews();
  if (review === undefined || review.kind !== 'tool-approval') {
    throw new Error('expected one pending tool approval');
  }
  return { bureau, run, review, seenByGenerate };
}

async function sessionRows(bureau: Bureau, sessionId: string): Promise<Message[]> {
  const session = await bureau.getSession(sessionId);
  const history = session?.conversationHistory;
  if (history === undefined) throw new Error('expected the session to exist');
  return history.ids.map((id) => history.messages[id]!);
}

function resultRow(rows: ReadonlyArray<Message>, callId: string): Message {
  const row = rows.find((candidate) => candidate.toolResult?.callId === callId);
  if (row === undefined) throw new Error(`expected a tool-result row for ${callId}`);
  return row;
}

describe('resolveReview writes the outcome of a tool approval into the session', () => {
  it('replaces the action_required row with the executed result, in place', async () => {
    const charges: number[] = [];
    const { bureau, run, review } = await parkedBureau(approvalToolbox(charges));
    try {
      const pendingRow = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');
      expect(pendingRow.toolResult?.outcome).toBe('action_required');

      await bureau.resolveReview({ id: review.id, decision: 'approve', principal: 'alice' });

      const rows = await sessionRows(bureau, run.sessionId);
      const replaced = resultRow(rows, 'call-1');
      expect(replaced.id).toBe(pendingRow.id);
      expect(replaced.position).toBe(pendingRow.position);
      expect(replaced.toolResult?.outcome).toBe('success');
      expect(replaced.toolResult?.content).toEqual({ charged: 500 });
      expect(rows.filter((row) => row.toolResult?.callId === 'call-1')).toHaveLength(1);
      expect(charges).toEqual([500]);
    } finally {
      await bureau.dispose();
    }
  });

  it('records a denial as an error result carrying the reason', async () => {
    const charges: number[] = [];
    const { bureau, run, review } = await parkedBureau(approvalToolbox(charges));
    try {
      await bureau.resolveReview({
        id: review.id,
        decision: 'deny',
        principal: 'alice',
        reason: 'Too expensive',
      });

      const replaced = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');
      expect(replaced.toolResult?.outcome).toBe('error');
      expect(JSON.stringify(replaced.toolResult)).toContain('Too expensive');
      expect(charges).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('records a denial with no reason as an error result that says it was denied', async () => {
    const { bureau, run, review } = await parkedBureau(approvalToolbox([]));
    try {
      await bureau.resolveReview({ id: review.id, decision: 'deny', principal: 'alice' });

      const replaced = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');
      expect(replaced.toolResult?.outcome).toBe('error');
      expect(JSON.stringify(replaced.toolResult).toLowerCase()).toContain('denied');
    } finally {
      await bureau.dispose();
    }
  });

  it('records a rejection as an error result carrying the reason', async () => {
    const { bureau, run, review } = await parkedBureau(approvalToolbox([]));
    try {
      const resolved = await bureau.resolveReview({
        id: review.id,
        decision: 'reject',
        principal: 'alice',
        reason: 'Wrong customer',
      });

      const replaced = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');
      expect(replaced.toolResult?.outcome).toBe('error');
      expect(JSON.stringify(replaced.toolResult)).toContain('Wrong customer');
      expect(resolved.feedback).toBe('Wrong customer');
    } finally {
      await bureau.dispose();
    }
  });

  it('writes nothing when the policy gates the resumed call again', async () => {
    const charges: number[] = [];
    const { bureau, run, review } = await parkedBureau(regatingToolbox(charges));
    try {
      const before = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');

      await bureau.resolveReview({ id: review.id, decision: 'approve', principal: 'alice' });

      const after = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');
      expect(after).toEqual(before);
      expect(after.toolResult?.outcome).toBe('action_required');
      expect(charges).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('counts each supersession in the review round, under one id', async () => {
    const { bureau, review } = await parkedBureau(regatingToolbox([]));
    try {
      expect(review.round).toBe(0);

      const first = await bureau.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
      });
      const afterFirst = bureau.listPendingReviews();
      const second = await bureau.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
      });
      const afterSecond = bureau.listPendingReviews();

      expect(first.superseded).toBe(true);
      expect(second.superseded).toBe(true);
      expect(afterFirst.map((pending) => pending.id)).toEqual([review.id]);
      expect(afterFirst[0]).toMatchObject({ kind: 'tool-approval', round: 1 });
      expect(afterSecond[0]).toMatchObject({ kind: 'tool-approval', round: 2 });
      const stored = await bureau.getSession(review.sessionId);
      expect(stored?.metadata['pendingApprovalRounds']).toEqual({ [review.id]: 2 });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('fencing a resolution on the round the caller read (COR-1659)', () => {
  it('refuses a resolution of a round the review has moved past, before anything happens', async () => {
    const charges: number[] = [];
    const { bureau, run, review } = await parkedBureau(regatingToolbox(charges));
    try {
      // The round read was 0; another resolver gets in between and supersedes it.
      await bureau.resolveReview({ id: review.id, decision: 'approve', principal: 'bob' });
      const moved = bureau.listPendingReviews();
      expect(moved[0]).toMatchObject({ id: review.id, kind: 'tool-approval', round: 1 });
      const before = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');

      const error = await bureau
        .resolveReview({ id: review.id, decision: 'deny', principal: 'alice', round: 0 })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );

      expect(error).toBeInstanceOf(ReviewRoundChangedError);
      expect((error as BureauError).code).toBe('CONFLICT');
      // Nothing took effect: the review is still pending at its own round, with no decision and no write.
      // Ages move with the clock; everything else about the pending review stays put.
      const unchanged = bureau
        .listPendingReviews()
        .map(({ ageMilliseconds: _age, ...rest }) => rest);
      expect(unchanged).toEqual(moved.map(({ ageMilliseconds: _age, ...rest }) => rest));
      expect(resultRow(await sessionRows(bureau, run.sessionId), 'call-1')).toEqual(before);
      const reread = await bureau.getReview(review.id);
      expect(reread?.status).toBe('pending');
      expect(charges).toEqual([]);

      // The round the caller then reads decides, and a call naming no round is unfenced as before.
      const current = await bureau.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
        round: 1,
      });
      expect(current.superseded).toBe(true);
      const unfenced = await bureau.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
      });
      expect(unfenced.superseded).toBe(true);
      expect(bureau.listPendingReviews()[0]).toMatchObject({ round: 3 });
    } finally {
      await bureau.dispose();
    }
  });

  it('applies a resolution that names the round the review is at', async () => {
    const charges: number[] = [];
    const { bureau, review } = await parkedBureau(approvalToolbox(charges));
    try {
      const resolved = await bureau.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
        round: 0,
      });
      expect(resolved.decision).toBe('approve');
      expect(charges).toHaveLength(1);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('when the outcome cannot be written into the session', () => {
  /** Makes every session update that changes the conversation fail; the resolution's own writes pass. */
  function failConversationWrites(bureau: Bureau) {
    const store = bureau.sessionStore!;
    const update = store.update.bind(store);
    return spyOn(store, 'update').mockImplementation((id, updater, options) =>
      update(
        id,
        async (session) => {
          const next = await updater(session);
          if (
            session !== undefined &&
            next !== undefined &&
            next.conversationHistory !== session.conversationHistory
          ) {
            throw new Error('disk full');
          }
          return next;
        },
        options,
      ),
    );
  }

  it('does not report success: the resolution rejects, naming what is left undone', async () => {
    const charges: number[] = [];
    const diagnostics: string[] = [];
    const { bureau, run, review } = await parkedBureau(approvalToolbox(charges), diagnostics);
    try {
      const failing = failConversationWrites(bureau);

      const error = await bureau
        .resolveReview({ id: review.id, decision: 'approve', principal: 'alice' })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      failing.mockRestore();

      expect(error).toBeInstanceOf(BureauError);
      // A fixed sentence reaches the caller; the storage error's text stays in the diagnostic.
      expect((error as BureauError).message).toContain(
        'could not be written into the conversation',
      );
      expect((error as BureauError).message).not.toContain('disk full');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain('disk full');
      // The tool ran and the review is resolved: the failure is about the conversation only.
      expect(charges).toEqual([500]);
      expect(bureau.listPendingReviews()).toHaveLength(0);
      const row = resultRow(await sessionRows(bureau, run.sessionId), 'call-1');
      expect(row.toolResult?.outcome).toBe('action_required');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('an approval resolved while its run is still going', () => {
  it('rejects, because the conversation the row is in has not been stored yet and the terminal save would put the stale row there', async () => {
    const charges: number[] = [];
    const generate = createScriptedGenerate([
      {
        kind: 'respond',
        response: {
          content: 'Charging.',
          toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
        },
      },
      { kind: 'block', barrier: 'next-step' },
      { kind: 'respond', response: { content: 'Carried on.', toolCalls: [] } },
    ]);
    // No `pendingApproval()`: the run goes on past the gated call.
    const bureau = await createBureau<AgentDefinitions>({
      id: 'running-approval',
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'memory' },
      durableExecution: true,
      sessionPersistenceRetryDelayMilliseconds: 0,
      onDiagnostic: () => undefined,
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'charge it',
        principal: 'alice',
      });
      await generate.reached('next-step');
      await waitForCondition(() => bureau.listPendingReviews().length === 1, 'no review listed');
      const [review] = bureau.listPendingReviews();

      const outcome = await bureau
        .resolveReview({ id: review!.id, decision: 'approve', principal: 'alice' })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      generate.release('next-step');
      await waitForRunState(bureau, run.id);

      expect(outcome).toBeInstanceOf(ApprovalOutcomeNotWrittenError);
      expect(charges).toEqual([500]);
    } finally {
      generate.release('next-step');
      await bureau.dispose();
    }
  });
});

describe('createRun with neither message nor appendMessages', () => {
  it('starts a run from the session an approval resolution left, which the model then sees', async () => {
    const { bureau, run, review, seenByGenerate } = await parkedBureau(approvalToolbox([]));
    try {
      await bureau.resolveReview({ id: review.id, decision: 'approve', principal: 'alice' });

      const next = await bureau.createRun({ agentName: 'default', sessionId: run.sessionId });
      await settle(bureau, next.id);

      expect(next.id).not.toBe(run.id);
      const seen = seenByGenerate.at(-1)!;
      expect(seen.at(-1)?.toolResult?.outcome).toBe('success');
      const rows = await sessionRows(bureau, run.sessionId);
      expect(rows.at(-1)?.role).toBe('assistant');
    } finally {
      await bureau.dispose();
    }
  });

  it('is refused as a bad request when the conversation ends in an assistant row', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: 'Hello.', toolCalls: [] }) }),
      },
      persistence: textValueStore(new MemoryStorage()),
    });
    try {
      const first = await bureau.createRun({ agentName: 'default', message: 'Hi' });
      await settle(bureau, first.id);
      const runsBefore = bureau.listRuns().length;

      const error = await bureau
        .createRun({ agentName: 'default', sessionId: first.sessionId })
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );

      expect(error).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('BAD_REQUEST');
      expect(bureau.listRuns()).toHaveLength(runsBefore);
    } finally {
      await bureau.dispose();
    }
  });

  it('is refused as a bad request on a new session, which holds no row to answer', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate: async () => ({ content: '', toolCalls: [] }) }),
      },
    });
    try {
      const error = await bureau.createRun({ agentName: 'default' }).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

      expect((error as BureauError).code).toBe('BAD_REQUEST');
    } finally {
      await bureau.dispose();
    }
  });
});
