import { activity, Engine, workflow, type WorkflowTimelineEntry } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { projectRunTimeline, RUN_TIMELINE_ENTRY_LIMIT } from './run-timeline.ts';

const SECRET = 'PRIVATE-STEP-PAYLOAD-5e90';

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 1,
    operationType: 'activity',
    operationLabel: 'work',
    inputSummary: SECRET,
    outputSummary: SECRET,
    timestamp: 1_000,
    status: 'completed',
    ...overrides,
  };
}

describe('projectRunTimeline', () => {
  it('copies a step’s label, kind, status, start and duration and nothing it took in or gave back', () => {
    const { entries } = projectRunTimeline([
      entry({
        duration: 40,
        taskOperationId: SECRET,
        branches: [
          {
            index: 0,
            operationId: SECRET,
            operationType: 'activity',
            operationLabel: SECRET,
            outcome: 'won',
          },
        ],
      }),
    ]);
    expect(entries).toEqual([
      {
        step: 1,
        label: 'work',
        operationType: 'activity',
        status: 'completed',
        timestamp: 1_000,
        duration: 40,
        tries: 1,
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });

  it('leaves the duration out of a step that has none', () => {
    const [only] = projectRunTimeline([entry({ status: 'running' })]).entries;
    expect(only).toBeDefined();
    expect('duration' in only!).toBe(false);
  });

  it('counts a step’s tries over the entries that share its step index and kind', () => {
    const { entries } = projectRunTimeline([
      entry({ step: 1, stepIndex: 0, status: 'failed' }),
      entry({ step: 2, stepIndex: 0, operationType: 'sleep', operationLabel: 'retry-sleep' }),
      entry({ step: 3, stepIndex: 0 }),
      entry({ step: 4, stepIndex: 1 }),
      entry({ step: 5 }),
    ]);
    expect(entries.map((served) => served.tries)).toEqual([2, 1, 2, 1, 1]);
  });

  it('counts the attempts of an activity the engine really retried', async () => {
    let attempts = 0;
    const flaky = activity({
      name: 'flaky',
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('not yet');
        return 'done';
      },
    });
    const steady = activity({ name: 'steady', execute: async () => 'ok' });
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'retrying' })
        .activities({ flaky, steady })
        .execute(async function* (ctx) {
          yield* ctx.run(flaky);
          return yield* ctx.run(steady);
        }),
    );
    const handle = await engine.start('retrying', null, { id: 'retrying-1' });
    await handle.result();

    const served = projectRunTimeline(await engine.getTimeline('retrying-1')).entries;

    expect(attempts).toBe(3);
    const flakyEntries = served.filter((step) => step.label === 'flaky');
    expect(flakyEntries.map((step) => step.tries)).toEqual([3, 3, 3]);
    expect(served.filter((step) => step.label === 'steady').map((step) => step.tries)).toEqual([1]);
  });

  it('cuts a run past the limit and says so, without lowering the tries it counted', () => {
    const entries = Array.from({ length: RUN_TIMELINE_ENTRY_LIMIT + 5 }, (_, index) =>
      entry({ step: index + 1, stepIndex: index < 2 ? 0 : index }),
    );
    const projected = projectRunTimeline(entries);
    expect(projected.entries).toHaveLength(RUN_TIMELINE_ENTRY_LIMIT);
    expect(projected.truncated).toBe(true);
    expect(projected.entries[0]?.tries).toBe(2);
    expect(projectRunTimeline(entries.slice(0, 3)).truncated).toBe(false);
  });
});
