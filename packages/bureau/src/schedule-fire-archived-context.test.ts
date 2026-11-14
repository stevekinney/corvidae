/**
 * COR-2285 — a schedule whose fires continue one context starts no fire in it while it is archived:
 * the fire is refused before it writes anything, naming `context-archived`, and the next fire after
 * an unarchive continues the context as before.
 */
import { createAgent, type Toolbox } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { ContextBusyError } from './bureau-errors';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';

const SESSION = 'archived-schedule-session';

/** Fires the schedule now and resolves the fire's workflow once it is terminal. */
async function fireNow(bureau: Bureau, scheduleId: string) {
  const fired = await bureau.schedules.runNow(scheduleId);
  const workflowId = fired !== undefined && 'workflowId' in fired ? fired.workflowId : '';
  expect(workflowId).not.toBe('');
  let terminal: { status: string; error?: string | undefined } | null | undefined;
  await waitUntil(async () => {
    const state = await bureau.durableEngine()!.get(workflowId);
    if (state === null || state === undefined) return false;
    if (state.status === 'pending' || state.status === 'running') return false;
    terminal = state;
    return true;
  });
  return terminal!;
}

describe('a schedule’s fire into an archived context', () => {
  it('is refused and writes nothing, and the next fire after an unarchive continues the context', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'acknowledged', toolCalls: [] }),
          toolbox: createToolbox([]) as unknown as Toolbox,
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      maintenance: 'manual',
    });
    try {
      const schedule = await bureau.schedules.create({
        agentName: 'default',
        input: 'check in',
        spec: '1h',
        sessionId: SESSION,
      });
      const first = await fireNow(bureau, schedule!.id);
      expect(first.status).toBe('completed');
      // The fire's task settles a little after its workflow does; until then it is a live task.
      await waitUntil(async () => {
        try {
          return (await bureau.contexts.archive(SESSION)) !== undefined;
        } catch (error) {
          if (error instanceof ContextBusyError) return false;
          throw error;
        }
      });
      const before = await bureau.contexts.get(SESSION);

      const refused = await fireNow(bureau, schedule!.id);

      expect(refused.status).not.toBe('completed');
      expect(JSON.stringify(refused)).toContain('context-archived');
      const after = await bureau.contexts.get(SESSION);
      expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids);

      await bureau.contexts.unarchive(SESSION);
      const resumed = await fireNow(bureau, schedule!.id);
      expect(resumed.status).toBe('completed');
      const continued = await bureau.contexts.get(SESSION);
      expect(continued!.conversationHistory.ids.length).toBeGreaterThan(
        before!.conversationHistory.ids.length,
      );
    } finally {
      await bureau.dispose();
    }
  });
});
