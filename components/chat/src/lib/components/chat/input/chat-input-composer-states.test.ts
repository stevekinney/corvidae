/// <reference lib="dom" />
/**
 * The composer's states from the Composer board (COR-2284): an empty composer's outlined, muted
 * Send (C1); a ready composer's accent border, ring and filled Send (C2); the run toolbar with its
 * clock, the outlined Stop and the follow-up placeholder (C4); the offline drawer that keeps the
 * draft and names itself on Send (C5); and the draft-restored drawer with Discard draft (C7).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: ChatInput } = await import('./chat-input.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function sendOf(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-chat-send]')!;
}

function editorOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
}

describe('empty and ready (C1, C2)', () => {
  test('an empty composer leaves Send outlined and off, and the box unmarked', () => {
    const { container } = render(ChatInput, { id: 'state-empty' });
    const send = sendOf(container);

    expect(send.disabled).toBe(true);
    expect(send.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(container.querySelector('form.chat-input')?.hasAttribute('data-ready')).toBe(false);
  });

  test('a draft marks the box ready and fills Send with the accent', async () => {
    const { container } = render(ChatInput, { id: 'state-ready' });

    await fireEvent.input(editorOf(container), { target: { value: 'Refund order 4471.' } });
    await tick();

    expect(container.querySelector('form.chat-input')?.hasAttribute('data-ready')).toBe(true);
    expect(sendOf(container).getAttribute('data-cinder-variant')).toBe('primary');
    expect(sendOf(container).disabled).toBe(false);
  });

  test('the ready ring and the quiet empty Send are drawn by the composer styles', async () => {
    const source = await Bun.file(new URL('./chat-input.svelte', import.meta.url)).text();
    expect(source).toMatch(
      /\.chat-input\[data-ready\]\s*\{[^}]*border-color: var\(--cinder-accent-solid\);[^}]*box-shadow: 0 0 0 3px/,
    );
    expect(source).toMatch(
      /:global\(\.chat-input-send:disabled\)\s*\{[^}]*background: transparent;/,
    );
  });
});

describe('the run toolbar (C4)', () => {
  test('a working run shows Running and its clock, icon-only Stop, and the follow-up placeholder', () => {
    const { container } = render(ChatInput, {
      id: 'state-running',
      placeholder: 'Message the agent',
      sending: true,
      allowFollowUp: true,
      onstop: () => undefined,
    });

    const running = container.querySelector('[data-chat-running]')!;
    expect(running.querySelector('.chat-input-running-label')?.textContent).toBe('Running');
    expect(running.querySelector('.chat-input-running-time')?.textContent).toBe('0:00');
    expect(running.textContent).not.toContain(String.fromCodePoint(0xb7));

    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop generating"]',
    )!;
    expect(stop.textContent?.trim()).toBe('');
    expect(stop.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(stop.querySelector('svg')).not.toBeNull();

    expect(editorOf(container).placeholder).toBe('Add another follow-up…');
  });

  test('an idle composer has no run toolbar and keeps its own placeholder', () => {
    const { container } = render(ChatInput, {
      id: 'state-idle',
      placeholder: 'Message the agent',
      allowFollowUp: true,
    });

    expect(container.querySelector('[data-chat-running]')).toBeNull();
    expect(editorOf(container).placeholder).toBe('Message the agent');
  });
});

describe('the offline drawer (C5)', () => {
  test('says the draft is kept, keeps it, and turns Send off naming the drawer as the reason', async () => {
    const { container } = render(ChatInput, {
      id: 'state-offline',
      value: 'Draft about order 4471',
      status: { kind: 'offline' },
    });
    await tick();

    const drawer = container.querySelector<HTMLElement>('[data-chat-composer-drawer="offline"]')!;
    expect(drawer.querySelector('.chat-input-drawer-text')?.textContent).toBe(
      "You're offline. Your draft is saved here, and Send comes back when you reconnect.",
    );
    // The drawer sits above the box, outside the text column.
    const form = container.querySelector('form.chat-input')!;
    expect(form.contains(drawer)).toBe(false);
    expect(drawer.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It is a drawer, not the line under the box.
    expect(container.querySelector('.chat-input-status')).toBeNull();

    expect(editorOf(container).value).toBe('Draft about order 4471');
    const send = sendOf(container);
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-describedby')?.split(' ')).toContain(drawer.id);
  });
});

describe('the draft-restored drawer (C7)', () => {
  test('says when the draft is from, and Discard draft empties the box and tells the host', async () => {
    let discarded = 0;
    const { container } = render(ChatInput, {
      id: 'state-restored',
      value: 'Half-written reply',
      status: {
        kind: 'draft-restored',
        when: 'yesterday at 4:12 PM',
        ondiscard: () => {
          discarded += 1;
        },
      },
    });
    await tick();

    const drawer = container.querySelector<HTMLElement>(
      '[data-chat-composer-drawer="draft-restored"]',
    )!;
    expect(drawer.querySelector('.chat-input-drawer-text')?.textContent).toBe(
      'Restored your unsent draft from yesterday at 4:12 PM.',
    );
    // A restored draft can still be sent.
    expect(sendOf(container).disabled).toBe(false);

    const discard = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Discard draft',
    )!;
    await fireEvent.click(discard);
    await tick();

    expect(editorOf(container).value).toBe('');
    expect(discarded).toBe(1);
  });
});
