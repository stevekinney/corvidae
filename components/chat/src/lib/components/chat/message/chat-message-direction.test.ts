/**
 * COR-2286 (X4): a message's text resolves its direction from its own content. An Arabic reply or
 * user bubble reads right to left from its start edge, while the message chrome keeps the page's
 * direction; a source list's titles and excerpts do the same.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { Message } from '../conversation-model.ts';

setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { ChatMessage } = await import('../index.ts');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const contentSource = await Bun.file(`${import.meta.dir}/message-content.svelte`).text();

function message(role: Message['role'], content: string): Message {
  return {
    id: `direction-${role}`,
    role,
    content,
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    hidden: false,
  };
}

describe('ChatMessage text direction', () => {
  test.each([['user'], ['assistant']] as const)(
    'a %s message reads its direction from its text, not from the page',
    (role) => {
      const { container } = render(ChatMessage, {
        props: { message: message(role, 'ارتفعت الإيرادات بنسبة 12٪ في عام 2025.') },
      });

      const content = container.querySelector('.message-content');
      expect(content?.getAttribute('dir')).toBe('auto');
      // The article, its header and its actions keep the page's direction.
      expect(container.querySelector('article')?.hasAttribute('dir')).toBe(false);
      expect(container.querySelector('.chat-message-wrapper')?.hasAttribute('dir')).toBe(false);
    },
  );

  test('message text aligns to its start edge, block by block', () => {
    expect(contentSource).toMatch(/\.message-content \{[^}]*text-align: start;/);
    expect(contentSource).toMatch(
      /\.message-content :global\(:is\(p, li, blockquote[^)]*\)\) \{\s*unicode-bidi: plaintext;\s*text-align: start;/,
    );
  });

  test('the edit field for a user message reads its direction from its text', async () => {
    const { container } = render(ChatMessage, {
      props: {
        message: message('user', 'مرحبا'),
        onEdit: () => {},
      },
    });
    await fireEvent.click(container.querySelector('.chat-message-edit-button')!);
    await tick();

    expect(
      container.querySelector('textarea.chat-message-edit-textarea')?.getAttribute('dir'),
    ).toBe('auto');
  });

  test('a source list reads each title and excerpt in its own direction', async () => {
    const { container } = render(ChatMessage, {
      props: {
        message: message('assistant', 'Revenue rose.'),
        sources: [{ label: 'التقرير السنوي', detail: 'ارتفعت الإيرادات.' }],
        sourcePresentation: 'list',
      },
    });
    await fireEvent.click(container.querySelector('.chat-message-sources-toggle')!);
    await tick();

    expect(container.querySelector('.chat-message-sources-title')?.getAttribute('dir')).toBe(
      'auto',
    );
    expect(container.querySelector('.chat-message-sources-detail')?.getAttribute('dir')).toBe(
      'auto',
    );
  });
});
