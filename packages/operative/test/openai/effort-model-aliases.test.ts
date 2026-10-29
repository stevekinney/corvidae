/**
 * AB-64 — OpenAI effort tiers and model alias threading.
 *
 *   - Every effort tier maps to OpenAI's native mechanism (`reasoning_effort`) on a capable model.
 *   - The fallback matrix: an unsupported tier degrades to the nearest supported lower tier, and a
 *     model with no reasoning knob at all degrades to omitting the parameter.
 *   - The effective model and effort actually used are reported on `GenerateResponse.metadata`.
 *   - A resolved model alias reaches the request the client receives.
 *
 * The alias registry itself is provider-neutral and is covered by
 * `test/provider-effort-model-aliases.test.ts`.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createOpenAIProvider } from '../../src/providers/openai.ts';
import { openAITextResponse } from '../../src/providers/test/openai-fixtures.ts';
import { createMockOpenAIClient } from '../../src/providers/test/openai-mock-clients.ts';

function makeContext() {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
  };
}

describe('model alias registry — OpenAI', () => {
  it('actually threads the resolved alias into the request the client receives', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-mini', client });

    await generate(makeContext());

    expect(client._calls[0]?.['model']).toBe('gpt-4.1-mini');
  });
});

// ── Effort tiers + fallback matrix — OpenAI ─────────────────────────

describe('effort tiers — OpenAI', () => {
  const REASONING_MODEL = 'o3';
  const NON_REASONING_MODEL = 'gpt-4o';

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ] as const)(
    'maps effort=%s to reasoning_effort=%s on a reasoning model',
    async (effort, expected) => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = createOpenAIProvider({ model: REASONING_MODEL, effort, client });

      const result = await generate(makeContext());

      expect(client._calls[0]?.['reasoning_effort']).toBe(expected);
      expect(result.metadata?.['effectiveEffort']).toBe(expected);
    },
  );

  it('omits reasoning_effort entirely on a non-reasoning model', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: NON_REASONING_MODEL,
      effort: 'high',
      client,
    });

    const result = await generate(makeContext());

    expect(client._calls[0]).not.toHaveProperty('reasoning_effort');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });

  it('reports effectiveModel when no effort was requested', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'o-mini', client });

    const result = await generate(makeContext());

    expect(result.metadata?.['effectiveModel']).toBe('o3-mini');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });
});
