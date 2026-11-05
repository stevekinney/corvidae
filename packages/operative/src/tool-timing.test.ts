/**
 * COR-2014: a step's result rows record when each call ran, on the run's clock, so a transcript can
 * say how long a call took even though a step writes its result rows together.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import { resultRowBatch } from './run-step-support';
import { createMockGenerate } from './test/index';
import { TOOL_TIMING_METADATA_KEY, ToolTimingRecorder } from './tool-timing';

const ORIGIN = '2026-11-02T16:41:00.000Z';

describe('tool timing', () => {
  it('records on each result row when its call started and ended, on the run’s clock', async () => {
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const lookup = createTool({
      name: 'lookup-order',
      description: 'Looks an order up',
      input: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => {
        await runtime.advance(400);
        return { orderId, total: '$42.00' };
      },
    });
    const run = createActiveRun({
      generate: createMockGenerate([
        { content: '', toolCalls: [{ name: 'lookup-order', arguments: { orderId: '4471' } }] },
        { content: 'Order 4471 is $42.00.', toolCalls: [] },
      ]),
      toolbox: createTestToolbox([lookup]),
      conversation: new Conversation(undefined, { runtime }),
      stopWhen: noToolCalls(),
      runtime,
    });
    const result = await run.result;
    const rows = result.conversation.getMessages({ includeHidden: true });
    const resultRow = rows.find((row) => row.role === 'tool-result');
    expect(resultRow?.metadata[TOOL_TIMING_METADATA_KEY]).toEqual({
      startedAt: ORIGIN,
      endedAt: '2026-11-02T16:41:00.400Z',
    });
    // The call row was written when the call was asked for, before it ran.
    expect(rows.find((row) => row.role === 'tool-call')?.createdAt).toBe(ORIGIN);
  });

  it('gives a call that never started no timing, and counts only a call’s first settlement', () => {
    let now = 0;
    const recorder = new ToolTimingRecorder(() => new Date(now).toISOString());
    recorder.started(['a']);
    now = 1200;
    recorder.ended('a');
    now = 5000;
    recorder.ended('a');
    recorder.endAll();
    expect(recorder.metadataOf('a')).toEqual({
      [TOOL_TIMING_METADATA_KEY]: {
        startedAt: '1970-01-01T00:00:00.000Z',
        endedAt: '1970-01-01T00:00:01.200Z',
      },
    });
    expect(recorder.metadataOf('b')).toBeUndefined();
    recorder.ended('b');
    expect(recorder.metadataOf('b')).toBeUndefined();
  });

  it('records no time on the row of a call that waits on a person, which has not run', () => {
    const recorder = new ToolTimingRecorder(() => '2026-11-02T16:41:00.000Z');
    recorder.started(['ran', 'asked']);
    recorder.endAll();
    const batch = resultRowBatch(
      { runId: 'run-1', step: 0 },
      [
        { callId: 'ran', outcome: 'success' },
        { callId: 'asked', outcome: 'action_required' },
      ],
      recorder,
    );
    expect(batch?.metadata?.[0]).toEqual({
      [TOOL_TIMING_METADATA_KEY]: {
        startedAt: '2026-11-02T16:41:00.000Z',
        endedAt: '2026-11-02T16:41:00.000Z',
      },
    });
    expect(batch?.metadata?.[1]).toBeUndefined();
    expect(batch?.messageIds).toEqual(['run-1:step:0:result:ran', 'run-1:step:0:result:asked']);
  });
});
