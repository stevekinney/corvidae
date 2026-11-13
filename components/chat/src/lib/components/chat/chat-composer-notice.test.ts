/**
 * The neutral composer bars: an archived chat (archive icon, `Archived <when>`, a secondary New chat
 * and a primary Unarchive) and a read-only chat (lock, `Read only` with a tooltip, a primary Request
 * access); and the blocked row's primary action (the board's availability rows V4 to V6).
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: ChatInput } = await import('./input/chat-input.svelte');
const { composerStatusText, isComposerNoticeStatus } = await import('./input/composer-status.ts');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('an archived composer', () => {
  test('draws one neutral bar with the date, and no text box, controls or Send', () => {
    const { container } = render(ChatInput, {
      id: 'archived-bar',
      status: { kind: 'archived', when: 'Nov 3' },
    });

    const bar = container.querySelector('[data-chat-composer-status="archived"]')!;
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.querySelector('.chat-input-blocked-reason')?.textContent?.trim()).toBe(
      'Archived Nov 3',
    );
    expect(bar.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    // Neutral: not the blocked row's warning glyph.
    expect(bar.querySelector('svg.lucide-triangle-alert')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[data-chat-send]')).toBeNull();
    expect(container.querySelector('.chat-input-hint')).toBeNull();
    // With no action, there is nothing to press.
    expect(bar.querySelector('button, a')).toBeNull();
  });

  test('puts the secondary New chat before the primary Unarchive, and both call their handler', async () => {
    const calls: string[] = [];
    const { container } = render(ChatInput, {
      id: 'archived-actions',
      status: {
        kind: 'archived',
        when: 'Nov 3',
        newChat: { label: 'New chat', onclick: () => calls.push('new') },
        unarchive: { label: 'Unarchive', onclick: () => calls.push('unarchive') },
      },
    });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.chat-input-notice button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['New chat', 'Unarchive']);
    expect(buttons[0]!.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(buttons[1]!.getAttribute('data-cinder-variant')).toBe('primary');

    await fireEvent.click(buttons[0]!);
    await fireEvent.click(buttons[1]!);
    expect(calls).toEqual(['new', 'unarchive']);
  });

  test('an action with an href is a link', () => {
    const { container } = render(ChatInput, {
      id: 'archived-link',
      status: {
        kind: 'archived',
        when: 'Nov 3',
        newChat: { label: 'New chat', href: '/chats/new' },
      },
    });

    const anchor = container.querySelector<HTMLAnchorElement>('.chat-input-notice a')!;
    expect(anchor.getAttribute('href')).toBe('/chats/new');
  });

  test('keeps the typed draft across an archived stretch', async () => {
    const view = render(ChatInput, { id: 'archived-draft', value: 'half a thought' });
    await view.rerender({ status: { kind: 'archived', when: 'Nov 3' } });
    expect(view.container.querySelector('textarea')).toBeNull();

    await view.rerender({ status: undefined });
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'half a thought',
    );
  });
});

describe('a read-only composer', () => {
  test('draws a lock, the words Read only and the primary Request access', async () => {
    const calls: string[] = [];
    const { container } = render(ChatInput, {
      id: 'read-only-bar',
      status: {
        kind: 'read-only',
        request: { label: 'Request access', onclick: () => calls.push('request') },
      },
    });

    const bar = container.querySelector('[data-chat-composer-status="read-only"]')!;
    expect(bar.querySelector('.chat-input-blocked-reason')?.textContent?.trim()).toBe('Read only');
    expect(bar.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();

    const button = bar.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent?.trim()).toBe('Request access');
    expect(button.getAttribute('data-cinder-variant')).toBe('primary');
    await fireEvent.click(button);
    expect(calls).toEqual(['request']);
  });

  test('names who granted the access in a tooltip on the words, when the host says', async () => {
    const { container } = render(ChatInput, {
      id: 'read-only-tooltip',
      status: {
        kind: 'read-only',
        tooltip: 'Support Ops can grant you write access',
        request: { label: 'Request access', onclick: () => undefined },
      },
    });
    await tick();

    const label = container.querySelector<HTMLButtonElement>('.chat-input-notice-label')!;
    expect(label.textContent?.trim()).toBe('Read only');
    const tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain('Support Ops can grant you write access');
    expect(label.getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  test('draws the words alone, with no tooltip trigger, when the host gives none', () => {
    const { container } = render(ChatInput, {
      id: 'read-only-plain',
      status: { kind: 'read-only' },
    });

    expect(container.querySelector('.chat-input-notice-label')).toBeNull();
    expect(container.querySelector('.chat-input-blocked-reason')?.textContent?.trim()).toBe(
      'Read only',
    );
  });
});

describe('the blocked row', () => {
  test('draws an action as the primary button when it says so', () => {
    const { container } = render(ChatInput, {
      id: 'blocked-primary',
      status: {
        kind: 'blocked',
        reason: 'Connect a model provider',
        action: { label: 'Connect provider', onclick: () => undefined, primary: true },
      },
    });

    const button = container.querySelector<HTMLButtonElement>('.chat-input-blocked button')!;
    expect(button.getAttribute('data-cinder-variant')).toBe('primary');
  });
});

describe('composer status words', () => {
  test('read the archive date and Read only', () => {
    expect(composerStatusText({ kind: 'archived', when: 'Nov 3' })).toBe('Archived Nov 3');
    expect(composerStatusText({ kind: 'read-only' })).toBe('Read only');
  });

  test('tell the neutral bars from every other status', () => {
    expect(isComposerNoticeStatus({ kind: 'archived', when: 'today' })).toBe(true);
    expect(isComposerNoticeStatus({ kind: 'read-only' })).toBe(true);
    expect(isComposerNoticeStatus({ kind: 'blocked', reason: 'No' })).toBe(false);
    expect(isComposerNoticeStatus({ kind: 'steering' })).toBe(false);
    expect(isComposerNoticeStatus(undefined)).toBe(false);
  });
});
