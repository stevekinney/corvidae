/**
 * While the server does not answer, a warning drawer sits above the composer (COR-2284 C5): it
 * names Interborough when only the host is down (row 17b's words) and is Chat's offline drawer when
 * the browser itself is offline. The box keeps what was typed, Send is off and is described by the
 * reason, and both come back as they were when the server answers again.
 */
import { cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY } from '../../app/copy/chat.ts';
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

const DRAWER = '[data-chat-composer-drawer]';

describe('the chat composer while the server does not answer', () => {
  test('names Interborough above the box when only the host is down, keeps the typed text with Send off, and clears when it is back', async () => {
    const monitor = monitorThatIs(false);
    const view = mountWith(monitor);
    await view.findByText('Second answer');
    const composer = () => view.container.querySelector<HTMLTextAreaElement>('textarea');
    const drawer = () => view.container.querySelector<HTMLElement>(DRAWER);
    const send = () => view.container.querySelector<HTMLButtonElement>('[data-chat-send]');
    await fireEvent.input(composer()!, { target: { value: 'What did I approve yesterday?' } });
    expect(drawer()).toBeNull();

    monitor.reportUnreachable();

    // Waits assert a boolean, never an element: a failed element assertion serializes the whole
    // happy-dom graph into its message, seconds of blocked loop per retry.
    await waitFor(() => expect(drawer() === null).toBe(false));
    expect(drawer()?.textContent).toContain(CHAT_COPY.composer.hostUnreachable);
    expect(drawer()?.getAttribute('data-cinder-variant')).toBe('warning');
    // The host is down, not the network: the drawer does not say the person is offline.
    expect(drawer()?.textContent).not.toContain('offline');
    expect(view.container.querySelector('.chat-input-blocked')).toBeNull();
    expect(composer()?.value).toBe('What did I approve yesterday?');
    expect(send()?.disabled).toBe(true);
    const described = (send()?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain(CHAT_COPY.composer.unreachable);
    // Enter sends nothing either, and the text stays in the box.
    await fireEvent.keyDown(composer()!, { key: 'Enter' });
    expect(composer()?.value).toBe('What did I approve yesterday?');
    expect(view.container.textContent).not.toContain('Not sent');

    monitor.reportReachable();

    await waitFor(() => expect(drawer() === null).toBe(true));
    expect(composer()?.value).toBe('What did I approve yesterday?');
    expect(send()?.disabled).toBe(false);
  });

  test('is Chat’s offline drawer when the browser itself is offline', async () => {
    const monitor = monitorThatIs(false);
    const view = mountWith(monitor);
    await view.findByText('Second answer');

    monitor.setBrowserOffline(true);

    await waitFor(() =>
      expect(view.container.querySelector('[data-chat-composer-drawer="offline"]') === null).toBe(
        false,
      ),
    );
    expect(view.container.querySelector(DRAWER)?.textContent).toContain('Your draft is saved here');
  });

  test('shows no drawer and no blocked row while the server answers', async () => {
    const view = mountWith(monitorThatIs(false));
    await view.findByText('Second answer');
    expect(view.container.querySelector(DRAWER)).toBeNull();
    expect(view.container.querySelector('.chat-input-blocked')).toBeNull();
  });
});
