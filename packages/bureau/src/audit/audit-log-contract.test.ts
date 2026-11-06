/**
 * COR-2009 — PageAuditLog: what the audit log's rows are built from, read back through
 * `bureau.audit.query` (the wire's redacted view, not the raw trail). The log records actions and
 * decisions, never chat messages, and names a chat by the session it ran in, so the page shows its
 * real title. The sample world's refund reads, in order: you started a run in the chat, the agent
 * asked to run Issue refund (the review it waits in is named), you approved it, and the call ran.
 * A schedule's missed occurrences are recorded when the Bureau notices them.
 */
import { createAgent, createMockGenerate, stopWhen, type Toolbox } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createAuditTrail } from '../audit-trail.ts';
import { createBureau } from '../create-bureau.ts';
import { type BureauEventMap, ScheduleMissedEvent } from '../events.ts';
import { waitForCondition } from '../test';
import { createAudit } from './create-audit.ts';
import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import type { Bureau } from '../types.ts';

/** A Bureau that is only an event target, for a trail's dedicated listeners. */
function createStubBureau(): { bureau: Bureau; emit: (event: Event) => void } {
  const target = new CompletableEventTarget<BureauEventMap>();
  const bureau = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Bureau;
  return { bureau, emit: (event) => void target.dispatchEvent(event) };
}

const REQUEST = 'Please refund order 4471, it arrived damaged.';

function refundToolbox(refunds: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'issue-refund',
        version: '1.0.0',
        description: 'Refund an order to the original card',
        input: z.object({ order: z.string(), cents: z.number() }),
        async execute({ cents }) {
          refunds.push(cents);
          return { refunded: cents };
        },
      }),
    ],
    {
      approvalSecret: 'audit-log-contract',
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Refunds wait for a person',
            action: { message: 'Refund order 4471 for $42.00?' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

describe('the audit log of a refund in a chat', () => {
  it('reads started, asked, approved and refunded, naming the chat and the review, and holds no message', async () => {
    const refunds: number[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        'tool-runner': createAgent({
          generate: createMockGenerate([
            {
              content: '',
              toolCalls: [
                {
                  id: 'call-4471',
                  name: 'issue-refund',
                  arguments: { order: '4471', cents: 4200 },
                },
              ],
            },
          ]),
          toolbox: refundToolbox(refunds),
          stopWhen: stopWhen.toolOutcome('action_required'),
        }),
      },
      storage: new MemoryStorage(),
    });
    try {
      const run = await bureau.tasks.start('tool-runner', REQUEST, {
        principal: 'anonymous:local',
      });
      await waitForCondition(
        async () => bureau.reviews.list().length > 0,
        'the refund never asked',
      );
      const [review] = bureau.reviews.list();
      await bureau.reviews.resolve({
        id: review!.id,
        decision: 'approve',
        principal: 'anonymous:local',
      });
      expect(refunds).toEqual([4200]);

      let page = await bureau.audit.query({ runId: run.id, limit: 100 });
      await waitForCondition(async () => {
        page = await bureau.audit.query({ runId: run.id, limit: 100 });
        return page.records.some(
          (record) => record.type === 'tool.settled' && record.detail?.['status'] === 'success',
        );
      }, 'the approved call was never recorded');

      const story = page.records.filter(
        (record) =>
          record.type === 'run.started' ||
          record.type === 'tool.settled' ||
          record.type.startsWith('review.'),
      );
      expect(story.map((record) => [record.type, record.principal, record.detail])).toEqual([
        ['run.started', 'anonymous:local', { agentName: 'tool-runner', sessionId: run.contextId }],
        [
          'tool.settled',
          null,
          {
            agentName: 'tool-runner',
            status: 'paused',
            toolName: 'issue-refund',
            toolCallId: 'call-4471',
          },
        ],
        [
          'review.tool-approval.approved',
          'anonymous:local',
          {
            agentName: 'tool-runner',
            kind: 'tool-approval',
            sessionId: run.contextId,
            toolName: 'issue-refund',
            reviewId: review!.id,
            callId: 'call-4471',
          },
        ],
        [
          'tool.settled',
          null,
          {
            agentName: 'tool-runner',
            status: 'success',
            toolName: 'issue-refund',
            toolCallId: 'call-4471',
            reviewId: review!.id,
          },
        ],
      ]);
      // The ask names the review it waits in: `approval:<runId>:<toolCallId>`.
      expect(review!.id).toBe(`approval:${run.id}:call-4471`);

      // Actions and decisions, never messages: no record is a message, and none carries the chat's
      // text, the tool's arguments, its result, or the approval prompt.
      const everything = await bureau.audit.query({ limit: 100 });
      expect(everything.records.some((record) => /message/i.test(record.type))).toBe(false);
      const text = JSON.stringify(everything);
      for (const content of [REQUEST, '4200', 'Refund order 4471 for $42.00?', 'refunded']) {
        expect(text).not.toContain(content);
      }
    } finally {
      await bureau.dispose();
    }
  });
});

describe('a schedule’s missed occurrences', () => {
  it('are recorded under the schedule, by the scheduler, with how many and why', async () => {
    const { bureau, emit } = createStubBureau();
    const trail = createAuditTrail(bureau, textValueStore(new MemoryStorage()));
    try {
      emit(
        new ScheduleMissedEvent('daily-summary', 4, 1_793_000_000_000, 1_793_300_000_000, 'late'),
      );
      // load-proof: the write runs on in-memory storage and settles through promise continuations only, so a turn of the event loop completes it; no timer or I/O is pending
      await yieldToPortableEventLoop();

      const audit = createAudit({
        trail: () => trail,
        ownerOf: async () => undefined,
        refusal: (message) => new Error(message),
      });
      const page = await audit.query({ type: 'schedule.missed' });
      expect(
        page.records.map((record) => [record.resource, record.principal, record.detail]),
      ).toEqual([
        [
          'schedule:daily-summary',
          'system:scheduler',
          { scheduleId: 'daily-summary', missedCount: 4, missedReason: 'late' },
        ],
      ]);
    } finally {
      trail.dispose();
    }
  });
});

describe('a host’s start', () => {
  it('names the version it started at, and nothing else of what the host recorded', async () => {
    const { bureau } = createStubBureau();
    const trail = createAuditTrail(bureau, textValueStore(new MemoryStorage()));
    try {
      await trail.record({
        runId: 'host',
        type: 'host.started',
        principal: 'system:host',
        detail: { version: '2.4.1', environment: 'a secret the log must not carry' },
      });
      const audit = createAudit({
        trail: () => trail,
        ownerOf: async () => undefined,
        refusal: (message) => new Error(message),
      });
      const page = await audit.query({ type: 'host.started' });
      expect(page.records.map((record) => record.detail)).toEqual([{ version: '2.4.1' }]);
    } finally {
      trail.dispose();
    }
  });
});

describe('a deleted chat (COR-2018)', () => {
  it('keeps its title and how many messages it held, which no other event’s record keeps', async () => {
    const { bureau } = createStubBureau();
    const trail = createAuditTrail(bureau, textValueStore(new MemoryStorage()));
    try {
      await trail.record({
        runId: 'session:chat-1',
        type: 'session.deleted',
        principal: 'anonymous:local',
        detail: {
          sessionId: 'chat-1',
          title: 'Scratch test',
          messageCount: 12,
          content: 'a message the log must not carry',
        },
      });
      await trail.record({
        runId: 'run-1',
        type: 'run.started',
        principal: 'anonymous:local',
        detail: { agentName: 'assistant', title: 'Not a deletion', messageCount: 3 },
      });
      const audit = createAudit({
        trail: () => trail,
        ownerOf: async () => undefined,
        refusal: (message) => new Error(message),
      });
      const page = await audit.query({ types: ['session.deleted', 'run.started'] });
      const detail = Object.fromEntries(page.records.map((record) => [record.type, record.detail]));
      expect(detail['session.deleted']).toEqual({
        sessionId: 'chat-1',
        title: 'Scratch test',
        messageCount: 12,
      });
      expect(detail['run.started']).toEqual({ agentName: 'assistant' });
    } finally {
      trail.dispose();
    }
  });

  it('is recorded by a real delete with the chat’s title and message count, and no message text beyond the title', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        assistant: createAgent({
          generate: createMockGenerate([{ content: 'Hello back', toolCalls: [] }]),
        }),
      },
      storage: new MemoryStorage(),
    });
    try {
      const run = await bureau.tasks.start('assistant', 'Scratch test', {
        principal: 'anonymous:local',
      });
      await waitForCondition(async () => {
        const context = await bureau.contexts.get(run.contextId);
        return (context?.conversationHistory.ids.length ?? 0) >= 2;
      }, 'the chat never held both messages');
      await bureau.contexts.delete(run.contextId, { actor: 'api-key:alice' });
      let deleted = await bureau.audit.query({ type: 'session.deleted', limit: 10 });
      await waitForCondition(async () => {
        await bureau.maintain();
        deleted = await bureau.audit.query({ type: 'session.deleted', limit: 10 });
        return deleted.records.length > 0;
      }, 'the deletion was never recorded');
      expect(deleted.records.map((record) => record.detail)).toEqual([
        expect.objectContaining({ title: 'Scratch test', messageCount: 2 }),
      ]);
      // A delete asked for by a caller names it; the owner is not the actor.
      expect(deleted.records.map((record) => record.principal)).toEqual(['api-key:alice']);
      expect(JSON.stringify(deleted)).not.toContain('Hello back');
    } finally {
      await bureau.dispose();
    }
  });
});
