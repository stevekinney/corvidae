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

  test('keeps translated Send icon-only while naming it accessibly', async () => {
    const { container } = render(ChatInput, {
      id: 'state-translated-send',
      value: 'A translated draft',
      labels: { send: 'Senden', sendMessage: 'Nachricht senden' },
    });
    const send = sendOf(container);

    expect(send.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(send.textContent?.trim()).toBe('');
    expect(send.getAttribute('aria-label')).toBe('Nachricht senden');
  });

  test('the elevated box and the quiet empty Send are drawn by the composer styles', async () => {
    const source = await Bun.file(new URL('./chat-input.svelte', import.meta.url)).text();
    // COR-2327 AC2: a shadow, a large radius and no outline; a ready draft fills Send, and the box's
    // edge says nothing of it.
    expect(source).toMatch(
      /\.chat-input\s*\{[^}]*border: 1px solid transparent;[^}]*border-radius: var\(--_chat-input-radius\);[^}]*box-shadow: var\(--cinder-shadow-md\);/,
    );
    expect(source).toContain('--_chat-input-radius: calc(var(--cinder-radius-lg) * 2);');
    expect(source).not.toMatch(/\.chat-input\[data-ready\]\s*\{/);
    expect(source).toMatch(
      /:global\(\.chat-input-send:disabled\)\s*\{[^}]*background: transparent;/,
    );
    // Offline Send is the same disabled icon button as an empty one: no warning-coloured variant.
    expect(source).not.toContain('data-offline');
    expect(source).toMatch(/\.chat-input-editor\s*\{[^}]*font-size: var\(--cinder-text-base\);/s);
    expect(source).toMatch(/\.chat-input-markdown\s*\{[^}]*font-size: var\(--cinder-text-base\);/s);
    // The opened list ends on a whole row with no fade over a part row; a line under it counts
    // the files still below.
    expect(source).not.toContain('attachmentScrollFade');
    expect(source).not.toContain('.chat-input-attachments[data-expanded]::after');
    expect(source).toContain('align-items: center;');
    expect(source).toContain('class="chat-input-attachment-scroll-cue"');
    expect(source).toContain('labels.moreAttachments(hiddenListedAttachments)');
  });

  test('an opened list shows whole rows and takes its hit-area room back from the layout', async () => {
    const source = await Bun.file(new URL('./chat-input.svelte', import.meta.url)).text();
    expect(source).toContain('{@attach wholeAttachmentRows}');
    expect(source).toContain('function wholeAttachmentRows(node: HTMLElement)');
    expect(source).toMatch(
      /\.chat-input-attachments\[data-expanded\]\s*\{[^}]*padding-block:\s*var\(--cinder-space-2\);[^}]*margin-block:\s*calc\(var\(--cinder-space-2\) \* -1\);/s,
    );
    // A row scrolled into view stops one padding short of either edge, so its hit area is not clipped.
    expect(source).toMatch(
      /\.chat-input-attachments\[data-expanded\]\s*\{[^}]*scroll-padding-block:\s*var\(--cinder-space-2\);/s,
    );
  });
});

describe('the run toolbar (C4)', () => {
  test('a working run keeps visible progress compact and exposes duration accessibly', () => {
    const { container } = render(ChatInput, {
      id: 'state-running',
      placeholder: 'Message the agent',
      sending: true,
      allowFollowUp: true,
      onstop: () => undefined,
    });

    const running = container.querySelector('[data-chat-running]')!;
    expect(running.classList.contains('cinder-sr-only')).toBe(true);
    expect(running.textContent?.replace(/\s+/gu, ' ').trim()).toBe('Running 0:00');

    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop generating"]',
    )!;
    expect(stop.textContent?.trim()).toBe('');
    expect(stop.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(stop.getAttribute('data-cinder-variant')).not.toBe('danger');
    expect(stop.querySelector('svg')).not.toBeNull();

    expect(editorOf(container).placeholder).toBe('Add another follow-up…');
  });

  test('a loading send keeps its accessible label while showing only the spinner', () => {
    const { container } = render(ChatInput, {
      id: 'state-starting',
      value: 'Draft',
      starting: 'Loading…',
    });
    const send = sendOf(container);
    expect(send.getAttribute('aria-label')).toBe('Loading…');
    expect(send.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(send.textContent).not.toContain('Loading…');
    expect(send.querySelector('.chat-input-spinner')).not.toBeNull();
  });

  test('keeps a translated Stop icon-only while naming it accessibly', () => {
    const { container } = render(ChatInput, {
      id: 'state-translated-stop',
      sending: true,
      labels: { stop: 'Anhalten', stopGenerating: 'Generierung anhalten' },
      onstop: () => undefined,
    });
    const stop = sendOf(container);

    expect(stop.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(stop.textContent?.trim()).toBe('');
    expect(stop.getAttribute('aria-label')).toBe('Generierung anhalten');
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
    expect(drawer.textContent).toContain(
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
    expect(send.hasAttribute('data-cinder-icon-only')).toBe(true);
    // Offline never paints the ready halo, even with a draft in the box.
    expect(form.hasAttribute('data-ready')).toBe(false);
    // The notice is the Cinder callout with its tone icon.
    expect(drawer.getAttribute('data-cinder-variant')).toBe('warning');
    expect(drawer.querySelector('.cinder-callout__icon')).not.toBeNull();
    expect(send.getAttribute('aria-describedby')?.split(' ')).toContain(drawer.id);
  });
});

describe('generic drawer notices', () => {
  test('renders every semantic tone through Cinder Callout', () => {
    for (const tone of ['neutral', 'info', 'warning', 'danger'] as const) {
      const { container } = render(ChatInput, {
        id: `state-notice-${tone}`,
        status: { kind: 'drawer-notice', text: `${tone} notice`, tone },
      });
      const drawer = container.querySelector('[data-chat-composer-drawer="drawer-notice"]')!;
      expect(drawer.getAttribute('data-cinder-variant')).toBe(tone);
      expect(drawer.textContent).toContain(`${tone} notice`);
      cleanup();
    }
  });

  test('a blocking reason is visible and described, while a nonblocking notice leaves Send enabled', async () => {
    const nonblocking = render(ChatInput, {
      id: 'state-notice-enabled',
      status: { kind: 'drawer-notice', text: 'History is ready.', tone: 'info' },
    });
    await fireEvent.input(editorOf(nonblocking.container), {
      target: { value: 'Keep this draft.' },
    });
    await tick();
    expect(sendOf(nonblocking.container).disabled).toBe(false);

    const blocking = render(ChatInput, {
      id: 'state-notice-blocked',
      status: {
        kind: 'drawer-notice',
        text: 'Conversation unavailable.',
        tone: 'warning',
        sendDisabledReason: 'Retry before sending.',
      },
    });
    await fireEvent.input(editorOf(blocking.container), { target: { value: 'Keep this draft.' } });
    await tick();
    expect(blocking.container.querySelector('.chat-input-drawer-reason')?.textContent).toBe(
      'Retry before sending.',
    );
    expect(sendOf(blocking.container).disabled).toBe(true);
    expect(sendOf(blocking.container).getAttribute('aria-describedby')).toContain(
      'state-notice-blocked-drawer',
    );
  });

  test('keeps a notice action in Callout’s dedicated action slot', () => {
    const { container } = render(ChatInput, {
      id: 'state-notice-action',
      status: {
        kind: 'drawer-notice',
        text: 'Conversation unavailable.',
        tone: 'warning',
        action: { label: 'Retry', onclick: () => {} },
      },
    });
    const callout = container.querySelector('[data-chat-composer-drawer="drawer-notice"]')!;
    // Callout's default: the action is inline at the trailing end, wrapping under the text only
    // when the row cannot hold both.
    expect(callout.classList.contains('cinder-callout--inline-action')).toBe(true);
    expect(callout.querySelector('.cinder-callout__action button')?.textContent).toContain('Retry');
    expect(callout.querySelector('.cinder-callout__content .cinder-button')).toBeNull();
  });

  test('clearing a blocking notice enables Send without submitting the draft', async () => {
    let submitted = 0;
    const view = render(ChatInput, {
      id: 'state-notice-clears',
      status: {
        kind: 'drawer-notice',
        text: 'Retry before sending.',
        sendDisabledReason: 'Retry before sending.',
      },
      onsubmit: () => (submitted += 1),
    });
    await fireEvent.input(editorOf(view.container), { target: { value: 'Keep this draft.' } });
    await tick();
    await view.rerender({ status: undefined });
    await tick();
    expect(editorOf(view.container).value).toBe('Keep this draft.');
    expect(sendOf(view.container).disabled).toBe(false);
    expect(submitted).toBe(0);
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
    expect(drawer.textContent).toContain('Restored your unsent draft from yesterday at 4:12 PM.');
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
