import type { GenerateContext, GenerateFunction, Toolbox } from '@lostgradient/operative';
import {
  AgentScheduledEvent,
  ScheduleCancelledEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  createAgent,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { AgentDefinitions } from './agent-catalog';
import { MemoryStorage } from '@lostgradient/storage';

interface RecordedCall {
  conversationId: string;
  messageCount: number;
  roles: string[];
  userPrompts: string[];
  systemPrompts: string[];
}

/**
 * A generate that records what each fire's agent body saw (conversation id +
 * messages), then returns a final assistant turn so the run stops at step 0.
 */
function createRecordingGenerate(calls: RecordedCall[]): GenerateFunction {
  return async (context: GenerateContext) => {
    const messages = context.conversation.getMessages();
    calls.push({
      conversationId: context.conversation.current.id,
      messageCount: messages.length,
      roles: messages.map((message) => message.role),
      userPrompts: messages
        .filter((message) => message.role === 'user' && typeof message.content === 'string')
        .map((message) => message.content as string),
      systemPrompts: messages
        .filter((message) => message.role === 'system' && typeof message.content === 'string')
        .map((message) => message.content as string),
    });
    return { content: 'acknowledged', toolCalls: [] };
  };
}

function createEmptyToolbox(): Toolbox {
  return createToolbox([], { context: {} }) as unknown as Toolbox;
}

describe('AB-223: schedule definition and fire-terminal lifecycle events', () => {
  it('dispatches SchedulePausedEvent/ScheduleResumedEvent/ScheduleCancelledEvent from Bureau.schedules.pause/resumeSchedule/cancelSchedule', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: createRecordingGenerate([]),
          toolbox: createEmptyToolbox(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });

    try {
      const paused: SchedulePausedEvent[] = [];
      const resumed: ScheduleResumedEvent[] = [];
      const cancelled: ScheduleCancelledEvent[] = [];
      bureau.addEventListener(SchedulePausedEvent.type, (event) => paused.push(event));
      bureau.addEventListener(ScheduleResumedEvent.type, (event) => resumed.push(event));
      bureau.addEventListener(ScheduleCancelledEvent.type, (event) => cancelled.push(event));

      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'paused forever',
        spec: '1h',
      });
      expect(summary).toBeDefined();

      await bureau.schedules.pause(summary!.id);
      await bureau.schedules.resume(summary!.id);
      await bureau.schedules.cancel(summary!.id);

      expect(paused.map((event) => event.scheduleId)).toEqual([summary!.id]);
      expect(resumed.map((event) => event.scheduleId)).toEqual([summary!.id]);
      expect(cancelled.map((event) => event.scheduleId)).toEqual([summary!.id]);
    } finally {
      bureau.dispose();
    }
  });

  it('dispatches AgentScheduledEvent (schedule.created) exactly once from Bureau.schedules.create, carrying scheduleId and the definition summary (AB-298)', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: createRecordingGenerate([]),
          toolbox: createEmptyToolbox(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });

    try {
      const created: AgentScheduledEvent[] = [];
      bureau.addEventListener(AgentScheduledEvent.type, (event) => created.push(event));

      const summary = await bureau.schedules.create({
        agentName: 'default',
        input: 'daily digest',
        spec: '1h',
        sessionId: 'daily-digest',
      });
      expect(summary).toBeDefined();

      expect(created.map((event) => event.type)).toEqual(['schedule.created']);
      expect(created[0]).toMatchObject({
        agentName: 'default',
        scheduleId: summary!.id,
        spec: { every: '1h' },
        sessionId: 'daily-digest',
      });
    } finally {
      bureau.dispose();
    }
  });
});
