/**
 * COR-713 — the fallback of the AG-UI messages snapshot: when a non-assistant row still cannot be
 * mapped, every row is reduced to its text, and the result must remain a valid `MESSAGES_SNAPSHOT`.
 */
import { EventType } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversationHistory } from 'conversationalist';

import { snapshotMessages } from './ag-ui-messages.ts';

const managedImage = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 },
} as never;

describe('a media-only user row in the messages snapshot', () => {
  const history = appendMessages(
    createConversationHistory({ id: 'thread-1' }),
    { id: 'user-1', role: 'user', content: [managedImage] },
    { id: 'assistant-1', role: 'assistant', content: 'Nice picture.' },
  );

  it('does not throw and keeps every row', () => {
    const messages = snapshotMessages(history);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // The first attempt throws on the managed-asset image; the text-only fallback leaves an empty
    // content array, which the AG-UI schema accepts (see the next test), so no placeholder is added.
    expect(messages[0]).toMatchObject({ id: 'user-1', role: 'user', content: [] });
    expect(messages[1]).toMatchObject({ id: 'assistant-1', content: 'Nice picture.' });
  });

  it('is a valid MESSAGES_SNAPSHOT event under @ag-ui/core', () => {
    const event = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: snapshotMessages(history),
    };

    const parsed = EventSchemas.safeParse(event);

    expect(parsed.success).toBe(true);
  });
});
