/**
 * Tests for createOpenAIEmbedder against an injected client: what reaches `embeddings.create`, and
 * that the caller's signal rides in the SDK's request options (COR-2185).
 */
import { describe, expect, it } from 'bun:test';

import type { OpenAIEmbeddingClient } from '../src/embeddings/openai.ts';
import { createOpenAIEmbedder } from '../src/embeddings/openai.ts';

interface Recorded {
  readonly params: Record<string, unknown>;
  readonly options: { signal?: AbortSignal } | undefined;
}

function recordingClient(): { client: OpenAIEmbeddingClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    client: {
      embeddings: {
        async create(params, options) {
          calls.push({ params, options });
          return { data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] };
        },
      },
    },
  };
}

describe('createOpenAIEmbedder — the caller’s signal', () => {
  it('hands the signal to the SDK in its request options', async () => {
    const { client, calls } = recordingClient();
    const controller = new AbortController();

    const vectors = await createOpenAIEmbedder({ client })(['a', 'b'], {
      signal: controller.signal,
    });

    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'] });
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  it('sends no request options when the caller gave no signal', async () => {
    const { client, calls } = recordingClient();

    await createOpenAIEmbedder({ client })(['a', 'b']);

    expect(calls[0]?.options).toBeUndefined();
  });
});
