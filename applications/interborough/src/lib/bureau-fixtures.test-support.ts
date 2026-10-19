/**
 * Task and review rows as the Bureau answers them, for the tests of the Tasks area and of
 * `/reviews`. Each is the whole wire shape, so a test changes only what it is about.
 */
import type { ChatContext } from './bureau-client.ts';
import type { BureauHumanWait, BureauToolApproval } from './bureau-reviews.ts';
import type { TaskView } from './bureau-tasks.ts';

export function taskFixture(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'run-1',
    contextId: 'session-1',
    agentName: 'assistant',
    owner: 'anonymous:local',
    actor: null,
    status: 'working',
    finishReason: null,
    statusMessage: null,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:00:01.000Z',
    cleanup: null,
    openWaits: [],
    ...overrides,
  };
}

export function toolApprovalFixture(
  overrides: Partial<BureauToolApproval> = {},
): BureauToolApproval {
  return {
    id: 'approval:run-1:call-1',
    runId: 'run-1',
    agentName: 'tool-runner',
    requestedAt: 1_792_436_554_182,
    ageMilliseconds: 10,
    status: 'pending',
    sessionId: 'session-1',
    kind: 'tool-approval',
    round: 0,
    approval: {
      callId: 'call-1',
      toolName: 'issue-refund',
      arguments: { orderId: 'order-1001', cents: 4200 },
      reason: 'Tool "issue-refund" requires approval.',
      action: {
        type: 'approval',
        message: 'Refund order-1001?',
        risk: 'high',
        operation: { kind: 'other' },
      },
      policyPauseTier: 'capability',
    },
    ...overrides,
  };
}

export function humanWaitFixture(overrides: Partial<BureauHumanWait> = {}): BureauHumanWait {
  return {
    id: 'human-wait:run-2:environment:0',
    runId: 'run-2',
    agentName: 'request-human-input',
    requestedAt: 1_792_436_540_952,
    ageMilliseconds: 12,
    status: 'pending',
    kind: 'human-wait',
    signalName: 'environment',
    prompt: 'Which environment should the release go to?',
    ...overrides,
  };
}

/** A chat session as `bureau.contexts.get` shows it. */
export function contextFixture(id: string, overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    id,
    owner: 'anonymous:local',
    agentName: 'assistant',
    title: null,
    lastMessagePreview: null,
    messageCount: 2,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:00:01.000Z',
    activity: 'idle',
    ...overrides,
  };
}
