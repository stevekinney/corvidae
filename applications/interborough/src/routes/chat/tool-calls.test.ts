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

  test('an approval the Bureau records as decided in Reviews keeps its receipt under the row after a reload (COR-2292 A5)', () => {
    const decidedAt = Date.parse('2026-11-02T16:46:00.000Z');
    const { queryByText } = render(Harness, {
      props: {
        entries: [
          entry({
            callId: 'reviews',
            name: 'issue-refund',
            decision: {
              outcome: 'approved',
              decidedBy: 'priya',
              decidedAt,
              decisionSurface: 'reviews',
            },
          }),
          entry({
            callId: 'chat',
            name: 'send-email',
            decision: {
              outcome: 'approved',
              decidedBy: 'priya',
              decidedAt,
              decisionSurface: 'chat',
            },
          }),
        ],
      },
    } as never);
    // The Reviews decision keeps its receipt, with the place a link to it; one made in the chat
    // reads on its rail row alone, as before.
    expect(queryByText('Decide on issue-refund')).not.toBeNull();
    expect(queryByText('Decide on send-email')).toBeNull();
  });

  test('an expired approval keeps its decision under the canonical rail row', () => {
    const { container, getByText } = render(Harness, {
      props: {
        entries: [
          entry({
            callId: 'expired-call',
            name: 'issue-refund',
            title: 'Issue refund',
            state: 'expired',
            summary: '',
            result: undefined,
          }),
        ],
      },
    } as never);

    expect(
      rowOf(container, 'expired-call')
        ?.closest('.cinder-tool-call-rail__item')
        ?.getAttribute('data-cinder-status'),
    ).toBe('expired');
    expect(getByText('Decide on issue-refund')).not.toBeNull();
  });

  test('updates an approval row when its state changes after the rail mounts', async () => {
    const view = render(Harness, {
      props: {
        entries: [
          entry({
            callId: 'renewed-call',
            name: 'issue-refund',
            title: 'Issue refund',
            state: 'needs-you',
            summary: '',
            result: undefined,
          }),
        ],
      },
    } as never);
    await view.rerender({
      entries: [
        entry({
          callId: 'renewed-call',
          name: 'issue-refund',
          title: 'Issue refund',
          state: 'expired',
          summary: '',
          result: undefined,
        }),
      ],
    } as never);

    expect(
      rowOf(view.container, 'renewed-call')
        ?.closest('.cinder-tool-call-rail__item')
        ?.getAttribute('data-cinder-status'),
    ).toBe('expired');
  });

  test('a failed step says Failed in words, what went wrong, its diagnostic, Copy error and Retry this step (COR-2283 R1 and R7)', async () => {
    const retried: string[] = [];
    const written: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    try {
      const { container } = render(Harness, {
        props: {
          entries: [
            entry({
              callId: 'c1',
              name: 'send-email',
              title: 'Send email',
              state: 'failed',
              summary: 'Mail server didn’t reply.',
              failure: {
                message: 'Mail server didn’t reply.\nConnecting to smtp.example.com:587 timed out.',
                code: 'ETIMEDOUT',
              },
            }),
          ],
          onRetryStep: (callId: string) => void retried.push(callId),
        },
      } as never);
      const failure = container.querySelector<HTMLElement>('.cinder-tool-call-rail__failure')!;
      expect(failure.querySelector('.cinder-tool-call-rail__failure-status')?.textContent).toBe(
        'Failed',
      );
      expect(failure.textContent).toContain('Mail server didn’t reply.');
      expect(failure.querySelector('.cinder-tool-call-rail__diagnostic')?.textContent).toBe(
        'Connecting to smtp.example.com:587 timed out.\nCode: ETIMEDOUT',
      );
      // The error is said under the row, not again after an arrow on it.
      expect(rowOf(container, 'c1')?.textContent).not.toContain('→');
      const links = [...failure.querySelectorAll<HTMLButtonElement>('button')];
      const named = (name: string) => links.find((link) => link.textContent?.trim() === name);
      expect(named('Retry this step')).not.toBeUndefined();

      await fireEvent.click(named('Copy error')!);
      expect(written).toEqual([
        'Mail server didn’t reply.\nConnecting to smtp.example.com:587 timed out.\nCode: ETIMEDOUT',
      ]);
      await fireEvent.click(named('Retry this step')!);
      expect(retried).toEqual(['c1']);
    } finally {
      if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', clipboard);
    }
  });

  test('a failed step offers no Retry this step where the page cannot run it again', () => {
    const { container } = render(Harness, {
      props: {
        entries: [entry({ callId: 'c1', state: 'failed', summary: 'Down.' })],
      },
    } as never);
    const failure = container.querySelector<HTMLElement>('.cinder-tool-call-rail__failure')!;
    expect(failure.textContent).toContain('Copy error');
    expect(failure.textContent).not.toContain('Retry this step');
  });

  test('a running turn says Step N of M, where the call under way falls among the calls so far (COR-2283 R1)', () => {
    const { container } = render(Harness, {
      props: {
        entries: [
          entry({ callId: 'c1' }),
          entry({ callId: 'c2' }),
          entry({ callId: 'c3', state: 'running', summary: '', result: undefined }),
        ],
      },
    } as never);
    expect(container.querySelector('[data-cinder-step-position]')?.textContent?.trim()).toBe(
      'Step 3 of 3',
    );
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
    expect(result?.textContent?.trim()).toBe('Interrupted, didn’t finish');
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
      ).toBe('Interrupted, may have run');
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
      props: { entries: [entry({ callId: 'c1' })], endLabel: 'Run finished, no reply' },
    } as never);
    expect(container.querySelector('.cinder-tool-call-rail__end')?.textContent).toContain(
      'Run finished, no reply',
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

  test('a long turn’s summary line counts the failed and waiting calls and ends with how long the turn took (21q)', () => {
    const entries = [
      ...Array.from({ length: 28 }, (_, index) =>
        entry({ callId: `d${String(index)}`, input: String(index) }),
      ),
      entry({
        callId: 'send',
        name: 'send-email',
        title: 'Send email',
        state: 'failed',
        summary: 'SMTP timeout after 10s',
        result: undefined,
      }),
      entry({
        callId: 'refund',
        name: 'issue-refund',
        title: 'Issue refund',
        state: 'needs-you',
        summary: '',
        result: undefined,
      }),
    ];
    const { container } = render(Harness, { props: { entries, duration: '18s' } } as never);
    const summary = container.querySelector('.cinder-tool-call-rail__summary');
    expect(summary?.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      'Used 30 tools 1 failed 1 waiting on you 18s',
    );
    // The first three and the last three stay, the failed and waiting calls with them, and the
    // other twenty-four fold behind one button.
    expect(container.querySelector('.cinder-tool-call-rail__more')?.textContent).toContain(
      'Show 24 more',
    );
    expect(rowOf(container, 'send')).not.toBeNull();
    expect(rowOf(container, 'refund')).not.toBeNull();
  });

  test('a turn with no recorded times has no duration on its summary line', () => {
    const entries = Array.from({ length: 4 }, (_, index) =>
      entry({ callId: `d${String(index)}`, input: String(index) }),
    );
    const { container } = render(Harness, { props: { entries } } as never);
    expect(container.querySelector('.cinder-tool-call-rail__summary')?.textContent?.trim()).toBe(
      'Used 4 tools',
    );
  });

  test('with a handler for chosen rows, choosing one hands the call to the page and opens nothing under the row', async () => {
    const chosen: string[] = [];
    const { container } = render(Harness, {
      props: {
        entries: [entry({ callId: 'c1' }), entry({ callId: 'c2', input: 'A-2' })],
        onSelect: (callId: string) => chosen.push(callId),
        selectedId: 'c2',
      },
    } as never);
    await fireEvent.click(rowOf(container, 'c1')!);
    expect(chosen).toEqual(['c1']);
    expect(container.querySelector('.ib-tool__details')).toBeNull();
    // The call whose panel is open has its row tinted.
    expect(rowOf(container, 'c2')?.getAttribute('aria-pressed')).toBe('true');
    expect(rowOf(container, 'c1')?.getAttribute('aria-pressed')).not.toBe('true');
  });
});
