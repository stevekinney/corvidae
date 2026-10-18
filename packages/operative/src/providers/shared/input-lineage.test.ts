import { describe, expect, it } from 'bun:test';
import type { ContentPartLineage } from 'conversationalist';

import { lineageToJSON } from './input-lineage';

describe('lineageToJSON', () => {
  it('keeps the original media type a provider replaced', () => {
    const entry: ContentPartLineage = {
      messageId: 'm1',
      partIndex: 0,
      modality: 'document',
      provider: 'anthropic',
      from: 'inline',
      to: 'inline',
      transform: 'passthrough',
      originalMimeType: 'text/markdown',
    };

    expect(lineageToJSON([entry]) as unknown).toEqual([entry]);
  });

  it('drops optional fields that are absent', () => {
    const entry: ContentPartLineage = {
      messageId: 'm1',
      partIndex: 1,
      modality: 'image',
      provider: 'openai',
      from: 'remote-url',
      to: 'remote-url',
      transform: 'remote-url-delegated',
    };

    expect(lineageToJSON([entry]) as unknown).toEqual([entry]);
    expect(Object.keys((lineageToJSON([entry]) as Array<object>)[0]!)).not.toContain(
      'originalMimeType',
    );
  });
});
