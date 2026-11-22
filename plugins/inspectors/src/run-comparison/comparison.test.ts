/// <reference lib="dom" />
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import Comparison from './comparison.svelte';
import { buildComparisonModel, type Comparison as ComparisonData } from './model.ts';
import { createComparisonView } from './view.svelte.ts';

const side = (overrides: Record<string, string | undefined> = {}) => ({
  operationType: 'activity',
  label: 'issueTicket',
  status: 'completed',
  input: '{"order":"ord_1"}',
  output: '{"ticket":{"id":1,"lane":"north"},"cents":4999}',
  ...overrides,
});

const data: ComparisonData = {
  runId: 'fork-1',
  sourceRunId: 'source-1',
  forkPoint: 2,
  steps: [
    {
      index: 0,
      shared: true,
      source: side({ label: 'reserveStock' }),
      fork: side({ label: 'reserveStock' }),
    },
    {
      index: 1,
      shared: false,
      source: side(),
      fork: side({ output: '{"ticket":{"id":2,"lane":"north"},"cents":4999}' }),
    },
    { index: 2, shared: false, source: side({ label: 'notify' }), fork: side({ label: 'notify' }) },
  ],
};

function open() {
  const view = createComparisonView();
  return { view, ...render(Comparison, { props: { view } }) };
}

describe('the run comparison, drawn with Cinder (COR-2544)', () => {
  it('says it is reading the comparison until it is read', () => {
    const { container } = open();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Reading the comparison…',
    );
    expect(container.querySelector('main')).toBeNull();
  });

  it('says so when the comparison could not be read', async () => {
    const { view, container } = open();
    view.phase = 'failed';
    await tick();
    expect(container.textContent).toContain('The comparison could not be read.');
  });

  it('shows the server’s message, as written, for a run it will not compare', async () => {
    const { view, container, getByRole } = open();
    view.message = 'Run run-1 is not a fork, so there is no source to compare it with.';
    view.phase = 'message';
    await tick();
    expect(getByRole('heading', { level: 1, name: 'Run comparison' })).not.toBeNull();
    expect(container.querySelector('[data-comparison-message]')?.textContent).toBe(
      'Run run-1 is not a fork, so there is no source to compare it with.',
    );
    expect(container.querySelector('[data-compared-step]')).toBeNull();
  });

  it('draws the shared steps collapsed and the steps the fork ran again, marked by kind', async () => {
    const { view, container, getByRole, getByText, queryByText } = open();
    view.model = buildComparisonModel(data);
    view.phase = 'ready';
    await tick();

    expect(
      getByRole('heading', { level: 1, name: 'Run fork-1 compared with source-1' }),
    ).not.toBeNull();
    expect(queryByText('Step 1, reserveStock')).toBeNull();
    await fireEvent.click(getByRole('button', { name: '1 step shared with the source' }));
    expect(getByText('Step 1, reserveStock')).not.toBeNull();

    expect(container.querySelector('[data-compared-step="1"]')?.getAttribute('data-kind')).toBe(
      'changed',
    );
    expect(container.querySelector('[data-compared-step="2"]')?.getAttribute('data-kind')).toBe(
      'unchanged',
    );
    expect(getByText('Select a step')).not.toBeNull();
  });

  it('opens a changed step to its output difference, and reads the changed value', async () => {
    const { view, container, getByRole } = open();
    view.model = buildComparisonModel(data);
    view.phase = 'ready';
    await tick();

    await fireEvent.click(getByRole('button', { name: /Step 2, issueTicket/ }));

    expect(view.selectedIndex).toBe(1);
    expect(container.textContent).toContain('The input is the same in both runs.');
    const diff = container.querySelector('[role="group"][aria-label="Output differences, step 2"]');
    expect(diff).not.toBeNull();
    const changed = [...(diff?.querySelectorAll('[data-cinder-diff-kind="changed"]') ?? [])];
    expect(
      changed.map((row) => row.querySelector('.cinder-json-diff-viewer__key')?.textContent),
    ).toContain('id');
    expect(diff?.textContent).toContain('1 → 2');
  });

  it('is operable by keyboard: the step rows are buttons, and the selection is exposed', async () => {
    const { view, getAllByRole } = open();
    view.model = buildComparisonModel(data);
    view.phase = 'ready';
    await tick();

    const rows = getAllByRole('button', { name: /^Step [23]/ });
    expect(rows.map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    await fireEvent.click(rows[1]!);
    expect(rows.map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });
});
