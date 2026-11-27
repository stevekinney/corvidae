import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import type { WaterfallBar } from '@lostgradient/interborough-plugin/step-waterfall';
import { logLine } from '../../runs/run-log-cases.test-support.ts';
import StepDetail from './step-detail.svelte';

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

  test('keeps a successful entry on the ordinary Input and Output grid', () => {
    const { container } = render(StepDetail, { props: { entry: entry(), bar, open: true } });
    const fields = container.querySelectorAll('.ib-step-detail__fields > section');
    expect(fields).toHaveLength(2);
    expect(fields[0]?.textContent).toContain('Input');
    expect(fields[0]?.querySelector('pre')?.textContent).toBe('{\n  "orderId": "ord_1"\n}');
    expect(fields[1]?.textContent).toContain('Output');
    expect(fields[1]?.querySelector('pre')?.textContent).toContain('"chargeId": "ch_1"');
    expect(container.querySelector('.ib-step-detail__fields--failed')).toBeNull();
    expect(container.querySelector('[data-section="step-logs"] button')).toBeNull();
  });

  test('hides only the confirmed document execution ID and preserves nested user input', () => {
    const input = {
      input: { workflowId: 'user-id', value: 'hello' },
      trigger: null,
      previous: null,
      workflowId: 'run-id',
      step: 1,
      stepAddress: '1',
    };
    const value = entry({ inputSummary: JSON.stringify(input) });
    const confirmed = render(StepDetail, {
      props: { entry: value, documentWorkflowId: 'run-id', bar, open: false },
    });
    const shown =
      confirmed.container.querySelector('section[aria-label="Input"] pre')?.textContent ?? '';
    expect(shown).not.toContain('run-id');
    expect(shown).toContain('user-id');
    confirmed.unmount();
    const ordinary = render(StepDetail, { props: { entry: value, bar, open: false } });
    expect(ordinary.container.textContent).toContain('run-id');
  });

  test('uses independent payload views and a disclosure for a failed step', async () => {
    const { getByRole, container } = render(StepDetail, {
      props: {
        entry: entry({
          status: 'failed',
          inputSummary: '{"orderId":"ord_1","token":"[REDACTED]"}',
          outputSummary: 'card declined',
        }),
        bar,
        open: true,
        logs: [logLine(0, 1, 'declined')],
      },
    });
    const input = within(getByRole('group', { name: /^Input$/ }));
    const error = within(getByRole('group', { name: /^Error$/ }));
    expect(input.getByText('ord_1')).not.toBeNull();
    expect(input.getByText('[REDACTED]')).not.toBeNull();
    expect(error.getByText('card declined')).not.toBeNull();
    await fireEvent.click(input.getByRole('radio', { name: 'JSON' }));
    expect(input.getByRole('radio', { name: 'JSON' }).getAttribute('aria-checked')).toBe('true');
    expect(input.getByText(/\[REDACTED\]/)).not.toBeNull();
    expect(error.getByRole('radio', { name: 'Fields' }).getAttribute('aria-checked')).toBe('true');
    const logs = container.querySelector('[data-section="step-logs"] button');
    expect(logs?.textContent?.trim()).toBe('Logs');
    expect(logs?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.ib-step-detail__fields--failed')).not.toBeNull();
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

  test('lists the lines logged under the step, in the order logged', () => {
    const { container } = render(StepDetail, {
      props: {
        entry: entry(),
        bar,
        open: true,
        logs: [logLine(0, 1, 'charging'), logLine(1, 1, 'charged')],
      },
    });
    const section = container.querySelector('[data-section="step-logs"]');
    expect(section?.querySelector('h4')?.textContent).toBe('Logs');
    expect(section?.querySelector('button')).toBeNull();
    expect([...(section?.querySelectorAll('li') ?? [])].map((item) => item.textContent)).toEqual([
      expect.stringContaining('charging'),
      expect.stringContaining('charged'),
    ]);
  });

  test('has no Logs section for a step with no lines, or when none could be placed', () => {
    for (const logs of [undefined, []] as const) {
      const { container, unmount } = render(StepDetail, {
        props: { entry: entry(), bar, open: true, logs },
      });
      expect(container.querySelector('[data-section="step-logs"]')).toBeNull();
      unmount();
    }
  });
});
