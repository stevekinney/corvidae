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

    expect(getByRole('heading', { level: 1, name: 'Compared with the source run' })).not.toBeNull();
    // No run id is printed anywhere in the panel.
    expect(container.textContent).not.toContain('fork-1');
    expect(container.textContent).not.toContain('source-1');
    expect(queryByText('Step 1, reserveStock')).toBeNull();
    await fireEvent.click(getByRole('button', { name: '1 step the same as the source' }));
    expect(getByText('Step 1, reserveStock')).not.toBeNull();

    expect(container.querySelector('[data-compared-step="1"]')?.getAttribute('data-kind')).toBe(
      'changed',
    );
    expect(container.querySelector('[data-compared-step="2"]')?.getAttribute('data-kind')).toBe(
      'unchanged',
    );
    expect(getByText('Select a step')).not.toBeNull();
  });

  it('uses one word, Same, for a step that kept the source’s result and one that ran again the same', async () => {
    const { view, container, getByRole } = open();
    view.model = buildComparisonModel(data);
    view.phase = 'ready';
    await tick();

    await fireEvent.click(getByRole('button', { name: '1 step the same as the source' }));
    const keptBadge = container.querySelector('[data-shared-step="0"] .cinder-badge');
    const reranBadge = container.querySelector('[data-compared-step="2"] .cinder-badge');
    expect(keptBadge?.textContent?.trim()).toBe('Same');
    expect(reranBadge?.textContent?.trim()).toBe('Same');
    expect(container.textContent).not.toContain('Shared');
  });

  it('draws the steps as one Cinder list, each row one element that a spec or a person can name', async () => {
    const { view, container } = open();
    view.model = buildComparisonModel(data);
    view.phase = 'ready';
    await tick();

    expect(container.querySelectorAll('.cinder-list-detail')).toHaveLength(1);
    for (const index of [1, 2]) {
      expect(container.querySelectorAll(`[data-compared-step="${String(index)}"]`)).toHaveLength(1);
      expect(
        container
          .querySelector(`[data-compared-step="${String(index)}"]`)
          ?.closest('.cinder-selectable-row'),
      ).not.toBeNull();
    }
    // The "Differs in …" line is the row's own description, not a loose element.
    expect(
      container.querySelector('[data-compared-step="1"] .cinder-selectable-row__description')
        ?.textContent,
    ).toBe('Differs in output');
    expect(
      container.querySelector('[data-compared-step="2"] .cinder-selectable-row__description'),
    ).toBeNull();
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

  it('is operable by keyboard: the step rows are buttons, and the open one is marked current', async () => {
    const { view, container, getAllByRole } = open();
    view.model = buildComparisonModel(data);
    view.phase = 'ready';
    await tick();

    const rows = getAllByRole('button', { name: /^Step [23]/ });
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, null]);
    await fireEvent.click(rows[1]!);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true']);
    // Cinder marks the open row on its root too, which is what draws the selected state.
    expect(
      container
        .querySelector('.cinder-selectable-row[data-cinder-selected] [data-compared-step]')
        ?.getAttribute('data-compared-step'),
    ).toBe('2');
  });

  it('leaves the placeholder at the start of its pane, beside the list, not centred away from it', async () => {
    const { view, container } = open();
    view.model = buildComparisonModel(data);
    view.phase = 'ready';
    await tick();

    const placeholder = container.querySelector(
      '.cinder-list-detail__detail-body .comparison-detail',
    );
    expect(placeholder?.textContent).toContain('Select a step');
    // It is the plain leading-aligned block, never Cinder's centred empty state.
    expect(
      container.querySelector('.cinder-list-detail__detail-body .cinder-empty-state'),
    ).toBeNull();
  });
});
