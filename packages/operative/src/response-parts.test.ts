import { describe, expect, it } from 'bun:test';
import type { MultiModalContent } from 'conversationalist';

import {
  concatenateTextParts,
  deriveParts,
  inlineMediaParts,
  partsMatchContent,
  rowContentForParts,
  runWideParts,
} from './response-parts';

const thinking: MultiModalContent = { type: 'thinking', thinking: 'Plan.', signature: 'sig' };
const image = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: 'AAAA', encoding: 'base64' },
} as const;
const managedImage: MultiModalContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 },
};

describe('deriveParts', () => {
  it('derives one text part from non-empty content', () => {
    expect(deriveParts('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('derives no parts from empty content', () => {
    expect(deriveParts('')).toEqual([]);
  });
});

describe('concatenateTextParts', () => {
  it('concatenates text parts in order and ignores every other part', () => {
    expect(
      concatenateTextParts([
        { type: 'text', text: 'a' },
        thinking,
        image,
        { type: 'text', text: 'b', citations: [{ cited_text: 'x' }] },
      ]),
    ).toBe('ab');
  });

  it('is empty for parts without text', () => {
    expect(concatenateTextParts([thinking])).toBe('');
  });
});

describe('partsMatchContent', () => {
  it('matches when the text parts concatenate to content', () => {
    expect(partsMatchContent([thinking, { type: 'text', text: 'hi' }], 'hi')).toBe(true);
  });

  it('does not match when content was changed after the parts were built', () => {
    expect(partsMatchContent([{ type: 'text', text: 'secret' }], '[redacted]')).toBe(false);
  });
});

describe('rowContentForParts', () => {
  it('keeps the string shorthand for exactly one plain text part', () => {
    expect(rowContentForParts([{ type: 'text', text: 'hi' }])).toBe('hi');
  });

  it('stores the array for a single cited text part', () => {
    const cited: MultiModalContent = { type: 'text', text: 'hi', citations: [{ cited_text: 'x' }] };
    expect(rowContentForParts([cited])).toEqual([cited]);
  });

  it('stores the array for any other parts', () => {
    expect(rowContentForParts([thinking, { type: 'text', text: 'hi' }])).toEqual([
      thinking,
      { type: 'text', text: 'hi' },
    ]);
  });
});

describe('inlineMediaParts', () => {
  it('reports the index and part of every media part whose source is not a managed asset', () => {
    expect(inlineMediaParts([thinking, image, managedImage])).toEqual([{ index: 1, part: image }]);
  });
});

describe('runWideParts', () => {
  it('concatenates every step in order, then the replacement row', () => {
    const replacement = [{ type: 'text', text: 'summary' }] as const;
    expect(
      runWideParts({
        steps: [{ parts: [thinking] }, { parts: [{ type: 'text', text: 'two' }] }],
        lastParts: replacement,
        finalRowIsReplacement: true,
      }),
    ).toEqual([thinking, { type: 'text', text: 'two' }, { type: 'text', text: 'summary' }]);
  });

  it('does not repeat the last step when the final row is not a replacement', () => {
    expect(
      runWideParts({
        steps: [{ parts: [{ type: 'text', text: 'one' }] }],
        lastParts: [{ type: 'text', text: 'one' }],
        finalRowIsReplacement: false,
      }),
    ).toEqual([{ type: 'text', text: 'one' }]);
  });
});
