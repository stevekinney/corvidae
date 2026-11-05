/**
 * While the server does not answer, the composer keeps what was typed, Send is off, and the page
 * says why beside Send: "Off until it’s back" (design row 02l). It takes keys again when the
 * server answers.
 */
import { cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CONNECTION_COPY } from '../../app/copy.ts';
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
  test('keeps the typed text, turns Send off, and says why beside it', async () => {
    const monitor = monitorThatIs(false);
    const view = mountWith(monitor);
    await view.findByText('Second answer');
    const composer = view.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    await fireEvent.input(composer, { target: { value: 'What did I approve yesterday?' } });
    expect(view.container.querySelector('.chat-input-paused-reason')).toBeNull();

    monitor.reportUnreachable();

    const reason = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('.chat-input-paused-reason');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(reason.textContent).toBe(CONNECTION_COPY.changesOff);
    expect(composer.value).toBe('What did I approve yesterday?');
    expect(composer.readOnly).toBe(true);
    const send = view.container.querySelector<HTMLButtonElement>('button.chat-input-send')!;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-describedby')).toContain(reason.id);
  });

  test('shows no reason while the server answers', async () => {
    const view = mountWith(monitorThatIs(false));
    await view.findByText('Second answer');
    expect(view.container.querySelector('.chat-input-paused-reason')).toBeNull();
  });
});
