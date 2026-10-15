import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import {
  outcomeOf,
  prepareSvelteServerSource,
  renderSvelteOnServer,
  rethrow,
} from '@lostgradient/testing';

const sourcePath = resolve(import.meta.dir, 'chat-conversation-list.svelte');
await prepareSvelteServerSource(sourcePath);

// Server rendering is a real DOM-free process, so it runs once here at module scope, off the
// per-test clock; the test rethrows whatever the scenario threw.
const serverRender = await outcomeOf(async () => {
  const html = await renderSvelteOnServer(sourcePath, {
    conversations: [],
  });

  expect(html).toContain('No conversations');
});

describe('ChatConversationList SSR safety', () => {
  test('server compilation renders with no DOM globals', () => rethrow(serverRender));
});
