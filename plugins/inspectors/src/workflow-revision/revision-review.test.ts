/// <reference lib="dom" />
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import { revisionRows, type Definition } from './model.ts';
import RevisionReview from './revision-review.svelte';
import { createRevisionView } from './view.svelte.ts';

const current: Definition = { title: 'Nightly', trigger: { kind: 'manual' }, steps: [] };
const proposed: Definition = {
  title: 'Nightly <b>report</b>',
  trigger: { kind: 'manual' },
  steps: [{ id: 'one' }],
};

function open() {
  const calls: string[] = [];
  const view = createRevisionView();
  const rendered = render(RevisionReview, {
    props: {
      view,
      onApply: () => calls.push('apply'),
      onCheckHash: () => calls.push('check'),
    },
  });
  return { view, calls, ...rendered };
}

async function ready(view: ReturnType<typeof createRevisionView>, state: typeof view.state) {
  const rows = revisionRows(current, proposed);
  view.rows = rows;
  view.changeCount = rows.filter((row) => row.state !== 'unchanged').length;
  view.state = state;
  view.phase = 'ready';
  await tick();
}

describe('the workflow revision review, drawn with Cinder (COR-2218)', () => {
  it('says it is loading until the proposal and the current definition are read', () => {
    const { container } = open();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Loading workflow revision…',
    );
    expect(container.querySelector('main')).toBeNull();
  });

  it('says so when the current definition could not be read', async () => {
    const { view, container } = open();
    view.phase = 'failed';
    await tick();
    expect(container.textContent).toContain('The current workflow could not be read.');
    expect(container.querySelector('button')).toBeNull();
  });

  it('draws the comparison: a heading, a keyboard-reachable region, and a row per part', async () => {
    const { view, container, getByRole } = open();
    await ready(view, 'changed');
    expect(getByRole('heading', { level: 1, name: 'Review workflow revision' })).not.toBeNull();
    expect(getByRole('heading', { level: 2, name: 'Current and proposed' })).not.toBeNull();
    const region = getByRole('region', { name: 'Workflow definition comparison' });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.querySelectorAll('.revision-row')).toHaveLength(view.rows.length);
    const title = region.querySelector('.revision-row[data-state="changed"]');
    expect(title?.textContent).toContain('Nightly');
    // Values are text, never markup.
    expect(container.querySelector('pre b')).toBeNull();
    expect(container.textContent).toContain('Nightly <b>report</b>');
  });

  it('is built from Cinder components, so it takes the host theme through the kit', async () => {
    const { view, container } = open();
    await ready(view, 'changed');
    expect(container.querySelector('.cinder-callout')).not.toBeNull();
    expect(container.querySelectorAll('button.cinder-button').length).toBeGreaterThan(0);
  });

  it('has one polite status line, worded for the state', async () => {
    const { view, container } = open();
    await ready(view, 'changed');
    const statuses = container.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.getAttribute('aria-live')).toBe('polite');
    expect(statuses[0]?.textContent?.trim()).toBe('Review 2 visible changes before applying.');
    view.state = 'conflict';
    await tick();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'The file changed since the proposal.',
    );
    view.message = 'Applied. New hash: abc';
    view.state = 'applied';
    await tick();
    expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Applied. New hash: abc',
    );
  });

  it('offers Apply when there is something to apply, and calls it once per click', async () => {
    const { view, calls, getByRole } = open();
    await ready(view, 'changed');
    const apply = getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(calls).toEqual(['apply']);
    for (const state of ['applying', 'applied', 'no-changes', 'conflict'] as const) {
      view.state = state;
      await tick();
      const button = getByRole('button', {
        name: state === 'applying' ? 'Applying…' : state === 'applied' ? 'Applied' : 'Apply',
      }) as HTMLButtonElement;
      expect(button.disabled, state).toBe(true);
    }
  });

  it('offers a hash check after a failure and a retry once the hash is current', async () => {
    const { view, calls, getByRole, queryByRole } = open();
    await ready(view, 'changed');
    expect(queryByRole('button', { name: 'Check current hash' })).toBeNull();
    view.state = 'offline';
    await tick();
    (getByRole('button', { name: 'Check current hash' }) as HTMLButtonElement).click();
    expect(calls).toEqual(['check']);
    view.state = 'retryable';
    await tick();
    expect(
      (getByRole('button', { name: 'Check current hash' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((getByRole('button', { name: 'Retry Apply' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('redraws in place: the focused Apply button keeps its focus when the status changes', async () => {
    const { view, getByRole } = open();
    await ready(view, 'changed');
    const apply = getByRole('button', { name: 'Apply' });
    apply.focus();
    view.message = 'Still reviewing.';
    await tick();
    expect(document.activeElement).toBe(apply);
  });
});
