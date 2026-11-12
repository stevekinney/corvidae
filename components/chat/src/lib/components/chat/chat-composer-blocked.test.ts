/**
 * The blocked composer: one compact row in place of the text box and the controls, saying why
 * sending is off, with an optional button and an optional quiet link; and the control row of the
 * live composer around it.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: ChatInput } = await import('./input/chat-input.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const BLOCKED_REASON = 'Connect a model provider to chat';

describe('a blocked composer', () => {
  test('keeps the glyph with its reason, so only the actions leave for a line of their own on a narrow card', () => {
    const { container } = render(ChatInput, {
      id: 'blocked-unit',
      status: {
        kind: 'blocked',
        reason: BLOCKED_REASON,
        action: { label: 'Connect a provider', onclick: () => undefined },
      },
    });

    const message = container.querySelector('.chat-input-blocked-message')!;
    expect(message.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
    expect(message.querySelector('.chat-input-blocked-reason')?.textContent).toBe(BLOCKED_REASON);
    const actions = container.querySelector('.chat-input-blocked-actions')!;
    expect(actions.parentElement).toBe(message.parentElement);
    expect(message.contains(actions)).toBe(false);
  });

  test('on a phone-width composer the actions fill a line of their own, as touch targets', async () => {
    const source = await Bun.file(new URL('./input/chat-input.svelte', import.meta.url)).text();
    const narrow = /@media \(max-width: 639\.98px\) \{([\s\S]*?)\n  \}\n/u.exec(
      source.slice(source.indexOf('.chat-input-blocked-actions {')),
    )?.[1];

    expect(narrow).toContain('flex: 1 0 100%;');
    expect(narrow).not.toContain('justify-content: flex-end');
    expect(narrow).toMatch(/\.cinder-button\) \{[^}]*flex: 1 1 auto;[^}]*min-block-size/u);
  });

  test('draws one row with the reason, and no text box, controls or Send', () => {
    const { container } = render(ChatInput, {
      id: 'blocked',
      status: { kind: 'blocked', reason: BLOCKED_REASON },
    });

    const row = container.querySelector('[data-chat-composer-status="blocked"]')!;
    expect(row.textContent).toContain(BLOCKED_REASON);
    expect(row.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('button[aria-label="Attach file"]')).toBeNull();
    expect(container.querySelector('[data-chat-send]')).toBeNull();
    expect(container.querySelector('.chat-input-hint')).toBeNull();
    // With no action, there is nothing to press.
    expect(row.querySelector('button, a')).toBeNull();
  });

  test('the action is a secondary button that calls onclick; the link is a quiet ghost beside it', async () => {
    const calls: string[] = [];
    const { container } = render(ChatInput, {
      id: 'blocked-actions',
      status: {
        kind: 'blocked',
        reason: BLOCKED_REASON,
        action: { label: 'Connect a provider', onclick: () => calls.push('connect') },
        link: { label: 'Use Assistant', onclick: () => calls.push('assistant') },
      },
    });

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>('.chat-input-blocked button'),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Connect a provider',
      'Use Assistant',
    ]);
    expect(buttons[0]!.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(buttons[1]!.getAttribute('data-cinder-variant')).toBe('ghost');

    await fireEvent.click(buttons[0]!);
    await fireEvent.click(buttons[1]!);
    expect(calls).toEqual(['connect', 'assistant']);
  });

  test('an action with an href is a link to that address', () => {
    const { container } = render(ChatInput, {
      id: 'blocked-href',
      status: {
        kind: 'blocked',
        reason: BLOCKED_REASON,
        action: { label: 'Connect a provider', href: '/settings/models' },
      },
    });

    const anchor = container.querySelector<HTMLAnchorElement>('.chat-input-blocked a')!;
    expect(anchor.getAttribute('href')).toBe('/settings/models');
    expect(anchor.textContent?.trim()).toBe('Connect a provider');
  });

  test('keeps the typed draft and the attached files across a blocked stretch', async () => {
    const view = render(ChatInput, { id: 'blocked-draft', value: 'half a thought' });
    await view.rerender({ status: { kind: 'blocked', reason: BLOCKED_REASON } });
    expect(view.container.querySelector('textarea')).toBeNull();

    await view.rerender({ status: undefined });
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'half a thought',
    );
  });
});

describe('the live composer', () => {
  test('shows the hint under the box, hides it for hint false, and a status replaces it', async () => {
    const view = render(ChatInput, { id: 'live-hint' });
    expect(view.container.querySelector('.chat-input-hint')?.textContent).toBe(
      'Enter to send. Shift and Enter for a new line.',
    );

    await view.rerender({ hint: false });
    expect(view.container.querySelector('.chat-input-hint')).toBeNull();

    await view.rerender({ hint: undefined, status: { kind: 'steering' } });
    expect(view.container.querySelector('.chat-input-hint')).toBeNull();
    expect(view.container.querySelector('.chat-input-status')?.textContent).toBe(
      'A message now steers the run.',
    );
  });

  test('marks only its own keyboard hint, which a touch-only device does not draw', async () => {
    const view = render(ChatInput, { id: 'touch-hint' });
    const hint = () => view.container.querySelector('.chat-input-hint');
    // The default names keys, so the touch-only rule in the stylesheet hides it by this mark.
    expect(hint()?.hasAttribute('data-chat-keyboard-hint')).toBe(true);

    await view.rerender({ hint: 'Replies may take a minute.' });
    // A host's own hint is its words, not keys, and stays on every device.
    expect(hint()?.textContent?.trim()).toBe('Replies may take a minute.');
    expect(hint()?.hasAttribute('data-chat-keyboard-hint')).toBe(false);
  });

  test('Send is a secondary button with the send glyph and a word, quiet while the box is empty', async () => {
    const view = render(ChatInput, { id: 'live-send' });
    const send = view.container.querySelector<HTMLButtonElement>('[data-chat-send]')!;

    expect(send.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(send.textContent?.trim()).toBe('');
    expect(send.querySelector('svg.lucide-send-horizontal')).not.toBeNull();
    expect(send.disabled).toBe(true);

    await fireEvent.input(view.container.querySelector('textarea')!, { target: { value: 'hi' } });
    expect(send.disabled).toBe(false);
  });

  test('answering swaps the word to Answer', () => {
    const { container } = render(ChatInput, { id: 'live-answer', answering: true });
    const button = container.querySelector<HTMLButtonElement>('[data-chat-send]')!;

    expect(button.textContent?.trim()).toBe('Answer');
    expect(button.getAttribute('aria-label')).toBe('Answer');
  });

  test('controls sit right after the attach button, before the meter and Send', () => {
    const controls = createRawSnippet(() => ({
      render: () => '<span data-testid="controls">Model</span>',
    }));
    const actions = createRawSnippet(() => ({
      render: () => '<span data-testid="meter">38%</span>',
    }));
    const { container } = render(ChatInput, { id: 'live-controls', controls, actions });

    const left = container.querySelector('.chat-input-footer-left')!;
    const right = container.querySelector('.chat-input-footer-right')!;
    const names = [...left.children].map(
      (child) => child.getAttribute('data-testid') ?? child.getAttribute('aria-label'),
    );
    expect(names.indexOf('controls')).toBeGreaterThan(-1);
    expect(left.querySelector('button[aria-label="Attach file"]')).not.toBeNull();
    expect(right.querySelector('[data-testid="meter"]')).not.toBeNull();
    expect(right.querySelector('[data-chat-send]')).not.toBeNull();
    expect(right.firstElementChild?.getAttribute('data-testid')).toBe('meter');
  });
});
