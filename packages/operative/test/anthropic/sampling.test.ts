/**
 * Anthropic sampling-parameter rejections become an actionable error (COR-989).
 *
 * Models released after Claude Opus 4.6 reject a non-default `temperature`,
 * any `top_p` below 0.99, and any `top_k`. The non-streaming provider
 * recognizes that 400 after the fact. A model the per-model table
 * (`src/providers/shared/sampling.ts`) records as rejecting sampling never gets
 * that far: the provider refuses the option at construction, and the last
 * describe block covers that guard. Everything the table does not list still
 * reaches the API, and its 400 becomes a `ProviderError` naming the rejected
 * fields, the resolved model, and the remedy.
 *
 * Capture record, 2026-10-02 (raw `POST /v1/messages`, `max_tokens: 1`, one
 * user message, only the listed parameters; six requests in total):
 *
 * | # | Model             | Parameters                    | Status | `error.message`                                |
 * | - | ----------------- | ----------------------------- | ------ | ---------------------------------------------- |
 * | 1 | `claude-opus-4-8` | `temperature: 0.5`            | 400    | "`temperature` is deprecated for this model."  |
 * | 2 | `claude-opus-4-8` | `top_p: 0.9`                  | 400    | "`top_p` is deprecated for this model."        |
 * | 3 | `claude-opus-4-8` | `top_k: 5`                    | 400    | "`top_k` is deprecated for this model."        |
 * | 4 | `claude-opus-4-8` | `temperature: 0.5, top_p: 0.9`| 400    | "`temperature` is deprecated for this model."  |
 * | 5 | `claude-sonnet-5` | `temperature: 0.5`            | 400    | "`temperature` is deprecated for this model."  |
 * | 6 | `claude-opus-4-6` | `temperature: 0.5`            | 200    | accepted (control)                             |
 *
 * Each rejection names exactly one field. The combined request (#4) reported
 * only `temperature`, not a "cannot both be specified" message. Fixtures
 * marked `synthetic` are not API responses: they recombine only the recorded
 * sentences, or are authored negatives.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../../src/providers/anthropic.ts';
import { ProviderError } from '../../src/providers/errors.ts';
import { classifyProviderError } from '../../src/providers/fallover/classify-error.ts';
import { anthropicTextResponse } from '../../src/providers/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../../src/providers/test/anthropic-mock-clients.ts';
import type { GenerateContext } from '../../src/types.ts';

// Verbatim, request #1 (and #4, #5).
const TEMPERATURE_DEPRECATED = '`temperature` is deprecated for this model.';
// Verbatim, request #2.
const TOP_P_DEPRECATED = '`top_p` is deprecated for this model.';

/**
 * A model ID `shared/sampling.ts` does not list. The provider refuses a model the
 * table records as rejecting sampling before sending anything, so the
 * after-the-fact classification below is exercised through an ID the table has
 * no entry for — the case it still exists for (a model newer than the table).
 */
const UNLISTED_MODEL = 'claude-opus-6';

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

/** The SDK's `BadRequestError` message shape, with `status` as an own property. */
function badRequest(message: string, requestId: string): Error {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message },
    request_id: requestId,
  });
  return Object.assign(new Error(`400 ${body}`), { status: 400 });
}

async function rejectionFrom(
  error: unknown,
  options: { model?: string; temperature?: number; topP?: number } = {},
): Promise<ProviderError> {
  // The mock throws whatever it is handed, including a non-Error object.
  const client = createMockAnthropicClient([], [error as Error]);
  const generate = createAnthropicProvider({
    model: options.model ?? UNLISTED_MODEL,
    client,
    ...options,
  });
  const reason = await rejectionOf(generate(makeContext()));
  if (!(reason instanceof ProviderError)) throw new Error('expected a ProviderError');
  return reason;
}

describe('Anthropic sampling-parameter rejection', () => {
  it('throws a ProviderError for the verbatim temperature rejection', async () => {
    const client = createMockAnthropicClient(
      [],
      [badRequest(TEMPERATURE_DEPRECATED, 'req_011CfdsPMwH14uBNi4UpGWt9')],
    );
    const generate = createAnthropicProvider({ model: UNLISTED_MODEL, client, temperature: 0.5 });

    expect(await throwingRejectionOf(generate(makeContext()))).toThrow(ProviderError);
  });

  it('names the field, the resolved model, the remedy, and the original message', async () => {
    const original = badRequest(TEMPERATURE_DEPRECATED, 'req_011CfdsPMwH14uBNi4UpGWt9');

    // The request also carries topP, but the rejection names only temperature.
    const error = await rejectionFrom(original, {
      model: UNLISTED_MODEL,
      temperature: 0.5,
      topP: 0.9,
    });

    expect(error.message.startsWith('[provider:anthropic] ')).toBe(true);
    expect(error.message).toContain('temperature');
    expect(error.message).toContain(UNLISTED_MODEL);
    expect(error.message).toContain('drop');
    expect(error.message.endsWith(original.message)).toBe(true);
    expect(error.message).not.toContain('top_p');
    expect(error.message).not.toContain('topP');
    expect(error.cause).toBe(original);
    expect(error.statusCode).toBe(400);
  });

  it('names every field the rejection names, with the option name for top_p', async () => {
    // synthetic: the two recorded sentences joined.
    const original = badRequest(
      `${TEMPERATURE_DEPRECATED} ${TOP_P_DEPRECATED}`,
      'req_011CfdsPRKAycbYWdnBJwZ3c',
    );

    const error = await rejectionFrom(original, { temperature: 0.5, topP: 0.9 });

    expect(error.message).toContain('`temperature`');
    expect(error.message).toContain('`top_p`');
    expect(error.message).toContain('topP');
  });

  it('names the resolved model for another alias', async () => {
    // synthetic model ID, same message as request #5.
    const original = badRequest(TEMPERATURE_DEPRECATED, 'req_011CfdsPSGEWiyerUhedNqBJ');

    const error = await rejectionFrom(original, { model: 'claude-sonnet-6', temperature: 0.5 });

    expect(error.message).toContain('claude-sonnet-6');
  });

  it('keeps the enriched error classified as sampling-parameter-unsupported', async () => {
    const original = badRequest(TOP_P_DEPRECATED, 'req_011CfdsPPpPsoXRkShScXusz');

    const error = await rejectionFrom(original, { topP: 0.9 });

    expect(classifyProviderError(error)).toBe('sampling-parameter-unsupported');
  });

  it('enriches a non-Error cause that carries a 400 and a matching message', async () => {
    const original = {
      status: 400,
      message: `400 {"type":"error","error":{"type":"invalid_request_error","message":"${TEMPERATURE_DEPRECATED}"}}`,
    };

    const error = await rejectionFrom(original, { temperature: 0.5 });

    expect(error.message).toContain('temperature');
    expect(error.message).toContain(UNLISTED_MODEL);
    expect(error.message).toContain('drop');
    expect(error.cause).toBe(original);
  });

  it('passes a non-matching 400 through with the pre-change message', async () => {
    // synthetic: an unrelated invalid_request_error.
    const original = badRequest('messages: at least one message is required', 'req_unrelated');

    const error = await rejectionFrom(original, { temperature: 0.5 });

    expect(error.message).toBe(`[provider:anthropic] ${original.message}`);
    expect(error.cause).toBe(original);
    expect(classifyProviderError(error)).toBe('unknown');
  });
});

describe('Anthropic provider sampling guard from the per-model table', () => {
  it.each(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5', 'opus'])(
    'refuses temperature on %s before sending a request',
    (model) => {
      const client = createMockAnthropicClient([anthropicTextResponse]);

      expect(() => createAnthropicProvider({ model, client, temperature: 0.5 })).toThrow(
        ProviderError,
      );
      expect(client._calls).toHaveLength(0);
    },
  );

  it('names the rejected fields, the model, and the remedy', () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);

    const error = (() => {
      try {
        createAnthropicProvider({ model: 'claude-opus-5-5', client, temperature: 0.5, topP: 0.9 });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ProviderError);
    const message = (error as ProviderError).message;
    expect(message).toContain('claude-opus-5-5');
    expect(message).toContain('temperature (0.5) must be 1');
    expect(message).toContain('topP (0.9) must be 0.99');
    expect(message).toContain('omit them');
  });

  it('applies the same guard to the streaming factory', () => {
    expect(() =>
      createAnthropicProviderStream({
        model: 'claude-opus-5-5',
        client: createMockAnthropicStreamingClient([]),
        topP: 0.9,
      }),
    ).toThrow(ProviderError);
  });

  it('sends no temperature or top_p when a rejecting model is configured without them', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    await createAnthropicProvider({ model: 'claude-opus-5-5', client })(makeContext());

    const body = client._calls[0] ?? {};
    expect(Object.hasOwn(body, 'temperature')).toBe(false);
    expect(Object.hasOwn(body, 'top_p')).toBe(false);
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'])(
    'still forwards temperature and top_p on %s, which accepts them',
    async (model) => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      await createAnthropicProvider({ model, client, temperature: 0.4, topP: 0.8 })(makeContext());

      expect(client._calls[0]?.['temperature']).toBe(0.4);
      expect(client._calls[0]?.['top_p']).toBe(0.8);
    },
  );

  it('forwards sampling for a model the table does not list and leaves a 400 to the classifier', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    await createAnthropicProvider({ model: UNLISTED_MODEL, client, temperature: 0.4 })(
      makeContext(),
    );

    expect(client._calls[0]?.['temperature']).toBe(0.4);
  });
});

const DEFAULTS_ONLY_MODELS = [
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
];

describe.each(DEFAULTS_ONLY_MODELS)(
  '%s accepts exactly the documented sampling defaults',
  (model) => {
    it('forwards temperature 1 on its own', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      await createAnthropicProvider({ model, client, temperature: 1 })(makeContext());
      expect(client._calls[0]?.['temperature']).toBe(1);
    });

    it('forwards topP 0.99 on its own', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      await createAnthropicProvider({ model, client, topP: 0.99 })(makeContext());
      expect(client._calls[0]?.['top_p']).toBe(0.99);
    });

    it.each([
      ['temperature 0.5', { temperature: 0.5 }],
      ['topP 1, which the docs call out as rejected', { topP: 1 }],
      ['topP 0.9', { topP: 0.9 }],
    ])('refuses %s', (_label, sampling) => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      expect(() => createAnthropicProvider({ model, client, ...sampling })).toThrow(ProviderError);
      expect(client._calls).toHaveLength(0);
    });

    it('refuses temperature and topP together even at their defaults', () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      expect(() => createAnthropicProvider({ model, client, temperature: 1, topP: 0.99 })).toThrow(
        /cannot be sent together/,
      );
    });
  },
);

describe('defaults-only sampling on the streaming factory', () => {
  it('applies the same rule', () => {
    const client = createMockAnthropicStreamingClient([]);
    const model = 'claude-opus-5-5';
    expect(() =>
      createAnthropicProviderStream({ model, client, temperature: 1, topP: 0.99 }),
    ).toThrow(ProviderError);
    expect(() => createAnthropicProviderStream({ model, client, temperature: 0.2 })).toThrow(
      ProviderError,
    );
    expect(() => createAnthropicProviderStream({ model, client, temperature: 1 })).not.toThrow();
  });
});
