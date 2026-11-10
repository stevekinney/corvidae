/**
 * New chat while its agents are read (design row 24o): the placeholders of its own layout with the
 * composer already there, and a Send that cannot be pressed. The skeleton's status line and its
 * Cancel come after ten seconds, which `chat-new-states.spec.ts` runs against the real page.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { flushSync } from 'svelte';

import NewChatLoading from './new-chat-loading.svelte';

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('New chat while its agents load', () => {
  test('is the page in placeholders with the composer already there, and nothing to press', async () => {
    const { container, getByTestId } = render(NewChatLoading, { props: { onCancel: () => {} } });
    expect(getByTestId('new-chat-loading')).not.toBeNull();

    // After the skeleton's own delay the placeholders and the composer are drawn.
    const box = await waitFor(() => {
      const found = container.querySelector<HTMLTextAreaElement>('textarea');
      if (found === null) throw new Error('The composer is not drawn yet.');
      return found;
    });
    expect(box.placeholder).toBe('Message…');
    expect(box.disabled).toBe(true);
    const send = container.querySelector<HTMLButtonElement>('button[data-chat-send]');
    expect(send?.textContent).toContain('Send');
    expect(send?.disabled).toBe(true);
    // Placeholders stand where the avatar, the greeting and the sentence will be and where each
    // control will be; no real greeting is drawn.
    expect(container.querySelectorAll('.cinder-skeleton').length).toBeGreaterThanOrEqual(5);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  test('after 10 s shows the skeleton’s own status line with a Cancel that calls back', async () => {
    jest.useFakeTimers();
    const onCancel = mock(() => undefined);
    const { container } = render(NewChatLoading, { props: { onCancel } });
    flushSync();
    jest.advanceTimersByTime(9_999);
    flushSync();
    expect(container.textContent).not.toContain('Still loading');
    jest.advanceTimersByTime(1);
    flushSync();

    const status = [...container.querySelectorAll('[role="status"]')].find((element) =>
      element.textContent?.includes('Still loading'),
    );
    expect(status).not.toBeUndefined();
    await fireEvent.click(within(status as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
