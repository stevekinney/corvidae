/**
 * COR-718 — a schedule's owner lives in its `ScheduledAgentRunInput.principal`.
 * A schedule whose input is not an agent schedule at all (something else
 * registered on the same engine) states no owner, and the local default applies
 * only to a valid agent schedule that names none.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });

describe('the owner of a schedule that is not an agent schedule (COR-718)', () => {
  it('reports no owner, and shows its history to no principal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owner-of-record-schedule-input-'));
    const databasePath = join(directory, 'bureau.sqlite');
    try {
      // Registered straight on the engine, far enough out that it never fires.
      const runtime = await createRuntimeComposition({
        generate,
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
      });
      try {
        await runtime.durable!.engine.schedule(
          'agentRun',
          { kind: 'heartbeat' },
          { every: '24h' },
          { id: 'heartbeat', overlap: 'allow' },
        );
      } finally {
        runtime.durable?.engine[Symbol.dispose]?.();
        runtime.disposeStorage?.();
      }

      const bureau = await createBureau({
        agents: {},
        generate,
        toolbox: createToolbox([], { context: {} }),
        storage: { type: 'sqlite', path: databasePath },
        durableExecution: true,
        durableOwnership: { ownership: 'none' },
        stopWhen: stopWhen.noToolCalls(),
      });
      try {
        expect(await bureau.getOwner({ kind: 'schedule', id: 'heartbeat' })).toBeUndefined();
        expect(
          await bureau.getOwner({ kind: 'audit', runId: 'schedule:heartbeat' }),
        ).toBeUndefined();
        for (const principal of ['anonymous:local', 'api-key:alice']) {
          expect(
            await bureau.eventHistory({ kind: 'schedule', id: 'heartbeat' }, { principal }),
          ).toEqual({ outcome: 'not-found' });
        }
      } finally {
        await bureau.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
