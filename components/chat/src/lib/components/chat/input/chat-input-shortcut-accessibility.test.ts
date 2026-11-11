/**
 * Source-contract tests for chat input shortcut accessibility (Slice 2).
 */
import { describe, expect, test } from 'bun:test';

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
    expect(rule?.[1]).toContain('.chat-input-hint[data-chat-keyboard-hint]');
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

  test('uses Cinder Tooltip for contextual send guidance', () => {
    expect(chatInputSource).toMatch(
      /import \{[^}]*\bTooltip\b[^}]*\} from '@lostgradient\/cinder'/,
    );
    expect(chatInputSource).toContain("'Wait for attachments'");
    expect(chatInputSource).toContain("'Add a message or attachment'");
    expect(chatInputSource).toContain("'Type an answer'");
    expect(chatInputSource).toContain("'Stop generating'");
    expect(chatInputSource).toContain("'Send (Command or Control + Enter)'");
    expect(chatInputSource).toContain("'Send message'");
    expect(chatInputSource).toContain("'Send (Enter)'");
    expect(chatInputSource).toContain("'Answer (Enter)'");
  });
});
