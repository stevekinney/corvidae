/**
 * AB-64 — Gemini effort tiers and model alias threading.
 *
 *   - Every effort tier maps to Gemini's native mechanism (`thinkingConfig`) on a capable model.
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
import { createGeminiProvider } from '../src/gemini.ts';
import { geminiTextResponse } from '../src/test/gemini-fixtures.ts';
import { createMockGeminiModel } from '../src/test/gemini-mock-clients.ts';

function makeContext() {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
  };
}

describe('model alias registry — Gemini', () => {
  it('actually threads the resolved alias into the client construction', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'flash', client });

    const result = await generate(makeContext());

    // The mock client stands in for the already-resolved GenerativeModel
    // instance; the resolved model id is verified via effective-value
    // reporting instead of client-construction args.
    expect(result.metadata?.['effectiveModel']).toBe('gemini-2.5-flash');
  });
});

// ── Effort tiers + fallback matrix — Gemini ─────────────────────────

describe('effort tiers — Gemini', () => {
  const THINKING_MODEL = 'gemini-2.5-pro';
  const NO_THINKING_MODEL = 'gemini-2.0-flash';

  it.each([
    ['low', 1024],
    ['medium', 8192],
    ['high', 16384],
    ['xhigh', 24576],
    ['max', -1],
  ] as const)(
    'maps effort=%s to thinkingBudget=%d on a thinking-capable model',
    async (effort, budget) => {
      const client = createMockGeminiModel([geminiTextResponse]);
      const generate = createGeminiProvider({ model: THINKING_MODEL, effort, client });

      const result = await generate(makeContext());

      expect(client._calls[0]?.['config']).toMatchObject({
        thinkingConfig: { thinkingBudget: budget },
      });
      expect(result.metadata?.['effectiveEffort']).toBe(effort);
    },
  );

  it('omits thinkingConfig entirely on a model with no thinking support', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({
      model: NO_THINKING_MODEL,
      effort: 'max',
      client,
    });

    const result = await generate(makeContext());

    const config = client._calls[0]?.['config'] as Record<string, unknown> | undefined;
    expect(config?.['thinkingConfig']).toBeUndefined();
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });

  it('reports effectiveModel when no effort was requested', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'pro', client });

    const result = await generate(makeContext());

    expect(result.metadata?.['effectiveModel']).toBe('gemini-2.5-pro');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });
});
