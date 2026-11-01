import { appendMessages, createConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import { chatExportFilename, chatMarkdown, hasExportableText } from './chat-export.ts';

const conversation = appendMessages(
  createConversationHistory({ id: 'session-1' }),
  { id: 'u1', role: 'user', content: 'What is 2 + 2?' },
  { id: 'h1', role: 'user', content: 'internal', hidden: true },
  { id: 'a1', role: 'assistant', content: 'Four.' },
  { id: 'a2', role: 'assistant', content: '   ' },
);

describe('chatMarkdown', () => {
  test('writes the title, the agent, and each message that was said, in order', () => {
    expect(chatMarkdown({ title: 'Arithmetic', agent: 'assistant', conversation })).toBe(
      '# Arithmetic\n\nAgent: `assistant`\n\n## You\n\nWhat is 2 + 2?\n\n## Assistant\n\nFour.\n',
    );
  });

  test('writes only the heading for a chat with nothing said', () => {
    const empty = createConversationHistory({ id: 'session-1' });

    expect(chatMarkdown({ title: 'Empty', agent: 'assistant', conversation: empty })).toBe(
      '# Empty\n\nAgent: `assistant`\n',
    );
  });
});

describe('hasExportableText', () => {
  test('is true when a message has text, and false when none does', () => {
    expect(hasExportableText(conversation)).toBe(true);
    expect(hasExportableText(createConversationHistory({ id: 'session-1' }))).toBe(false);
  });
});

describe('chatExportFilename', () => {
  const day = new Date('2026-10-31T12:00:00.000Z');

  test('is the title and the day, with nothing a file system refuses', () => {
    expect(chatExportFilename('Plan: the week / next?', day)).toBe(
      'Plan the week next-2026-10-31.md',
    );
  });

  test('falls back to a name when the title leaves nothing', () => {
    expect(chatExportFilename('???', day)).toBe('chat-2026-10-31.md');
  });
});
