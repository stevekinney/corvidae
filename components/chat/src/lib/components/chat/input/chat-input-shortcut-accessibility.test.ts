/// <reference lib="dom" />
/**
 * Source-contract tests for chat input shortcut accessibility (Slice 2).
 */
import { setupHappyDom } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { mount, unmount } from 'svelte';

setupHappyDom();

const { waitFor } = await import('@testing-library/svelte');
const { default: ChatInput } = await import('./chat-input.svelte');

const chatInputSource = await Bun.file(
  new URL('./chat-input.svelte', import.meta.url).pathname,
).text();

describe('ChatInput — shortcut accessibility', () => {
  test('does not import the rich MarkdownEditor composer', () => {
    expect(chatInputSource).not.toContain('MarkdownEditor');
    expect(chatInputSource).not.toContain('../../markdown-editor/markdown-editor.svelte');
  });

  test('derives a shortcut description id and shows its words as a hint under the box', () => {
    expect(chatInputSource).toMatch(/shortcutDescriptionId\s*=\s*\$derived/);
    expect(chatInputSource).toMatch(/shortcut-description/);
    // The hint is for sighted readers; the hidden description is what the controls point at.
    expect(chatInputSource).toMatch(/class="chat-input-hint" aria-hidden="true"/);
    expect(chatInputSource).toContain('Enter to send. Shift and Enter for a new line.');
  });

  test('draws no keyboard hint and no shortcut words on a touch-only device', () => {
    const rule = chatInputSource.match(
      /@media \(hover: none\) and \(pointer: coarse\) \{([\s\S]*?)\n  \}/,
    );
    expect(chatInputSource).toContain('.chat-input-hint[data-chat-keyboard-hint]');
    expect(rule?.[1]).toContain('.chat-input-format-hint');
    expect(rule?.[1]).toContain('display: none');
  });

  test('renders a visually hidden shortcut description element', () => {
    // Must have a span/element with shortcutDescriptionId and the cinder-sr-only class
    expect(chatInputSource).toMatch(/id=\{shortcutDescriptionId\}/);
    expect(chatInputSource).toMatch(/class="cinder-sr-only"/);
    // Must mention Enter and Shift+Enter in text
    expect(chatInputSource).toMatch(/Enter/);
    expect(chatInputSource).toMatch(/Shift\+Enter/);
  });

  test('send button aria-describedby references the hidden shortcut description', () => {
    // Send button must point at shortcutDescriptionId, not hintId
    expect(chatInputSource).toMatch(/aria-describedby=\{shortcutDescriptionId\}/);
  });

  test('stop button aria-describedby references the hidden streaming shortcut description', () => {
    const stopButtonMatch = chatInputSource.match(/data-chat-side-stop[\s\S]*?<\/Button>/);
    expect(stopButtonMatch?.[0]).toMatch(/aria-describedby=\{shortcutDescriptionId\}/);
    const mainButtonMatch = chatInputSource.match(/data-chat-send[\s\S]*?<\/Button>/);
    // Send also names the paused reason while one is shown, so the description id leads a ternary.
    expect(mainButtonMatch?.[0]).toMatch(/aria-describedby=\{[^}]*shortcutDescriptionId/);
  });

  test('send button does not reference the visible hint id via aria-describedby', () => {
    // The visible hint should NOT be the aria-describedby target (it can be display:none)
    // We look for the send button context: aria-describedby={hintId} should NOT appear
    // after the shortcutDescriptionId was introduced
    expect(chatInputSource).not.toMatch(/aria-describedby=\{hintId\}/);
  });

  test('textarea composer receives label and shortcut description', () => {
    const textareaMatch = chatInputSource.match(/<textarea[\s\S]*?<\/textarea>/);
    expect(textareaMatch).not.toBeNull();
    expect(textareaMatch?.[0]).toMatch(/aria-label=\{resolvedComposerLabel\}/);
    expect(textareaMatch?.[0]).toMatch(/aria-describedby=\{shortcutDescriptionId\}/);
  });

  test('uses Cinder Tooltip and routes contextual send guidance through labels', async () => {
    expect(chatInputSource).toMatch(
      /import \{[^}]*\bTooltip\b[^}]*\} from '@lostgradient\/cinder'/,
    );
    const showTooltip = async (labels: Record<string, unknown> | undefined) => {
      const target = document.createElement('div');
      document.body.append(target);
      const instance = mount(ChatInput, {
        target,
        props: { id: 'shortcut-labels', value: 'Ready draft', labels },
      });
      const send = target.querySelector<HTMLButtonElement>('[data-chat-send]');
      expect(send?.disabled).toBe(false);
      send?.focus();
      await waitFor(() => {
        const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
        expect(tooltip?.getAttribute('aria-hidden')).toBe('false');
        expect(send?.getAttribute('aria-describedby')).toContain(tooltip?.id);
        return tooltip;
      });
      const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
      unmount(instance);
      target.remove();
      return { send, tooltipText: tooltip?.textContent };
    };

    const defaultGuidance = await showTooltip(undefined);
    expect(defaultGuidance.send?.getAttribute('aria-label')).toBe('Send message');
    expect(defaultGuidance.tooltipText).toBe('Send (Enter)');

    const customGuidance = await showTooltip({
      sendMessage: 'Nachricht senden',
      send: 'Senden',
      sendShortcut: (shortcut: string) => `Custom send ${shortcut}`,
    });
    expect(customGuidance.send?.getAttribute('aria-label')).toBe('Nachricht senden');
    expect(customGuidance.tooltipText).toBe('Custom send Enter');
  });
});
