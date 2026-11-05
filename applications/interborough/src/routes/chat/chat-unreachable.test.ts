/**
 * While the server does not answer, the chat's composer is replaced by the shared blocked row that
 * says sending is off (design row 17b), so nothing is said beside Send, and what was typed is kept
 * for when the server answers again.
 */
import { cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY } from '../../app/copy.ts';
import { mount, restoreBureau, serve, TURNS } from './chat-more-menu.test-support.ts';

const monitors: ConnectionMonitor[] = [];

afterEach(() => {
  cleanup();
  restoreBureau();
  for (const monitor of monitors.splice(0)) monitor.dispose();
});

function mountWith(monitor: ConnectionMonitor) {
  monitors.push(monitor);
  serve(TURNS, {});
  return mount('session-1', monitor);
}

function monitorThatIs(unreachable: boolean) {
  const monitor = new ConnectionMonitor({
    probe: async () => {
      throw new TypeError('Failed to fetch');
    },
    probeDelayMs: () => 60_000,
    browserOffline: false,
  });
  if (unreachable) monitor.reportUnreachable();
  return monitor;
}

describe('the chat composer while the server does not answer', () => {
  test('swaps the text box for the blocked row, keeps the typed text, and brings both back', async () => {
    const monitor = monitorThatIs(false);
    const view = mountWith(monitor);
    await view.findByText('Second answer');
    const composer = () => view.container.querySelector<HTMLTextAreaElement>('textarea');
    await fireEvent.input(composer()!, { target: { value: 'What did I approve yesterday?' } });
    expect(view.container.querySelector('.chat-input-blocked')).toBeNull();

    monitor.reportUnreachable();

    await waitFor(() => expect(view.container.querySelector('.chat-input-blocked')).not.toBeNull());
    expect(view.container.querySelector('.chat-input-blocked')?.textContent).toContain(
      CHAT_COPY.composer.unreachable,
    );
    expect(composer()).toBeNull();
    expect(view.container.querySelector('.chat-input-paused-reason')).toBeNull();

    monitor.reportReachable();

    await waitFor(() => expect(composer()).not.toBeNull());
    expect(composer()?.value).toBe('What did I approve yesterday?');
  });

  test('shows no blocked row while the server answers', async () => {
    const view = mountWith(monitorThatIs(false));
    await view.findByText('Second answer');
    expect(view.container.querySelector('.chat-input-blocked')).toBeNull();
  });
});
