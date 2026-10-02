/**
 * Anthropic sampling-parameter rejections become an actionable error (COR-989).
 *
 * Models released after Claude Opus 4.6 reject a non-default `temperature`,
 * any `top_p` below 0.99, and any `top_k`. The non-streaming provider
 * recognizes that 400 after the fact, rather than checking against a model
 * list that would go stale, and throws a `ProviderError` naming the rejected
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

import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { classifyProviderError } from '../src/providers/fallover/classify-error.ts';
import { createMockAnthropicClient } from '../src/providers/test/mock-clients.ts';
import { rejectionOf, throwingRejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import type { GenerateContext } from '../src/types.ts';

// Verbatim, request #1 (and #4, #5).
const TEMPERATURE_DEPRECATED = '`temperature` is deprecated for this model.';
// Verbatim, request #2.
const TOP_P_DEPRECATED = '`top_p` is deprecated for this model.';

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
  const generate = createAnthropicProvider({ model: options.model ?? 'opus', client, ...options });
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
    const generate = createAnthropicProvider({ model: 'opus', client, temperature: 0.5 });

    expect(await throwingRejectionOf(generate(makeContext()))).toThrow(ProviderError);
  });

  it('names the field, the resolved model, the remedy, and the original message', async () => {
    const original = badRequest(TEMPERATURE_DEPRECATED, 'req_011CfdsPMwH14uBNi4UpGWt9');

    // The request also carries topP, but the rejection names only temperature.
    const error = await rejectionFrom(original, { model: 'opus', temperature: 0.5, topP: 0.9 });

    expect(error.message.startsWith('[provider:anthropic] ')).toBe(true);
    expect(error.message).toContain('temperature');
    expect(error.message).toContain('claude-opus-4-8');
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
    // Verbatim, request #5.
    const original = badRequest(TEMPERATURE_DEPRECATED, 'req_011CfdsPSGEWiyerUhedNqBJ');

    const error = await rejectionFrom(original, { model: 'sonnet', temperature: 0.5 });

    expect(error.message).toContain('claude-sonnet-5');
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
    expect(error.message).toContain('claude-opus-4-8');
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
