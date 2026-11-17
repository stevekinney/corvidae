/**
 * While the server does not answer, Chat's offline warning drawer sits above the composer (COR-2284
 * C5): the box keeps what was typed, Send is off and names the drawer as the reason, and both come
 * back as they were when the server answers again.
 */
import { cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
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
  test('shows the offline drawer above the box, keeps the typed text with Send off, and clears when it is back', async () => {
    const monitor = monitorThatIs(false);
    const view = mountWith(monitor);
    await view.findByText('Second answer');
    const composer = () => view.container.querySelector<HTMLTextAreaElement>('textarea');
    const drawer = () =>
      view.container.querySelector<HTMLElement>('[data-chat-composer-drawer="offline"]');
    const send = () => view.container.querySelector<HTMLButtonElement>('[data-chat-send]');
    await fireEvent.input(composer()!, { target: { value: 'What did I approve yesterday?' } });
    expect(drawer()).toBeNull();

    monitor.reportUnreachable();

    await waitFor(() => expect(drawer()).not.toBeNull());
    expect(drawer()?.textContent).toContain('Your draft is saved here');
    expect(view.container.querySelector('.chat-input-blocked')).toBeNull();
    expect(composer()?.value).toBe('What did I approve yesterday?');
    expect(send()?.disabled).toBe(true);
    expect(send()?.getAttribute('aria-describedby')?.split(' ')).toContain(drawer()!.id);
    // Enter sends nothing either, and the text stays in the box.
    await fireEvent.keyDown(composer()!, { key: 'Enter' });
    expect(composer()?.value).toBe('What did I approve yesterday?');
    expect(view.container.textContent).not.toContain('Not sent');

    monitor.reportReachable();

    await waitFor(() => expect(drawer()).toBeNull());
    expect(composer()?.value).toBe('What did I approve yesterday?');
    expect(send()?.disabled).toBe(false);
  });

  test('shows no offline drawer and no blocked row while the server answers', async () => {
    const view = mountWith(monitorThatIs(false));
    await view.findByText('Second answer');
    expect(view.container.querySelector('[data-chat-composer-drawer="offline"]')).toBeNull();
    expect(view.container.querySelector('.chat-input-blocked')).toBeNull();
  });
});
