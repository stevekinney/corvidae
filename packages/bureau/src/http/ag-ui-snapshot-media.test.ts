/**
 * COR-713 — the fallback of the AG-UI messages snapshot: when a non-assistant row still cannot be
 * mapped, every row is reduced to its text, and the result must remain a valid `MESSAGES_SNAPSHOT`.
 * COR-1547 — a managed asset on a user row is mapped, as a `file` part from the provider `bureau`,
 * so it is no longer a row that cannot be; a part AG-UI has no way to carry still is.
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

const containerUpload = { type: 'container_upload', file_id: 'file-1' } as never;

describe('a media-only user row in the messages snapshot', () => {
  const history = appendMessages(
    createConversationHistory({ id: 'thread-1' }),
    { id: 'user-1', role: 'user', content: [managedImage] },
    { id: 'assistant-1', role: 'assistant', content: 'Nice picture.' },
  );

  it('keeps the asset as a file part from the provider bureau, and every row', () => {
    const messages = snapshotMessages(history);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'file', value: 'asset-1', provider: 'bureau', mimeType: 'image/png' },
        },
      ],
    });
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

describe('a user row with a part AG-UI cannot carry', () => {
  const history = appendMessages(
    createConversationHistory({ id: 'thread-1' }),
    { id: 'user-1', role: 'user', content: [managedImage, containerUpload] },
    { id: 'assistant-1', role: 'assistant', content: 'Nice picture.' },
  );

  it('does not throw and keeps every row, reduced to its text', () => {
    const messages = snapshotMessages(history);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    // The first attempt throws on the container upload; the text-only fallback leaves an empty
    // content array, which the AG-UI schema accepts (see the next test), so no placeholder is added.
    expect(messages[0]).toMatchObject({ id: 'user-1', role: 'user', content: [] });
    expect(messages[1]).toMatchObject({ id: 'assistant-1', content: 'Nice picture.' });
  });

  it('is a valid MESSAGES_SNAPSHOT event under @ag-ui/core', () => {
    const parsed = EventSchemas.safeParse({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: snapshotMessages(history),
    });

    expect(parsed.success).toBe(true);
  });
});
