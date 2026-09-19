import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { renderSvelteOnServer } from '@corvidae/testing';

describe('ChatConversationList SSR safety', () => {
  test('server compilation renders with no DOM globals', async () => {
    const html = await renderSvelteOnServer(
      resolve(import.meta.dir, 'chat-conversation-list.svelte'),
      {
        conversations: [],
      },
    );

    expect(html).toContain('No conversations');
  });
});
