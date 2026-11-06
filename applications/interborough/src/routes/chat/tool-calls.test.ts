/**
 * A turn's tool calls on Cinder's rail: a row per call with its name for a person, its key input
 * and what it answered, an interrupted call that says how little is known, and a chosen row that
 * opens what the call was given and what it answered.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { ToolCallEntry } from './tool-activity.ts';
import Harness from './tool-calls.test-harness.svelte';

function entry(overrides: Partial<ToolCallEntry> & { callId: string }): ToolCallEntry {
  return {
    name: 'lookup-order',
    title: 'Lookup order',
    input: 'A-1',
    arguments: { orderId: 'A-1' },
    state: 'done',
    summary: 'Found the order',
    result: { status: 'shipped' },
    ...overrides,
  };
}

const rowOf = (container: HTMLElement, callId: string) =>
  container.querySelector<HTMLElement>(`[data-cinder-tool-call-row="${callId}"]`);

describe('a turn’s tool calls', () => {
  test('a call shows its name for a person, its key input and one line about the answer', () => {
    const { container } = render(Harness, {
      props: { entries: [entry({ callId: 'c1' })] },
    } as never);
    const row = rowOf(container, 'c1');
    expect(row?.textContent).toContain('Lookup order');
    expect(row?.textContent).toContain('A-1');
    expect(row?.textContent).toContain('→ Found the order');
    // The identifier is the tooltip, not the row's text.
    expect(row?.textContent).not.toContain('lookup-order');
  });

  test('a running call shows Running…, and a call waiting on a person its decision under the row', () => {
    const { container, getByText } = render(Harness, {
      props: {
        entries: [
          entry({ callId: 'c1', state: 'running', summary: '', result: undefined }),
          entry({
            callId: 'c2',
            name: 'issue-refund',
            title: 'Issue refund',
            state: 'needs-you',
            summary: '',
            result: undefined,
          }),
        ],
      },
    } as never);
    expect(rowOf(container, 'c1')?.textContent).toContain('Running…');
    expect(rowOf(container, 'c2')?.textContent).toContain('Waiting on you');
    expect(getByText('Decide on issue-refund')).not.toBeNull();
  });

  test('a call the person refused reads Denied in its own words, never Failed', () => {
    const { container } = render(Harness, {
      props: { entries: [entry({ callId: 'c1', state: 'denied', summary: 'Too much' })] },
    } as never);
    const item = container.querySelector(
      '.cinder-tool-call-rail__item[data-cinder-status="denied"]',
    );
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain('Too much');
    expect(
      container.querySelector('.cinder-tool-call-rail__item[data-cinder-status="failed"]'),
    ).toBeNull();
  });

  test('an interrupted call that only reads says it did not finish, in danger text, with no arrow', () => {
    const { container } = render(Harness, {
      props: {
        entries: [
          entry({
            callId: 'c1',
            state: 'interrupted',
            tier: 'read-only',
            summary: '',
            result: undefined,
          }),
        ],
      },
    } as never);
    const result = container.querySelector(
      '[data-cinder-status="interrupted"] .cinder-tool-call-rail__result',
    );
    expect(result?.textContent?.trim()).toBe('Interrupted · didn’t finish');
  });

  test('an interrupted call that changes things, or that nothing classifies, says it may have run', () => {
    for (const tier of ['mutating', 'dangerous', null, undefined] as const) {
      const { container, unmount } = render(Harness, {
        props: {
          entries: [
            entry({ callId: 'c1', state: 'interrupted', tier, summary: '', result: undefined }),
          ],
        },
      } as never);
      expect(
        container
          .querySelector('[data-cinder-status="interrupted"] .cinder-tool-call-rail__result')
          ?.textContent?.trim(),
      ).toBe('Interrupted · may have run');
      unmount();
    }
  });

  test('choosing a row opens what the call was given and what it answered, and again closes it', async () => {
    const { container, getByText, queryByText } = render(Harness, {
      props: { entries: [entry({ callId: 'c1' })] },
    } as never);
    const row = rowOf(container, 'c1');
    expect(queryByText('orderId')).toBeNull();

    await fireEvent.click(row as HTMLElement);
    expect(getByText('orderId')).not.toBeNull();
    expect(getByText('Result: status')).not.toBeNull();
    expect(getByText('shipped')).not.toBeNull();

    await fireEvent.click(row as HTMLElement);
    expect(queryByText('orderId')).toBeNull();
  });

  test('a result that is not an object is shown as a single result, and no result shows none', async () => {
    const { container, getByText, getAllByText } = render(Harness, {
      props: {
        entries: [
          entry({ callId: 'c1', name: 'count-orders', title: 'Count orders', result: 42 }),
          entry({ callId: 'c2', name: 'ping', title: 'Ping', result: undefined, arguments: {} }),
        ],
      },
    } as never);
    await fireEvent.click(rowOf(container, 'c1') as HTMLElement);
    expect(getByText('Result: result')).not.toBeNull();
    expect(getByText('42')).not.toBeNull();
    await fireEvent.click(rowOf(container, 'c2') as HTMLElement);
    expect(getAllByText(/^Result:/)).toHaveLength(1);
  });

  test('a turn that ends on a tool call closes with the run’s end state', () => {
    const { container } = render(Harness, {
      props: { entries: [entry({ callId: 'c1' })], endLabel: 'Run finished · no reply' },
    } as never);
    expect(container.querySelector('.cinder-tool-call-rail__end')?.textContent).toContain(
      'Run finished · no reply',
    );
  });

  test('three calls fold into a summary line, and an interrupted call is never folded away', () => {
    const entries = [
      ...Array.from({ length: 12 }, (_, index) =>
        entry({ callId: `d${String(index)}`, input: String(index) }),
      ),
      entry({
        callId: 'cut',
        state: 'interrupted',
        tier: 'mutating',
        summary: '',
        result: undefined,
      }),
    ];
    const { container } = render(Harness, { props: { entries } } as never);
    expect(container.querySelector('.cinder-tool-call-rail__summary')?.textContent).toContain(
      'Used 13 tools',
    );
    expect(rowOf(container, 'cut')).not.toBeNull();
  });
});
