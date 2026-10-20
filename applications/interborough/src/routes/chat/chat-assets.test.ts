/**
 * `chat-assets.svelte` and `chat-assets.ts` in `@lostgradient/interborough` (COR-1548): the managed
 * assets on a chat row, read from the row and shown by kind, each pointed at the Bureau's content
 * route.
 */
import type { ConversationHistory } from '@lostgradient/chat';
import { cleanup, render } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import ChatAssets from './chat-assets.svelte';
import { assetsOf, hasContent, kindOf, withoutAssetParts } from './chat-assets.ts';

// A player loads only an http, https or blob address, and resolves a relative one against the page.
const base = document.createElement('base');
beforeAll(() => {
  base.href = 'http://localhost:7000/';
  document.head.append(base);
});
afterAll(() => base.remove());
afterEach(cleanup);

type Message = ConversationHistory['messages'][string];

const row = (overrides: Partial<Message>): Message => ({
  id: 'row-1',
  role: 'assistant',
  content: '',
  position: 0,
  createdAt: '2026-10-19T00:00:00.000Z',
  metadata: {},
  hidden: false,
  ...overrides,
});

describe('chat-assets.svelte shows each kind of asset', () => {
  const show = (mediaType: string) =>
    render(ChatAssets, { assets: [{ assetId: 'asset-1', mediaType }], role: 'assistant' });

  test('an image with Cinder Image, pointed at the content route', () => {
    const { container } = show('image/png');

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/bureau/assets/asset-1/content');
    expect(image?.closest('.cinder-image')).not.toBeNull();
    expect(image?.getAttribute('alt')).toBe('Image 1');
  });

  test('audio with a native audio element driven by Cinder MediaControls, and no waveform', () => {
    const { container } = show('audio/mpeg');

    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      '/bureau/assets/asset-1/content',
    );
    expect(container.querySelector('[data-cinder-unavailable]')).toBeNull();
    expect(container.querySelector('.cinder-media-controls')).not.toBeNull();
    expect(container.querySelector('[class*="waveform"]')).toBeNull();
  });

  test('video with a native video element', () => {
    const { container } = show('video/mp4');

    expect(container.querySelector('video')?.getAttribute('src')).toBe(
      '/bureau/assets/asset-1/content',
    );
  });

  test.each(['application/pdf', 'image/svg+xml', 'application/octet-stream'])(
    '%s as a Cinder Link that downloads it',
    (mediaType) => {
      const { container } = show(mediaType);

      const link = container.querySelector('a.cinder-link');
      expect(link?.getAttribute('href')).toBe('/bureau/assets/asset-1/content');
      expect(link?.hasAttribute('download')).toBe(true);
      expect(link?.textContent).toContain(mediaType);
      expect(container.querySelector('img, audio, video')).toBeNull();
    },
  );

  test('an asset id with a character a path cannot hold is encoded', () => {
    const { container } = render(ChatAssets, {
      assets: [{ assetId: 'a/b c', mediaType: 'application/pdf' }],
      role: 'user',
    });

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/bureau/assets/a%2Fb%20c/content',
    );
  });

  test('names the same asset twice without failing, each at its own position', () => {
    const { container } = render(ChatAssets, {
      assets: [
        { assetId: 'asset-1', mediaType: 'image/png' },
        { assetId: 'asset-1', mediaType: 'image/png' },
      ],
      role: 'assistant',
    });

    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  test('nothing for a row with no asset', () => {
    const { container } = render(ChatAssets, { assets: [], role: 'assistant' });

    expect(container.querySelector('ul')).toBeNull();
  });
});

describe('chat-assets.ts reads the assets of a row', () => {
  test('lists an assistant row’s bureau:assetParts in part order, and names an unknown type for none', () => {
    const message = row({
      metadata: {
        'bureau:assetParts': [
          { index: 2, assetId: 'b', mediaType: 'audio/wav' },
          { index: 1, assetId: 'a', mediaType: 'image/png' },
          { index: 3, assetId: 'c', mediaType: '' },
          { index: 4 },
          'junk',
        ],
      },
    });

    expect(assetsOf(message)).toEqual([
      { assetId: 'a', mediaType: 'image/png' },
      { assetId: 'b', mediaType: 'audio/wav' },
      { assetId: 'c', mediaType: 'application/octet-stream' },
    ]);
  });

  test('lists the assets of a tool-call row, which is where a step with calls and no text keeps them', () => {
    const message = row({
      role: 'tool-call',
      metadata: { 'bureau:assetParts': [{ index: 0, assetId: 'a', mediaType: 'image/png' }] },
    });

    expect(assetsOf(message)).toEqual([{ assetId: 'a', mediaType: 'image/png' }]);
  });

  test('is none for an assistant row whose metadata lists nothing, or something that is not a list', () => {
    expect(assetsOf(row({}))).toEqual([]);
    expect(assetsOf(row({ metadata: { 'bureau:assetParts': 'x' } }))).toEqual([]);
  });

  test('lists a user row’s media parts from the bureau provider, and ignores any other source', () => {
    const message = row({
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'provider-file', provider: 'bureau', providerFileId: 'asset-1' },
        },
        {
          type: 'document',
          source: { kind: 'provider-file', provider: 'bureau', providerFileId: 'asset-2' },
        },
        {
          type: 'image',
          source: { kind: 'provider-file', provider: 'other', providerFileId: 'asset-3' },
        },
        { type: 'image', source: { kind: 'remote-url', url: 'https://example.test/a.png' } },
      ],
    });

    expect(assetsOf(message)).toEqual([
      { assetId: 'asset-1', mediaType: 'image/png' },
      { assetId: 'asset-2', mediaType: 'application/octet-stream' },
    ]);
  });

  test('is none for a user row that is only text, and for any other role', () => {
    expect(assetsOf(row({ role: 'user', content: 'Hello' }))).toEqual([]);
    expect(assetsOf(row({ role: 'system' }))).toEqual([]);
  });

  test('kindOf ignores parameters and case', () => {
    expect(kindOf('IMAGE/PNG; charset=binary')).toBe('image');
    expect(kindOf('Audio/Ogg')).toBe('audio');
  });
});

describe('chat-assets.ts hides the files a row carries from its text', () => {
  const conversation = (...messages: Message[]): ConversationHistory => ({
    schemaVersion: 4,
    id: 'thread-1',
    status: 'active',
    metadata: {},
    ids: messages.map((message) => message.id),
    messages: Object.fromEntries(messages.map((message) => [message.id, message])),
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  });
  const file = {
    type: 'image' as const,
    mimeType: 'image/png',
    source: { kind: 'provider-file' as const, provider: 'bureau', providerFileId: 'asset-1' },
  };
  const elsewhere = {
    type: 'image' as const,
    source: { kind: 'remote-url' as const, url: 'https://example.test/a.png' },
  };

  test('takes the bureau’s files out of a user row’s content, which Chat would show as a placeholder', () => {
    const shown = withoutAssetParts(
      conversation(
        row({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'Look' }, file, elsewhere] }),
      ),
    );

    expect(shown.messages['u1']?.content).toEqual([{ type: 'text', text: 'Look' }, elsewhere]);
  });

  test('leaves a row of only files with no content, and a row that names none exactly as it was', () => {
    const plain = row({ id: 'a1', content: 'Hello' });
    const only = row({ id: 'u1', role: 'user', content: [file] });
    const original = conversation(plain, only);

    const shown = withoutAssetParts(original);

    expect(shown.messages['u1']?.content).toEqual([]);
    expect(shown.messages['a1']).toBe(plain);
    expect(shown.ids).toBe(original.ids);
  });

  test('is the very same conversation when no row names a file, so an unchanged transcript costs nothing', () => {
    const original = conversation(row({ id: 'a1', content: 'Hello' }));

    expect(withoutAssetParts(original)).toBe(original);
  });

  test('hasContent says whether anything is left to show of a row once its files are taken out', () => {
    expect(hasContent(row({ content: 'Hello' }))).toBe(true);
    expect(hasContent(row({ content: '  ' }))).toBe(false);
    expect(hasContent(row({ content: [] }))).toBe(false);
    expect(hasContent(row({ content: [{ type: 'text', text: 'Hi' }] }))).toBe(true);
    expect(hasContent(row({ content: [elsewhere] }))).toBe(true);
    // A tool call or its result is a row's content even though its text is empty.
    expect(
      hasContent(
        row({
          role: 'tool-call',
          content: '',
          toolCall: { id: 'c', name: 'lookup', arguments: {} },
        }),
      ),
    ).toBe(true);
  });
});
