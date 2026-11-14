import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = [
  readFileSync(resolve(import.meta.dir, 'chat.svelte'), 'utf8'),
  readFileSync(resolve(import.meta.dir, 'use-chat-transcript.svelte.ts'), 'utf8'),
].join('\n');

describe('Chat progress affordance integration contract', () => {
  test('routes global, reasoning, and tool activity through one selector', () => {
    expect(source).toContain('selectChatProgressState({');
    expect(source).toContain("progressState === 'streaming'");
    expect(source).toContain('pairToolCallsWithResults(');
    expect(source).toContain('messages.filter((message) => activeTurnMessageIds.has(message.id))');
    expect(source).toContain('getStreaming()');
  });

  test('keeps nested motion affordances available while global typing is suppressed', () => {
    expect(source).toContain('reasoningStreaming');
    expect(source).toContain('selectChatProgressState({');
    expect(source).toContain('renderTypingIndicator');
    expect(source).toContain(
      "toolActivityActive={progressState === 'tool' && activeTurnMessageIds.has(message.id)}",
    );
    expect(source).toContain("activityActive={progressState === 'tool' &&");
    expect(source).toContain(
      'renderRow.messages.some((message) => activeTurnMessageIds.has(message.id))',
    );
    expect(source).toContain('const activeTurnMessageIds = $derived.by(() => {');
  });

  test('does not treat completed content-driven reasoning as active', () => {
    expect(source).toContain('!isStreamingMessage(activeMessage)');
    expect(source).toContain('getStreamingMessageId() === null');
  });

  test('the work-in-progress dots are quiet, bubble-free, and stay out from under banners', () => {
    const chat = readFileSync(resolve(import.meta.dir, 'chat.svelte'), 'utf8');
    const rule = /\.chat-typing-indicator \{[^}]*\}/u.exec(chat)?.[0] ?? '';
    expect(rule).not.toContain('background');
    expect(rule).not.toContain('border-radius');
    // A full step clear of the text above, and dots as far apart as they are wide.
    expect(rule).toMatch(/padding: var\(--cinder-space-2\) 0 var\(--cinder-space-1\);/u);
    expect(rule).toMatch(/gap: 0\.375rem;/u);
    const dot = /\.chat-typing-dot \{[^}]*\}/u.exec(chat)?.[0] ?? '';
    expect(dot).toMatch(/width: 0\.375rem;\s*height: 0\.375rem;/u);
    // Body text colour, never fainter than 55%: at least 4:1 at rest in both themes.
    expect(dot).toContain('background: var(--cinder-text-default);');
    expect(chat).not.toMatch(/@keyframes typing-(?:bounce|pulse) \{[^}]*\{\s*opacity: 0\.4;/u);
    expect(chat).toContain('streamingFenceIsOpen(streamingState.content)');
    const suppress = /getSuppressTypingIndicator: \(\) =>[^,]*,/u.exec(chat)?.[0] ?? '';
    for (const banner of ['reconnecting', 'approvalWaiting', 'dockedQuestions', 'availability']) {
      expect(suppress).toContain(banner);
    }
    expect(chat).not.toContain('Running 0:00');
  });
});
