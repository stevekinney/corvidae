/**
 * AB-64 — Anthropic effort tiers and model alias threading.
 *
 *   - Every effort tier maps to Anthropic's native mechanism (`output_config.effort`) on a capable model.
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

import { createAnthropicProvider } from '../../src/providers/anthropic.ts';
import { anthropicTextResponse } from '../../src/providers/test/anthropic-fixtures.ts';
import { createMockAnthropicClient } from '../../src/providers/test/anthropic-mock-clients.ts';

function makeContext() {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([]),
  };
}

// ── Model alias registry ────────────────────────────────────────────

describe('model alias registry — Anthropic', () => {
  it('actually threads the resolved alias into the request the client receives', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'sonnet', client });

    await generate(makeContext());

    expect(client._calls[0]?.['model']).toBe('claude-sonnet-5');
  });
});

// ── Effort tiers + fallback matrix — Anthropic ──────────────────────

describe('effort tiers — Anthropic', () => {
  const EFFORT_CAPABLE_MODEL = 'claude-opus-4-8'; // full low..max, including xhigh
  const NO_XHIGH_MODEL = 'claude-opus-4-6'; // low..max, no xhigh
  const NO_EFFORT_MODEL = 'claude-haiku-4-5'; // no effort support at all

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends output_config.effort=%s on a fully-capable model',
    async (effort) => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = createAnthropicProvider({ model: EFFORT_CAPABLE_MODEL, effort, client });

      const result = await generate(makeContext());

      expect(client._calls[0]?.['output_config']).toEqual({ effort });
      expect(result.metadata?.['effectiveEffort']).toBe(effort);
    },
  );

  it('degrades xhigh to high on a model that supports max but not xhigh', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: NO_XHIGH_MODEL,
      effort: 'xhigh',
      client,
    });

    const result = await generate(makeContext());

    expect(client._calls[0]?.['output_config']).toEqual({ effort: 'high' });
    expect(result.metadata?.['effectiveEffort']).toBe('high');
  });

  it('omits output_config entirely on a model with no effort support', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: NO_EFFORT_MODEL,
      effort: 'max',
      client,
    });

    const result = await generate(makeContext());

    expect(client._calls[0]).not.toHaveProperty('output_config');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
  });

  it('reports effectiveModel and a "none" effectiveEffort when no effort was requested', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'opus', client });

    const result = await generate(makeContext());

    expect(result.metadata?.['effectiveModel']).toBe('claude-opus-4-8');
    expect(result.metadata?.['effectiveEffort']).toBe('none');
    expect(client._calls[0]).not.toHaveProperty('output_config');
  });
});
