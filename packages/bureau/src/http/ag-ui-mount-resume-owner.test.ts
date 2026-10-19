/**
 * COR-1588 — the reads a resume makes of the thread's session are made as the owner the route
 * authorized. Each test hands the mount a Bureau whose session, at one read, is another owner's
 * (bob's) while everything else is alice's, as if the thread had been deleted and created again by
 * bob between two of the resume's reads. The read in question must treat bob's session as missing.
 */
import { EventType, type ResumeEntry } from '@ag-ui/core';
import { type AgentSession, type Toolbox } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { PendingReview } from '../types.ts';
import {
  aliceHandlerOver,
  as,
  authentication,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';

const SECRET = 'ag-ui-resume-owner-secret';

const chargeCard = createTool({
  name: 'charge-card',
  version: '1.0.0',
  description: 'Charge a payment card',
  input: z.object({ cents: z.number() }),
  async execute({ cents }) {
    return { charged: cents };
  },
});

const needsApproval = createToolbox([chargeCard], {
  approvalSecret: SECRET,
  policy: {
    beforeExecute: () => ({
      allow: false as const,
      status: 'needs_approval' as const,
      reason: 'Operator approval required',
      action: { message: 'Approve charge' },
    }),
  },
}) as unknown as Toolbox;

const charge = {
  kind: 'respond' as const,
  response: {
    content: 'Charging.',
    toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
  },
};
const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

/** Alice's thread, with a run settled on a tool approval, and the interrupt to answer. */
async function withApproval<T>(
  body: (scene: { harness: Harness; reviewId: string }) => Promise<T>,
): Promise<T> {
  const harness = await openHarness({
    script: [charge, say('Charged.')],
    toolbox: needsApproval,
    authentication,
  });
  try {
    const frames = await readAgUiStream(
      await harness.handler(startRequest(runAgentInput(), as('alice-key'))),
    );
    const finished = frames.at(-1)!.event as { outcome: { interrupts: Array<{ id: string }> } };
    return await body({ harness, reviewId: finished.outcome.interrupts[0]!.id });
  } finally {
    await harness.dispose();
  }
}

/** A copy of alice's session that bob owns, with `edit` applied to its conversation. */
function bobsCopyOf(
  session: AgentSession,
  edit: (messages: AgentSession['conversationHistory']['messages']) => void = () => {},
): AgentSession {
  const copy = structuredClone(session);
  copy.metadata['sessionOwner'] = 'api-key:bob';
  edit(copy.conversationHistory.messages);
  return copy;
}

const approveEntry = (reviewId: string): ResumeEntry => ({
  interruptId: reviewId,
  status: 'resolved',
  payload: { decision: 'approve' },
});

const resumeRequest = (entry: ResumeEntry) =>
  startRequest(runAgentInput({ runId: 'resume-1', messages: [], resume: [entry] }));

describe('a resume that reads a session another owner created under the thread’s id', () => {
  it('does not replay that session’s calls to the reader in the prelude', async () => {
    await withApproval(async ({ harness, reviewId }) => {
      const { bureau } = harness;
      // The thread is alice's until the resume has created the run that continues from the
      // approval. The prelude replays the approved call from the conversation read after that.
      let created = false;
      const handler = aliceHandlerOver({
        ...bureau,
        createRun: async (...args) => {
          const run = await bureau.createRun(...args);
          created = true;
          return run;
        },
        getSession: async (id) => {
          const session = await bureau.getSession(id);
          if (!created || session === undefined) return session;
          return bobsCopyOf(session, (messages) => {
            for (const row of Object.values(messages)) {
              if (row.toolCall !== undefined)
                Object.assign(row.toolCall, { arguments: { cents: 424242 } });
            }
          });
        },
      });

      const response = await handler(resumeRequest(approveEntry(reviewId)));
      const text = await response.text();

      expect(created).toBe(true);
      expect(text).not.toContain('424242');
    });
  });

  it('does not match the route’s agent against that session’s agent for a review that names none', async () => {
    await withApproval(async ({ harness, reviewId }) => {
      const { bureau } = harness;
      const handler = aliceHandlerOver({
        ...bureau,
        // A review read back after a restart names no agent; the session's agent stands in for it.
        getReview: async (id): Promise<PendingReview | undefined> => {
          const found = await bureau.getReview(id);
          return found === undefined ? undefined : { ...found, agentName: undefined };
        },
        getSession: async (id) => {
          const session = await bureau.getSession(id);
          return session === undefined ? undefined : bobsCopyOf(session);
        },
      });

      const frames = await readAgUiStream(await handler(resumeRequest(approveEntry(reviewId))));

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject({
        type: EventType.RUN_ERROR,
        code: 'INTERRUPT_NOT_FOUND',
      });
      expect(bureau.listPendingReviews()).toHaveLength(1);
    });
  });

  it('does not decide that a run can start from that session’s conversation', async () => {
    await withApproval(async ({ harness, reviewId }) => {
      const { bureau } = harness;
      const handler = aliceHandlerOver({
        ...bureau,
        getSession: async (id) => {
          const session = await bureau.getSession(id);
          return session === undefined ? undefined : bobsCopyOf(session);
        },
      });

      const frames = await readAgUiStream(await handler(resumeRequest(approveEntry(reviewId))));

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject({
        type: EventType.RUN_ERROR,
        code: 'CONTINUATION_UNAVAILABLE',
      });
      expect(bureau.listPendingReviews()).toHaveLength(1);
    });
  });

  it('does not refuse the continuation on that session’s unwritten approval outcome', async () => {
    await withApproval(async ({ harness, reviewId }) => {
      const { bureau } = harness;
      // The approval's outcome is written into alice's conversation when it is resolved. After
      // that, bob's session shows the call as still waiting; the continuation must not read it.
      let resolved = false;
      const handler = aliceHandlerOver({
        ...bureau,
        resolveReview: async (...args) => {
          const outcome = await bureau.resolveReview(...args);
          resolved = true;
          return outcome;
        },
        getSession: async (id) => {
          const session = await bureau.getSession(id);
          if (!resolved || session === undefined) return session;
          return bobsCopyOf(session, (messages) => {
            for (const row of Object.values(messages)) {
              if (row.toolResult !== undefined) {
                Object.assign(row.toolResult, { outcome: 'action_required' });
              }
            }
          });
        },
      });

      const frames = await readAgUiStream(await handler(resumeRequest(approveEntry(reviewId))));

      expect(resolved).toBe(true);
      expect(frames.at(-1)!.event).toMatchObject({ type: EventType.RUN_FINISHED });
      expect(frames.map((frame) => frame.event.type)).not.toContain(EventType.RUN_ERROR);
    });
  });
});
