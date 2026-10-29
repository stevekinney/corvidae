import { stopWhen, type GenerateFunction, createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { ScheduledFireNotice } from './runtime-composition';
import type { RunAttribution } from './serialization';
import {
  attributeScheduledFire,
  recordScheduleFired,
  releaseScheduledFire,
} from './scheduled-fire-record';
import type { AgentDefinitions } from './agent-catalog';
import { MemoryStorage } from '@lostgradient/storage';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

const fireOf = (index: number): ScheduledFireNotice => ({
  runId: `fire-${index}`,
  scheduleId: 'schedule-1',
  sessionId: `sched-schedule-1-fire-${index}`,
  agentName: 'worker',
  owner: 'api-key:alice',
  message: 'work',
});

describe('the attribution of a schedule fire (COR-718)', () => {
  it('holds an entry while the fire runs, and none once it has settled, however many fires there are', () => {
    const runAttribution = new Map<string, RunAttribution>();
    const firedRunIds = new Set<string>();
    runAttribution.set('interactive-run', { agentName: 'default', principal: 'api-key:bob' });

    for (let index = 0; index < 100; index += 1) {
      attributeScheduledFire(runAttribution, firedRunIds, fireOf(index));
      expect(runAttribution.get(`fire-${index}`)).toEqual({
        agentName: 'worker',
        principal: 'api-key:alice',
      });
      releaseScheduledFire(runAttribution, firedRunIds, `fire-${index}`);
    }

    expect(runAttribution.size).toBe(1);
    expect(firedRunIds.size).toBe(0);
  });

  it('never releases an attribution that a fire did not record', () => {
    const runAttribution = new Map<string, RunAttribution>();
    const firedRunIds = new Set<string>();
    runAttribution.set('interactive-run', { agentName: 'default', principal: 'api-key:bob' });

    releaseScheduledFire(runAttribution, firedRunIds, 'interactive-run');

    expect(runAttribution.has('interactive-run')).toBe(true);
  });
});

describe('the schedule.fired entry (COR-718)', () => {
  it('is written once when the same fire is recorded concurrently, as two instances rebuilding it would', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: new MemoryStorage(),
      durable: false,
    });
    try {
      const trail = bureau.internals.auditTrail!;
      const fire = fireOf(1);

      await Promise.all([recordScheduleFired(trail, fire), recordScheduleFired(trail, fire)]);
      await recordScheduleFired(trail, fire);

      const entries = await trail.query({ runId: fire.runId, type: 'schedule.fired' });
      expect(entries.map((entry) => entry.principal)).toEqual(['system:scheduler']);
    } finally {
      await bureau.dispose();
    }
  });
});
