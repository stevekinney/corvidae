/**
 * COR-1547 — which parts of a message are managed assets, and how an asset crosses the AG-UI
 * message boundary: the position a part has among the row's parts is the run's `partIndex`, so it
 * survives parts that never reach the wire, and a `file` part from another provider is not an
 * asset.
 */
import type { Message as AgUiMessage } from '@ag-ui/core';
import { describe, expect, it } from 'bun:test';
import { appendMessages, createConversationHistory } from 'conversationalist';

import { assetPartsOf, UNKNOWN_MEDIA_TYPE } from './ag-ui-asset-parts.ts';
import { rowsAddedBy, snapshotMessages } from './ag-ui-messages.ts';

const image = (assetId: string, mimeType?: string) => ({
  type: 'image' as const,
  ...(mimeType === undefined ? {} : { mimeType }),
  source: { kind: 'managed-asset' as const, assetId },
});

describe('assetPartsOf', () => {
  it('lists each managed asset with its position among all the parts, whatever the parts before it are', () => {
    const parts = [
      { type: 'thinking', thinking: 'hm', signature: 's' },
      { type: 'text', text: 'Here.' },
      image('asset-1', 'image/png'),
      { type: 'image', source: { kind: 'remote-url', url: 'https://example.test/a.png' } },
      {
        type: 'audio',
        mimeType: 'audio/wav',
        source: { kind: 'managed-asset', assetId: 'asset-2' },
      },
      image('asset-3'),
    ];

    expect(assetPartsOf(parts)).toEqual([
      { index: 2, assetId: 'asset-1', mediaType: 'image/png' },
      { index: 4, assetId: 'asset-2', mediaType: 'audio/wav' },
      { index: 5, assetId: 'asset-3', mediaType: UNKNOWN_MEDIA_TYPE },
    ]);
  });

  it.each([undefined, null, 'text', 3, {}, [null, 'x', 4, { type: 'image' }]])(
    'finds nothing in %p',
    (value) => {
      expect(assetPartsOf(value)).toEqual([]);
    },
  );
});

describe('an assistant row in a snapshot', () => {
  it('keeps the position its asset had before the reasoning was taken out of the row', () => {
    const history = appendMessages(createConversationHistory({ id: 'thread-1' }), {
      id: 'assistant-1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'secret', signature: 'sig' },
        { type: 'text', text: 'Here it is.' },
        image('asset-1', 'image/png'),
      ],
    });

    const messages = snapshotMessages(history);

    expect(JSON.stringify(messages)).not.toContain('secret');
    const assistant = messages.find((message) => message.id === 'assistant-1')!;
    expect(assistant).toMatchObject({ content: 'Here it is.' });
    expect(assistant.metadata?.['bureau:assetParts']).toEqual([
      { index: 2, assetId: 'asset-1', mediaType: 'image/png' },
    ]);
  });

  it('has no asset metadata when it carries no asset', () => {
    const history = appendMessages(createConversationHistory({ id: 'thread-1' }), {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Just text.',
    });

    const [assistant] = snapshotMessages(history);

    expect(assistant!.metadata?.['bureau:assetParts']).toBeUndefined();
  });
});

describe('the rows a start adds', () => {
  const userWith = (provider: string): AgUiMessage[] => [
    {
      id: 'user-1',
      role: 'user',
      content: [
        { type: 'text', text: 'Look.' },
        {
          type: 'image',
          source: { type: 'file', value: 'asset-1', provider, mimeType: 'image/png' },
        },
      ],
    },
  ];

  it('turns a file part from the provider bureau into a managed-asset part, keeping its media type', () => {
    const [row] = rowsAddedBy(createConversationHistory({ id: 'thread-1' }), userWith('bureau'));

    expect(row!.content).toEqual([
      { type: 'text', text: 'Look.' },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'managed-asset', assetId: 'asset-1' },
      },
    ]);
  });

  it('leaves a file part from any other provider as the provider’s file', () => {
    const [row] = rowsAddedBy(createConversationHistory({ id: 'thread-1' }), userWith('openai'));

    expect(row!.content).toEqual([
      { type: 'text', text: 'Look.' },
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'provider-file', provider: 'openai', providerFileId: 'asset-1' },
      },
    ]);
  });
});
