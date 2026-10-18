/**
 * COR-716 — one precedence rule names the media type of every exported part: the
 * resolver's type, then the data URL's own, then the part's stored `mimeType`. A stale
 * stored type must never mislabel the bytes a data URL carries.
 */
import { describe, expect, it } from 'bun:test';

import { toA2APart } from '../src/adapters/a2a/content';
import { toAGUIMessages } from '../src/adapters/ag-ui/outbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import * as media from '../src/adapters/media';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import type { ConversationHistory, MediaContent, ResolvedMediaSources } from '../src/index';
import { Conversation } from '../src/index';

const BYTES = 'QUJD';

function history(part: MediaContent): ConversationHistory {
  const conversation = new Conversation();
  conversation.appendUserMessage([part]);
  return conversation.current;
}

/** A stale `image/png` over bytes whose own data URL says `image/jpeg`. */
const stale: MediaContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'data-url', url: `data:image/jpeg;base64,${BYTES}` },
};

describe('effectiveMimeType', () => {
  it('prefers the resolver, then the data URL, then the stored type', () => {
    const dataUrl = { kind: 'data-url', url: `data:image/jpeg;base64,${BYTES}` } as const;
    expect(media.effectiveMimeType(dataUrl, 'image/webp', 'image/png')).toBe('image/webp');
    expect(media.effectiveMimeType(dataUrl, undefined, 'image/png')).toBe('image/jpeg');
    expect(
      media.effectiveMimeType({ kind: 'remote-url', url: 'https://x/a' }, undefined, 'image/png'),
    ).toBe('image/png');
    expect(
      media.effectiveMimeType({ kind: 'remote-url', url: 'https://x/a' }, undefined, undefined),
    ).toBeUndefined();
  });
});

describe('every exporter names the bytes by the data URL’s own media type', () => {
  it('AG-UI', () => {
    const [message] = toAGUIMessages(history(stale));
    expect(JSON.stringify(message)).toContain('"mimeType":"image/jpeg"');
    expect(JSON.stringify(message)).not.toContain('image/png');
  });

  it('A2A', () => {
    expect(toA2APart(stale)).toMatchObject({ raw: BYTES, mediaType: 'image/jpeg' });
  });

  it('Anthropic, Gemini, and OpenAI', () => {
    expect(JSON.stringify(toAnthropicMessages(history(stale)).messages)).toContain('image/jpeg');
    expect(JSON.stringify(toGeminiMessages(history(stale)).contents)).toContain('image/jpeg');
    expect(JSON.stringify(toOpenAIMessages(history(stale)).messages)).toContain(
      `data:image/jpeg;base64,${BYTES}`,
    );
  });
});

describe('a resolver’s media type wins over both', () => {
  it('on the provider wires, even when the resolved source is a data URL', () => {
    const part: MediaContent = {
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'managed-asset', assetId: 'a' },
    };
    const conversation = history(part);
    const sources: ResolvedMediaSources = new Map([
      [
        media.resolvedSourceKey(conversation.ids[0]!, 0),
        {
          outcome: 'resolved',
          source: { kind: 'data-url', url: `data:image/jpeg;base64,${BYTES}` },
          mimeType: 'image/webp',
          safety: 'clean',
        },
      ],
    ]);

    expect(JSON.stringify(toAnthropicMessages(conversation, { sources }).messages)).toContain(
      'image/webp',
    );
    expect(JSON.stringify(toGeminiMessages(conversation, { sources }).contents)).toContain(
      'image/webp',
    );
    expect(JSON.stringify(toOpenAIMessages(conversation, { sources }).messages)).toContain(
      `data:image/webp;base64,${BYTES}`,
    );
  });
});

describe('no exporter picks its own media type', () => {
  it('reads it through effectiveMimeType, not from the payload or the stored type first', async () => {
    const offenders: string[] = [];
    const root = new URL('../src/adapters', import.meta.url).pathname;
    for await (const file of new Bun.Glob('*/{outbound,content}.ts').scan({ cwd: root })) {
      const text = await Bun.file(`${root}/${file}`).text();
      if (/payload\??\.mimeType|(part|content)\.mimeType \?\?/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
