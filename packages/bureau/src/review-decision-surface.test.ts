/**
 * COR-2292 — where a tool approval was decided (`chat` or `reviews`) is kept with the decision: on
 * the outcome row, in the audit entry the review is read back from, and in the resolved-review
 * record. The first committed decision owns it, absence included: a repeat of that decision from
 * another surface changes nothing, and a round the policy gated again leaves nothing behind for
 * the round that follows.
 */
import { createAgent, stopWhen, type Toolbox } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { Message } from 'conversationalist';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import {
  APPROVAL_DECISION_METADATA_KEY,
  approvalDecisionMetadata,
  decisionSurfaceOf,
  isApprovalDecisionSurface,
  withFirstDecisionSurface,
} from './approval-decision-metadata';
import { BureauError } from './bureau-errors';
import { createBureau } from './create-bureau';
import { resolvedReviewOfAudit } from './resolved-review-record';
import { waitForTaskState } from './test';
import type { Bureau } from './bureau-types/facade';

const APPROVAL_SECRET = 'decision-surface-secret';

function chargeCardTool() {
  return createTool({
    name: 'charge-card',
    version: '1.0.0',
    description: 'Charge a payment card',
    input: z.object({ cents: z.number() }),
    async execute({ cents }) {
      return { charged: cents };
    },
  });
}

/** A toolbox whose policy parks every call on approval. */
function approvalToolbox(): Toolbox {
  return createToolbox([chargeCardTool()], {
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
function regatingToolbox(): Toolbox {
  let evaluations = 0;
  return createToolbox([chargeCardTool()], {
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
  await waitForTaskState(bureau, runId);
  // load-proof: the work these turns let finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turns with one); no timer or I/O is pending
  for (let turn = 0; turn < 10; turn++) await yieldToPortableEventLoop();
}

/** A Bureau whose first run asks to charge a card and stops at the approval. */
async function parkedBureau(toolbox: Toolbox) {
  let generations = 0;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async () => {
          generations += 1;
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
    storage: new MemoryStorage(),
    durable: false,
  });
  const run = await bureau.tasks.start('default', 'Charge the customer');
  await settle(bureau, run.id);
  const [review] = bureau.reviews.list();
  if (review === undefined || review.kind !== 'tool-approval') {
    throw new Error('expected one pending tool approval');
  }
  return { bureau, run, review };
}

async function decisionStamp(
  bureau: Bureau,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const session = await bureau.contexts.get(sessionId);
  const history = session?.conversationHistory;
  if (history === undefined) throw new Error('expected the session to exist');
  const rows: Message[] = history.ids.map((id) => history.messages[id]!);
  const row = rows.find((candidate) => candidate.toolResult?.callId === 'call-1');
  if (row === undefined) throw new Error('expected a tool-result row for call-1');
  return row.metadata[APPROVAL_DECISION_METADATA_KEY] as Record<string, unknown> | undefined;
}

describe('the decision surface of a tool approval (COR-2292)', () => {
  it('keeps a decision made in Reviews on the outcome row, the review and its record', async () => {
    const { bureau, run, review } = await parkedBureau(approvalToolbox());
    try {
      await bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
        decisionSurface: 'reviews',
      });

      expect(await decisionStamp(bureau, run.contextId)).toMatchObject({
        decision: 'approve',
        decidedBy: 'alice',
        decisionSurface: 'reviews',
      });
      expect(await bureau.reviews.get(review.id)).toMatchObject({
        status: 'approved',
        resolvedBy: 'alice',
        decisionSurface: 'reviews',
      });
      const [record] = await bureau.reviews.listResolved();
      expect(record).toMatchObject({ decision: 'approve', decisionSurface: 'reviews' });
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps a decision made in the chat as the chat’s, never as Reviews', async () => {
    const { bureau, run, review } = await parkedBureau(approvalToolbox());
    try {
      await bureau.reviews.resolve({
        id: review.id,
        decision: 'deny',
        principal: 'alice',
        reason: 'Not this card.',
        decisionSurface: 'chat',
      });

      expect(await decisionStamp(bureau, run.contextId)).toMatchObject({
        decision: 'deny',
        reason: 'Not this card.',
        decisionSurface: 'chat',
      });
      expect(await bureau.reviews.get(review.id)).toMatchObject({ decisionSurface: 'chat' });
    } finally {
      await bureau.dispose();
    }
  });

  it('leaves the surface unknown when the caller does not say', async () => {
    const { bureau, run, review } = await parkedBureau(approvalToolbox());
    try {
      await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'alice' });

      expect(await decisionStamp(bureau, run.contextId)).not.toHaveProperty('decisionSurface');
      expect(await bureau.reviews.get(review.id)).not.toHaveProperty('decisionSurface');
      const [record] = await bureau.reviews.listResolved();
      expect(record).toMatchObject({ decision: 'approve', decidedBy: 'alice' });
      expect(record).not.toHaveProperty('decisionSurface');
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps the first decision’s surface when the same decision is repeated from another surface', async () => {
    const { bureau, run, review } = await parkedBureau(approvalToolbox());
    try {
      await bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
        decisionSurface: 'chat',
      });

      expect(
        await rejectionOf(
          bureau.reviews.resolve({
            id: review.id,
            decision: 'approve',
            principal: 'alice',
            decisionSurface: 'reviews',
          }),
        ),
      ).toBeInstanceOf(BureauError);

      expect(await decisionStamp(bureau, run.contextId)).toMatchObject({
        decisionSurface: 'chat',
      });
      expect(await bureau.reviews.get(review.id)).toMatchObject({ decisionSurface: 'chat' });
      const resolved = await bureau.reviews.listResolved();
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ decisionSurface: 'chat' });
    } finally {
      await bureau.dispose();
    }
  });

  it('keeps an unknown first surface unknown when a repeat names one', async () => {
    const { bureau, run, review } = await parkedBureau(approvalToolbox());
    try {
      await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'alice' });

      expect(
        await rejectionOf(
          bureau.reviews.resolve({
            id: review.id,
            decision: 'approve',
            principal: 'alice',
            decisionSurface: 'reviews',
          }),
        ),
      ).toBeInstanceOf(BureauError);

      expect(await decisionStamp(bureau, run.contextId)).not.toHaveProperty('decisionSurface');
      const [record] = await bureau.reviews.listResolved();
      expect(record).toMatchObject({ decision: 'approve', decidedBy: 'alice' });
      expect(record).not.toHaveProperty('decisionSurface');
    } finally {
      await bureau.dispose();
    }
  });

  it('leaves nothing of a superseded round’s surface on the decision of the next round', async () => {
    const { bureau, run, review } = await parkedBureau(regatingToolbox());
    try {
      const first = await bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
        decisionSurface: 'reviews',
      });
      expect(first.superseded).toBe(true);

      await bureau.reviews.resolve({
        id: review.id,
        decision: 'deny',
        principal: 'bob',
        round: 1,
      });

      expect(await decisionStamp(bureau, run.contextId)).not.toHaveProperty('decisionSurface');
      expect(await bureau.reviews.get(review.id)).not.toHaveProperty('decisionSurface');
      const [record] = await bureau.reviews.listResolved();
      expect(record).toMatchObject({ decision: 'deny', decidedBy: 'bob' });
      expect(record).not.toHaveProperty('decisionSurface');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('the decision surface helpers (COR-2292)', () => {
  it('names exactly chat and reviews, case-sensitively', () => {
    expect(isApprovalDecisionSurface('chat')).toBe(true);
    expect(isApprovalDecisionSurface('reviews')).toBe(true);
    expect(isApprovalDecisionSurface('Reviews')).toBe(false);
    expect(isApprovalDecisionSurface('inbox')).toBe(false);
    expect(isApprovalDecisionSurface(undefined)).toBe(false);
    expect(isApprovalDecisionSurface(1)).toBe(false);
  });

  it('records a surface for a tool approval only', () => {
    expect(decisionSurfaceOf({ kind: 'tool-approval' }, { decisionSurface: 'chat' })).toBe('chat');
    expect(decisionSurfaceOf({ kind: 'human-wait' }, { decisionSurface: 'chat' })).toBeUndefined();
    expect(decisionSurfaceOf({ kind: 'tool-approval' }, {})).toBeUndefined();
  });

  it('writes the surface into the outcome metadata only when it is known', () => {
    const decided = { decision: 'approve' as const, decidedBy: 'alice', decidedAt: 'now' };
    expect(
      approvalDecisionMetadata({ ...decided, decisionSurface: 'reviews' })[
        APPROVAL_DECISION_METADATA_KEY
      ],
    ).toEqual({ ...decided, decisionSurface: 'reviews' });
    expect(approvalDecisionMetadata(decided)[APPROVAL_DECISION_METADATA_KEY]).toEqual(decided);
  });

  it('keeps the surface a held record names, or its absence, over the one offered', () => {
    const offered = {
      decision: 'approve' as const,
      decidedBy: 'alice',
      decidedAt: 'now',
      decisionSurface: 'reviews' as const,
    };
    expect(withFirstDecisionSurface(offered, undefined)).toEqual(offered);
    expect(
      withFirstDecisionSurface(offered, { decision: 'approve', decisionSurface: 'chat' }),
    ).toMatchObject({ decisionSurface: 'chat' });
    expect(withFirstDecisionSurface(offered, { decision: 'approve' })).not.toHaveProperty(
      'decisionSurface',
    );
    expect(
      withFirstDecisionSurface(offered, { decision: 'approve', decisionSurface: 'Reviews' }),
    ).not.toHaveProperty('decisionSurface');
  });

  it('reads the surface back from an audit entry, and nothing it does not know', () => {
    const payload = (detail: Record<string, unknown>) => ({
      runId: 'run-1',
      type: 'review.tool-approval.approved',
      principal: 'alice',
      detail: {
        review: {
          id: 'approval:run-1:call-1',
          kind: 'tool-approval',
          runId: 'run-1',
          approval: { callId: 'call-1', toolName: 'refund', arguments: {} },
        },
        decision: 'approve',
        ...detail,
      },
    });

    expect(resolvedReviewOfAudit(payload({ decisionSurface: 'reviews' }), 1)).toMatchObject({
      decisionSurface: 'reviews',
    });
    expect(resolvedReviewOfAudit(payload({}), 1)).not.toHaveProperty('decisionSurface');
    expect(resolvedReviewOfAudit(payload({ decisionSurface: 'elsewhere' }), 1)).not.toHaveProperty(
      'decisionSurface',
    );
  });
});
