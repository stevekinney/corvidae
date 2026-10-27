/**
 * COR-718 — a schedule's owner lives in its `ScheduledAgentRunInput.principal`.
 * A schedule whose input is not an agent schedule at all (something else
 * registered on the same engine) states no owner, and the local default applies
 * only to a valid agent schedule that names none.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createRuntimeComposition } from './runtime-composition';
import type { AgentDefinitions } from './agent-catalog';

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
        durable: true,
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

      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate,
            toolbox: createToolbox([], { context: {} }),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: databasePath },
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
      try {
        expect(await bureau.getOwner({ kind: 'schedule', id: 'heartbeat' })).toBeUndefined();
        expect(
          await bureau.getOwner({ kind: 'audit', runId: 'schedule:heartbeat' }),
        ).toBeUndefined();
        // Nor does it run an agent that can be named: only a valid agent schedule does.
        expect(await bureau.getScheduleAgentName('heartbeat')).toBeUndefined();
        expect(await bureau.getScheduleAgentName('no-such-schedule')).toBeUndefined();
        expect(await bureau.getScheduleInputPreview('heartbeat')).toBeUndefined();
        expect(await bureau.getScheduleInputPreview('no-such-schedule')).toBeUndefined();
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

describe('the start of the text a schedule sends (COR-1654)', () => {
  it('is the whole text when it is short, the text parts joined when it is a list, and cut when it is long', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'schedule-input-preview-'));
    try {
      const bureau = await createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({
            generate,
            toolbox: createToolbox([], { context: {} }),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
        storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
        durable: true,
        durableOwnership: { ownership: 'none' },
      });
      try {
        const short = await bureau.createSchedule({
          agentName: 'default',
          input: 'Summarize what happened yesterday.',
          spec: '24h',
        });
        const parts = await bureau.createSchedule({
          agentName: 'default',
          input: [
            { type: 'text', text: 'Summarize' },
            { type: 'text', text: 'the week.' },
          ],
          spec: '24h',
        });
        const long = await bureau.createSchedule({
          agentName: 'default',
          input: `${'y'.repeat(600)}-TAIL`,
          spec: '24h',
        });
        if (short === undefined || parts === undefined || long === undefined) {
          throw new Error('expected the schedules to be created');
        }

        expect(await bureau.getScheduleInputPreview(short.id)).toBe(
          'Summarize what happened yesterday.',
        );
        expect(await bureau.getScheduleInputPreview(parts.id)).toBe('Summarize the week.');
        const preview = await bureau.getScheduleInputPreview(long.id);
        expect(preview).toBe(`${'y'.repeat(499)}…`);
        expect(preview).not.toContain('TAIL');
      } finally {
        await bureau.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
