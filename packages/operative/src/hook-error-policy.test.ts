/**
 * COR-2128 — a hook's own `onError` is honored at every point of {@link OperativeHookMap}.
 *
 * A plugin interceptor writes a hook as `{ handler, onError }`, and `onError: () => 'continue'`
 * promises that a throwing handler does not fail the step. The registry's `run`, `runFirst` and
 * `runLast` apply that policy themselves; a point Operative iterates by hand must apply it too, or
 * the promise silently fails at that point (`beforeToolExecution` once did). This table has one row
 * for each point, so a new point that forgets the policy is a red row, and a point added to the
 * map without a row fails the coverage test.
 *
 * Each row drives a run where the hook is on the path, with a handler that throws and an
 * `onError` that continues, and compares the outcome with the same run with no hook at all. Rows
 * that settle the handler without asking (the five observing points and `onError`) must leave the
 * run's own outcome standing either way.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { type CompactionScheduler, Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import type { OperativeHookMap } from './hooks';
import { executeLoop } from './loop';
import type { FinishReason, GenerateResponse } from './types';

type Point = Extract<keyof OperativeHookMap, string>;

const lookup = createTool({
  name: 'lookup',
  description: 'look something up',
  input: z.object({}),
  execute: async () => 'ok',
});

/** One scenario that puts a hook point on the run's path, and how the run ends without a hook. */
interface Row {
  readonly point: Point;
  /** How the run finishes when no hook is registered. */
  readonly baseline: FinishReason;
  /**
   * Whether a throwing handler with no `onError` ends the run in `error`. False for the points
   * Operative settles without asking, where the run's own outcome stands whatever the handler does.
   */
  readonly critical: boolean;
  /** Shapes the run: the generator, the toolbox, the context management and the signal. */
  readonly scenario?: 'tool' | 'compaction' | 'background' | 'generate-error' | 'abort';
}

const ROWS: readonly Row[] = [
  { point: 'prepareStep', baseline: 'stop-condition', critical: true },
  { point: 'beforeToolExecution', baseline: 'stop-condition', critical: true, scenario: 'tool' },
  { point: 'afterToolExecution', baseline: 'stop-condition', critical: true, scenario: 'tool' },
  { point: 'onStep', baseline: 'stop-condition', critical: true },
  { point: 'selectTools', baseline: 'stop-condition', critical: true },
  { point: 'validateResponse', baseline: 'stop-condition', critical: true },
  { point: 'validateToolResult', baseline: 'stop-condition', critical: true, scenario: 'tool' },
  {
    point: 'beforeCompaction',
    baseline: 'stop-condition',
    critical: true,
    scenario: 'compaction',
  },
  {
    point: 'beforeBackgroundCompaction',
    baseline: 'stop-condition',
    critical: true,
    scenario: 'background',
  },
  { point: 'afterCompaction', baseline: 'stop-condition', critical: true, scenario: 'compaction' },
  { point: 'selectToolChoice', baseline: 'stop-condition', critical: true },
  { point: 'beforeGenerate', baseline: 'stop-condition', critical: true },
  { point: 'afterGenerate', baseline: 'stop-condition', critical: true },
  { point: 'onLLMInput', baseline: 'stop-condition', critical: false },
  { point: 'onLLMOutput', baseline: 'stop-condition', critical: false },
  { point: 'onRunStart', baseline: 'stop-condition', critical: true },
  { point: 'onRunComplete', baseline: 'stop-condition', critical: false },
  { point: 'onRunError', baseline: 'error', critical: false, scenario: 'generate-error' },
  { point: 'onRunAbort', baseline: 'aborted', critical: false, scenario: 'abort' },
  { point: 'onError', baseline: 'error', critical: false, scenario: 'generate-error' },
];

function text(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

/** Runs `row`'s scenario, with `register` called on a fresh registry; resolves how it ended. */
async function finishOf(row: Row, register?: (hooks: HookRegistry<OperativeHookMap>) => void) {
  const hooks = new HookRegistry<OperativeHookMap>();
  register?.(hooks);
  const controller = new AbortController();
  let calls = 0;
  const generate = async (): Promise<GenerateResponse> => {
    calls += 1;
    if (row.scenario === 'generate-error') throw new Error('The model is down.');
    if (row.scenario === 'abort') {
      controller.abort();
      throw new Error('aborted while generating');
    }
    if (row.scenario === 'tool' && calls === 1) {
      return { content: '', toolCalls: [{ name: 'lookup', arguments: {} }] };
    }
    return text('done');
  };
  const conversation = new Conversation();
  conversation.appendUserMessage('Hello there, this is long enough to count as tokens.');
  const scheduler = {
    conversation,
    request: async () => undefined,
    cancel: async () => undefined,
  } as unknown as CompactionScheduler;
  // A throw out of `prepareStep`'s `selectTools` and `selectToolChoice` rejects the loop instead of
  // settling it as `error`; either way the run did not finish, which is all a row asks.
  const result = await executeLoop({
    generate,
    toolbox: row.scenario === 'tool' ? createTestToolbox([lookup]) : createTestToolbox([]),
    conversation,
    stopWhen: noToolCalls(),
    hooks,
    signal: controller.signal,
    ...(row.scenario === 'compaction'
      ? {
          contextManagement: {
            maxTokens: 1000,
            compactionThreshold: 1,
            onCompact: async () => undefined,
          },
        }
      : {}),
    ...(row.scenario === 'background'
      ? {
          contextManagement: {
            maxTokens: 100_000,
            compactionThreshold: 90_000,
            onCompact: async () => undefined,
            background: { threshold: 1, scheduler },
          },
        }
      : {}),
  }).catch((): { finishReason: FinishReason } => ({ finishReason: 'error' }));
  return result.finishReason;
}

/** A hook for `row.point` that records its calls and throws. */
function throwing(point: Point, calls: { count: number }, options: { continues: boolean }) {
  return (hooks: HookRegistry<OperativeHookMap>) => {
    hooks.on(
      point,
      async () => {
        calls.count += 1;
        throw new Error(`The ${point} hook broke.`);
      },
      options.continues ? { onError: () => 'continue' } : {},
    );
  };
}

describe('every point of the hook map', () => {
  it('has a row in the table', () => {
    // The map's keys, written out once: a key added to OperativeHookMap must be added here, and then
    // to ROWS, or this fails.
    const KEYS: Record<Point, true> = {
      prepareStep: true,
      beforeToolExecution: true,
      afterToolExecution: true,
      onStep: true,
      selectTools: true,
      validateResponse: true,
      validateToolResult: true,
      beforeCompaction: true,
      beforeBackgroundCompaction: true,
      afterCompaction: true,
      selectToolChoice: true,
      beforeGenerate: true,
      afterGenerate: true,
      onLLMInput: true,
      onLLMOutput: true,
      onRunStart: true,
      onRunComplete: true,
      onRunError: true,
      onRunAbort: true,
      onError: true,
    };
    expect(new Set(ROWS.map((row) => row.point))).toEqual(new Set(Object.keys(KEYS)));
    expect(ROWS).toHaveLength(20);
  });

  describe.each(ROWS)('$point', (row) => {
    it('finishes the way the scenario says with no hook registered', async () => {
      expect(await finishOf(row)).toBe(row.baseline);
    });

    it('lets a throwing handler with onError: continue leave the run’s outcome alone', async () => {
      const calls = { count: 0 };
      const finish = await finishOf(row, throwing(row.point, calls, { continues: true }));
      expect(calls.count).toBeGreaterThan(0);
      expect(finish).toBe(row.baseline);
    });

    it(
      row.critical
        ? 'ends the run in error for a throwing handler that has no onError'
        : 'leaves the run’s own outcome standing for a throwing handler that has no onError',
      async () => {
        const calls = { count: 0 };
        const finish = await finishOf(row, throwing(row.point, calls, { continues: false }));
        expect(calls.count).toBeGreaterThan(0);
        expect(finish).toBe(row.critical ? 'error' : row.baseline);
      },
    );
  });
});
