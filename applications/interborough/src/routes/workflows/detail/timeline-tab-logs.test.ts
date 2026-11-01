import type { WorkflowState, WorkflowTimelineEntry } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { FleetEventFrame } from '../../../lib/live-source/fleet-event-source.svelte.ts';
import { RUN_LOG_CASES, linesOf, logLine } from '../runs/run-log-cases.test-support.ts';
import type { RunLogLine } from '../runs/run-logs-data.ts';
import { openStepNumber } from './steps/open-step.test-support.ts';
import TimelineTabHarness from './timeline-tab.test-harness.svelte';
import { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';

const workflow: WorkflowState = {
  id: 'wf-1',
  type: 'work',
  status: 'completed',
  input: {},
  versionTuple: { workflowVersion: '1' },
  createdAt: 1_000,
  updatedAt: 1_000,
};

class InertFleet {
  caughtUp = false;
  subscribe(_onFrame: (frame: FleetEventFrame) => void): () => void {
    return () => {};
  }
}

function entry(step: number, stepIndex: number | undefined): WorkflowTimelineEntry {
  return {
    step,
    ...(stepIndex === undefined ? {} : { stepIndex }),
    operationType: 'activity',
    operationLabel: `step${String(step)}`,
    inputSummary: '{}',
    timestamp: 1_000 + step,
    status: 'completed',
  };
}

function renderTimeline(entries: WorkflowTimelineEntry[], lines: RunLogLine[] | undefined) {
  return render(TimelineTabHarness, {
    props: {
      client: {
        getTimeline: async () => entries,
        operations: {
          'weft.workflows.activities.pending.list': async () => ({ items: [] }),
          ...(lines === undefined
            ? {}
            : {
                'weft.workflows.logs.list': async () => {
                  return { lines, dropped: 0 };
                },
              }),
        },
        activity: { complete: async () => {}, completeExceptionally: async () => {} },
      },
      workflow,
      liveObservations: new WorkflowLiveObservations(
        new InertFleet(),
        new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        'wf-1',
      ),
      finalizerStatus: null,
      canReadStreams: false,
    },
  });
}

/** The messages in the open step's logs, or null when the open step has no logs section. */
function openStepLogs(container: HTMLElement): string[] | null {
  const section = container.querySelector('[data-section="step-logs"]');
  if (section === null) return null;
  return [...section.querySelectorAll('li')].map((item) => item.textContent ?? '');
}

describe('TimelineTab logs', () => {
  for (const runCase of RUN_LOG_CASES) {
    test(`shows the lines of ${runCase.name} beside the steps they belong to`, async () => {
      const entries = runCase.entries.map((each) => entry(each.step, each.stepIndex));
      const { container, getByRole } = renderTimeline(entries, linesOf(runCase));

      for (const each of runCase.entries) {
        const expected = runCase.byStep.find(([step]) => step === each.step)?.[1] ?? [];
        await openStepNumber(container, each.step);
        if (expected.length === 0) {
          await waitFor(() => expect(openStepLogs(container)).toBeNull());
          continue;
        }
        await waitFor(() =>
          expect(openStepLogs(container)).toEqual(
            expected.map((message) => expect.stringContaining(message)),
          ),
        );
      }

      const before = container.querySelector('[data-section="logs-before-first-step"]');
      if (runCase.beforeFirst.length === 0) {
        expect(before).toBeNull();
      } else {
        await fireEvent.click(getByRole('button', { name: /^Logged before the first step/ }));
        const lines = [...(before?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
        expect(lines).toEqual(
          runCase.beforeFirst.map((message) => expect.stringContaining(message)),
        );
      }
    });
  }

  test('keeps the lines before the first step closed until asked for', async () => {
    const entries = [entry(0, 2)];
    const { findByRole, queryByRole, getByText } = renderTimeline(entries, [
      logLine(0, 0, 'early'),
      logLine(1, 2, 'late'),
    ]);
    const trigger = await findByRole('button', { name: 'Logged before the first step · 1 line' });
    expect(queryByRole('list', { name: 'Log lines from before the first step' })).toBeNull();
    await fireEvent.click(trigger);
    expect(getByText('early')).not.toBeNull();
  });

  test('shows no lines under a step for a run recorded before entries carried a step index', async () => {
    const { container, findByText } = renderTimeline(
      [entry(0, undefined), entry(1, undefined)],
      [logLine(0, 0, 'one')],
    );
    await openStepNumber(container, 0);
    await findByText('Input');
    expect(container.querySelector('[data-section="step-logs"]')).toBeNull();
    expect(container.querySelector('[data-section="logs-before-first-step"]')).toBeNull();
  });

  test('shows no lines under a step when a line has no step', async () => {
    const { container, findByText } = renderTimeline(
      [entry(0, 0)],
      [logLine(0, 0, 'one'), logLine(1, null, 'orphan')],
    );
    await openStepNumber(container, 0);
    await findByText('Input');
    expect(container.querySelector('[data-section="step-logs"]')).toBeNull();
  });

  test('shows no logs for an engine that does not offer log lines', async () => {
    const { container, findByText } = renderTimeline([entry(0, 0)], undefined);
    await openStepNumber(container, 0);
    await findByText('Input');
    expect(container.querySelector('[data-section="step-logs"]')).toBeNull();
  });
});
