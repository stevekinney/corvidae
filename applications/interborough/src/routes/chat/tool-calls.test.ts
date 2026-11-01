/**
 * A turn's tool calls: a row per call with where it stands, a chevron that opens what it was
 * given and what it answered, and a fold for a turn with several that never hides a call waiting
 * on a person.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { ToolCallEntry } from './tool-activity.ts';
import Harness from './tool-calls.test-harness.svelte';

function entry(overrides: Partial<ToolCallEntry> & { callId: string }): ToolCallEntry {
  return {
    name: 'lookup-order',
    arguments: { orderId: 'A-1' },
    state: 'done',
    summary: 'Found the order',
    result: { status: 'shipped' },
    ...overrides,
  };
}

describe('a turn’s tool calls', () => {
  test('a single call shows its name, where it stands and one line about the answer', () => {
    const view = render(Harness, { props: { entries: [entry({ callId: 'c1' })] } } as never);

    expect(view.getByText('lookup-order')).not.toBeNull();
    expect(view.getByRole('img', { name: 'Done' })).not.toBeNull();
    expect(view.getByText('Found the order')).not.toBeNull();
    // One call is not folded into a group.
    expect(view.queryByRole('button', { name: 'Show tool calls' })).toBeNull();
  });

  test('each state is named for a person, and a running or waiting call has no answer line', () => {
    const view = render(Harness, {
      props: {
        entries: [
          entry({
            callId: 'c1',
            state: 'failed',
            summary: 'Order service down',
            result: undefined,
          }),
          entry({ callId: 'c2', state: 'running', summary: '', result: undefined }),
          entry({ callId: 'c3', state: 'needs-you', summary: '', result: undefined }),
        ],
      },
    } as never);

    // Several calls fold, but the failed row is shown once the group opens.
    return fireEvent.click(view.getByRole('button', { name: 'Show tool calls' })).then(() => {
      expect(view.getByRole('img', { name: 'Failed' })).not.toBeNull();
      expect(view.getByRole('img', { name: 'Running' })).not.toBeNull();
      expect(view.getByRole('img', { name: 'Needs you' })).not.toBeNull();
      expect(view.getByText('Order service down')).not.toBeNull();
      expect(view.getByText('Waiting for your approval')).not.toBeNull();
    });
  });

  test('a call the person refused reads Denied, in muted text, and not Failed', async () => {
    const view = render(Harness, {
      props: { entries: [entry({ callId: 'c1', state: 'denied', summary: 'Too much' })] },
    } as never);

    expect(view.getByRole('img', { name: 'Denied' })).not.toBeNull();
    expect(view.queryByRole('img', { name: 'Failed' })).toBeNull();
    expect(view.getByText('Too much')).not.toBeNull();
  });

  test('the chevron on a call lists what the call was given and what it answered', async () => {
    const view = render(Harness, { props: { entries: [entry({ callId: 'c1' })] } } as never);
    const details = view.getByRole('button', { name: 'Details for lookup-order' });
    expect(details.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(details);

    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(view.getByText('orderId')).not.toBeNull();
    expect(view.getByText('A-1')).not.toBeNull();
    expect(view.getByText('Result: status')).not.toBeNull();
    expect(view.getByText('shipped')).not.toBeNull();

    await fireEvent.click(details);
    expect(view.queryByText('orderId')).toBeNull();
  });

  test('a result that is not an object is shown as a single result, and no result shows none', async () => {
    const view = render(Harness, {
      props: {
        entries: [
          entry({ callId: 'c1', name: 'count-orders', result: 42 }),
          entry({ callId: 'c2', name: 'ping', result: undefined, arguments: {} }),
        ],
      },
    } as never);
    await fireEvent.click(view.getByRole('button', { name: 'Show tool calls' }));

    await fireEvent.click(view.getByRole('button', { name: 'Details for count-orders' }));
    expect(view.getByText('Result: result')).not.toBeNull();
    expect(view.getByText('42')).not.toBeNull();

    await fireEvent.click(view.getByRole('button', { name: 'Details for ping' }));
    expect(view.getAllByText(/^Result:/)).toHaveLength(1);
  });

  test('several calls fold into one line, and a call waiting on a person stays outside the fold', async () => {
    const view = render(Harness, {
      props: {
        entries: [
          entry({ callId: 'c1', name: 'lookup-order' }),
          entry({ callId: 'c2', name: 'issue-refund', state: 'needs-you', summary: '' }),
        ],
      },
    } as never);

    // Folded: the finished call is hidden, the waiting one and its decision are not.
    expect(view.queryByText('lookup-order')).toBeNull();
    expect(view.getByText('issue-refund')).not.toBeNull();
    expect(view.getByText('Decide on issue-refund')).not.toBeNull();

    const toggle = view.getByRole('button', { name: 'Show tool calls' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);

    expect(view.getByText('lookup-order')).not.toBeNull();
    const hide = view.getByRole('button', { name: 'Hide tool calls' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(hide);
    expect(view.queryByText('lookup-order')).toBeNull();
  });

  test('the fold line names each tool with its count, and every toggle is an icon button, not a worded one', async () => {
    const view = render(Harness, {
      props: {
        entries: [
          entry({ callId: 'c1', name: 'lookup-order' }),
          entry({ callId: 'c2', name: 'lookup-order' }),
        ],
      },
    } as never);

    expect(view.getByText('Used 2 tools · lookup-order ×2')).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Show tool calls' }));
    const buttons = view.getAllByRole('button');
    // The group's chevron and one on each of the two calls.
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.hasAttribute('aria-expanded')).toBe(true);
    }
  });
});
