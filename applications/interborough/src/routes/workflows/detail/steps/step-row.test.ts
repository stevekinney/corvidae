import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import StepRow from './step-row.svelte';
import type { WaterfallBar } from './step-waterfall.ts';

type EntryOverrides = { [K in keyof WorkflowTimelineEntry]?: WorkflowTimelineEntry[K] | undefined };

function entry(overrides: EntryOverrides = {}): WorkflowTimelineEntry {
  // A key set to `undefined` stands for an entry the engine reported without it.
  return {
    step: 3,
    operationType: 'activity',
    operationLabel: 'chargeCard',
    inputSummary: '{}',
    timestamp: 1_000,
    duration: 18,
    status: 'completed',
    ...overrides,
  } as WorkflowTimelineEntry;
}

const bar: WaterfallBar = { offset: 25, width: 50, open: false, instant: false, startedAfter: 5 };

function row(overrides: Partial<{ selected: boolean; open: () => void }> = {}) {
  return { selected: false, active: false, open: () => {}, ...overrides };
}

describe('StepRow', () => {
  test('names the step in words and in code, with how long it took', () => {
    const { getByText } = render(StepRow, {
      props: { entry: entry(), bar, open: true, row: row() },
    });
    expect(getByText('Charge card')).not.toBeNull();
    expect(getByText('chargeCard')).not.toBeNull();
    expect(getByText('18ms')).not.toBeNull();
  });

  test('places the bar by the step’s start and duration, as a share of the run', () => {
    const { container } = render(StepRow, {
      props: { entry: entry(), bar, open: true, row: row() },
    });
    const drawn = container.querySelector<HTMLElement>('.ib-step-row__bar');
    expect(drawn?.getAttribute('style')).toContain('inset-inline-start: 25%');
    expect(drawn?.getAttribute('style')).toContain('inline-size: 50%');
    expect(drawn?.getAttribute('data-status')).toBe('completed');
    const track = container.querySelector('[data-waterfall]');
    expect(track?.getAttribute('aria-label')).toBe('Started 5ms into the run, took 18ms');
  });

  test('draws a track and no bar for a step with no start time, and says so', () => {
    const { container } = render(StepRow, {
      props: { entry: entry(), bar: undefined, open: true, row: row() },
    });
    expect(container.querySelector('.ib-step-row__bar')).toBeNull();
    expect(container.querySelector('[data-waterfall]')?.getAttribute('aria-label')).toBe(
      'no start time kept',
    );
  });

  test('marks a step still going as open and shows no duration for it', () => {
    const { container, getByText } = render(StepRow, {
      props: {
        entry: entry({ status: 'running', duration: undefined }),
        bar: { ...bar, open: true },
        open: true,
        row: row(),
      },
    });
    expect(container.querySelector('.ib-step-row__bar')?.hasAttribute('data-open')).toBe(true);
    expect(getByText('running')).not.toBeNull();
  });

  test('shows a running entry the run has left as ended, with a neutral bar', () => {
    const { container, getByRole, queryByText } = render(StepRow, {
      props: {
        entry: entry({ status: 'running', duration: undefined }),
        bar: { ...bar, open: false },
        open: false,
        row: row(),
      },
    });
    expect(getByRole('img', { name: 'Ended' })).not.toBeNull();
    expect(queryByText('running')).toBeNull();
    expect(container.querySelector('.ib-step-row__bar')?.getAttribute('data-status')).toBe('ended');
  });

  test('opens the step when it is chosen', async () => {
    let opened = 0;
    const { getByRole } = render(StepRow, {
      props: { entry: entry(), bar, open: true, row: row({ open: () => (opened += 1) }) },
    });
    await fireEvent.click(getByRole('button', { name: /Charge card/ }));
    expect(opened).toBe(1);
  });
});
