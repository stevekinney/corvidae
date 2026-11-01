import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import StepDetail from './step-detail.svelte';
import type { WaterfallBar } from './step-waterfall.ts';

type EntryOverrides = { [K in keyof WorkflowTimelineEntry]?: WorkflowTimelineEntry[K] | undefined };

function entry(overrides: EntryOverrides = {}): WorkflowTimelineEntry {
  // A key set to `undefined` stands for an entry the engine reported without it.
  return {
    step: 1,
    operationType: 'activity',
    operationLabel: 'chargeCard',
    inputSummary: '{"orderId":"ord_1"}',
    outputSummary: '{"chargeId":"ch_1"}',
    timestamp: 1_000,
    duration: 18,
    status: 'completed',
    ...overrides,
  } as WorkflowTimelineEntry;
}

const bar: WaterfallBar = { offset: 0, width: 10, open: false, instant: false, startedAfter: 5 };

describe('StepDetail', () => {
  test('opens with the name and one status line: the word, when it started, how long it took, and the raw name', () => {
    const { getByRole, container } = render(StepDetail, {
      props: { entry: entry(), bar, open: true },
    });
    expect(getByRole('heading', { level: 3, name: 'Charge card' })).not.toBeNull();
    const status = container.querySelector('.ib-step-detail__status')?.textContent ?? '';
    expect(status).toContain('Succeeded');
    expect(status).toContain('started +5ms');
    expect(status).toContain('took 18ms');
    expect(status).toContain('chargeCard');
  });

  test('shows input and output side by side, indented', () => {
    const { container } = render(StepDetail, { props: { entry: entry(), bar, open: true } });
    const fields = container.querySelectorAll('.ib-step-detail__fields > section');
    expect(fields).toHaveLength(2);
    expect(fields[0]?.textContent).toContain('Input');
    expect(fields[0]?.querySelector('pre')?.textContent).toBe('{\n  "orderId": "ord_1"\n}');
    expect(fields[1]?.textContent).toContain('Output');
    expect(fields[1]?.querySelector('pre')?.textContent).toContain('"chargeId": "ch_1"');
  });

  test('labels the output Error for a failed step', () => {
    const { container } = render(StepDetail, {
      props: {
        entry: entry({ status: 'failed', outputSummary: 'card declined' }),
        bar,
        open: true,
      },
    });
    const field = container.querySelectorAll('.ib-step-detail__fields > section')[1];
    expect(field?.textContent).toContain('Error');
    expect(field?.textContent).toContain('card declined');
  });

  test('says nothing was kept for a step with no output yet', () => {
    const { getByText } = render(StepDetail, {
      props: {
        entry: entry({ status: 'running', outputSummary: undefined, duration: undefined }),
        bar: { ...bar, open: true },
        open: true,
      },
    });
    expect(getByText('Nothing was kept.')).not.toBeNull();
    expect(getByText('still going')).not.toBeNull();
  });

  test('lists the branches of a step that ran several things, and how many were left out', () => {
    const { container } = render(StepDetail, {
      props: {
        entry: entry({
          operationType: 'race',
          operationLabel: 'race',
          branches: [
            {
              index: 0,
              key: 'fast',
              operationId: 'a',
              operationType: 'activity',
              operationLabel: 'fastPath',
              outcome: 'won',
            },
            {
              index: 1,
              operationId: 'b',
              operationType: 'activity',
              operationLabel: 'slowPath',
              outcome: 'rejected',
              errorSummary: 'timed out',
            },
          ],
          branchesOmitted: 3,
        }),
        bar,
        open: true,
      },
    });
    const branches = container.querySelectorAll('.ib-step-detail__branch');
    expect(branches).toHaveLength(2);
    expect(branches[0]?.textContent).toContain('fast');
    expect(branches[0]?.textContent).toContain('won');
    expect(branches[1]?.textContent).toContain('slowPath');
    expect(branches[1]?.textContent).toContain('failed');
    expect(branches[1]?.textContent).toContain('timed out');
    expect(container.textContent).toContain('3 more not listed');
  });

  test('says when the engine did not report the branches of a group', () => {
    const { getByText } = render(StepDetail, {
      props: {
        entry: entry({ operationType: 'parallel', operationLabel: 'parallel' }),
        bar,
        open: true,
      },
    });
    expect(getByText('This step’s branches were not reported.')).not.toBeNull();
  });

  test('says a running entry the run has left has ended, not that it is running', () => {
    const { container } = render(StepDetail, {
      props: {
        entry: entry({ status: 'running', duration: undefined }),
        bar: { ...bar, open: false },
        open: false,
      },
    });
    const status = container.querySelector('.ib-step-detail__status')?.textContent ?? '';
    expect(status).toContain('Ended');
    expect(status).not.toContain('Running');
    expect(status).not.toContain('still going');
  });

  test('has no start to show for a step with no bar', () => {
    const { container } = render(StepDetail, {
      props: { entry: entry({ duration: undefined }), bar: undefined, open: true },
    });
    expect(container.querySelector('.ib-step-detail__status')?.textContent).toContain(
      'no start time kept',
    );
  });

  test('renders what the step offers to do', () => {
    const actions = createRawSnippet(() => ({ render: () => '<button>Complete…</button>' }));
    const { getByRole } = render(StepDetail, {
      props: { entry: entry(), bar, open: true, actions },
    });
    expect(getByRole('button', { name: 'Complete…' })).not.toBeNull();
  });
});
