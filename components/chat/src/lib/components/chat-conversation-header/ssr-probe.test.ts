import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import {
  outcomeOf,
  prepareSvelteServerSource,
  renderSvelteOnServer,
  rethrow,
} from '@lostgradient/testing';
import type { ConversationHistory } from '../chat/conversation-model.ts';

const sourcePath = resolve(import.meta.dir, 'chat-conversation-header.svelte');

await prepareSvelteServerSource(sourcePath);

function conversation(): ConversationHistory {
  const createdAt = '2026-06-01T00:00:00.000Z';
  return {
    schemaVersion: 4,
    id: 'conversation-header-ssr',
    title: 'Server-safe header',
    status: 'active',
    metadata: {},
    ids: [],
    messages: {},
    createdAt,
    updatedAt: createdAt,
  };
}

// Server rendering is a real DOM-free process, so it runs once here at module scope, off the
// per-test clock; the test rethrows whatever the scenario threw.
const serverRender = await outcomeOf(async () => {
  const html = await renderSvelteOnServer(sourcePath, {
    conversation: conversation(),
    exportActionsVisible: false,
  });

  expect(html).toContain('Server-safe header');
});

describe('ChatConversationHeader SSR safety', () => {
  test('server compilation renders with no DOM globals', () => rethrow(serverRender));
});
