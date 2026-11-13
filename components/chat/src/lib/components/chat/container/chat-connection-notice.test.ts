/**
 * The connection notice stands by the composer (owner decision, 2026-11-13): the dropped stream is
 * about the connection, so its warning, progress line and Retry sit with the composer's other
 * notices and not under the partial reply.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import type { ChatTurnState } from '../message/turn-state.ts';

setupHappyDom();

const { fireEvent, render, cleanup } = await import('@testing-library/svelte');
const { default: ChatConnectionNotice } = await import('./chat-connection-notice.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const reconnecting: Extract<ChatTurnState, { kind: 'reconnecting' }> = {
  kind: 'reconnecting',
  attempt: 2,
  attempts: 5,
  nextTryIn: 8,
  wait: 10,
};

describe('ChatConnectionNotice', () => {
  test('reads the exact template as a warning note with Retry inline and a draining bar', async () => {
    const retry = mock(() => undefined);
    const { container, getByRole } = render(ChatConnectionNotice, {
      props: { turn: reconnecting, onRetry: retry },
    });
    const notice = container.querySelector('.chat-connection-notice');
    expect(notice?.getAttribute('data-kind')).toBe('reconnecting');
    expect(notice?.querySelector('[role="note"]')?.getAttribute('data-cinder-variant')).toBe(
      'warning',
    );
    expect(notice?.querySelector('.cinder-callout--inline-action')).not.toBeNull();
    expect(notice?.querySelector('.cinder-callout__icon svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(notice?.querySelector('.chat-connection-text')?.textContent?.trim()).toBe(
      'Connection lost. Reconnecting, attempt 2 of 5. Next try in 8s.',
    );

    const bar = getByRole('progressbar', { name: 'Time until the next try' });
    expect(bar.getAttribute('aria-valuenow')).toBe('80');
    expect(bar.getAttribute('aria-valuetext')).toBe('8s');

    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('the bar drains as the host counts the next try down', async () => {
    const view = render(ChatConnectionNotice, { props: { turn: reconnecting } });
    await view.rerender({ turn: { ...reconnecting, nextTryIn: 3 } });
    await tick();
    const bar = view.getByRole('progressbar', { name: 'Time until the next try' });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(view.container.querySelector('.chat-connection-text')?.textContent).toContain(
      'Next try in 3s.',
    );
  });

  test('without the callback there is no Retry', () => {
    const { queryByRole } = render(ChatConnectionNotice, { props: { turn: reconnecting } });
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
