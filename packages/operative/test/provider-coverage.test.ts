import { describe, expect, it } from 'bun:test';
import {
  extractStatusCode,
  ProviderError,
  shouldRetryProviderError,
} from '../src/providers/errors.ts';
import { resolveCommonParameters } from '../src/providers/shared/resolve-common-parameters.ts';

describe('provider helper coverage', () => {
  it('extracts common parameters and omits empty stop sequences', () => {
    expect(resolveCommonParameters({ stopSequences: [] })).toEqual({});
    expect(
      resolveCommonParameters({
        maximumTokens: 100,
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ['END'],
      }),
    ).toEqual({
      maximumTokens: 100,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });

  it('extracts provider status codes and retryability from SDK error shapes', () => {
    expect(extractStatusCode({ status: 429 })).toBe(429);
    expect(extractStatusCode({ statusCode: 500 })).toBe(500);
    expect(extractStatusCode({ error: { status: 400 } })).toBe(400);
    expect(extractStatusCode('plain failure')).toBeUndefined();

    const retryable = new ProviderError({ provider: 'openai', cause: { status: 503 } });
    const nonRetryable = new ProviderError({ provider: 'openai', cause: 'bad request' });

    expect(retryable.message).toBe('[provider:openai] Unknown error');
    expect(retryable.retryable).toBe(true);
    expect(nonRetryable.message).toBe('[provider:openai] bad request');
    expect(shouldRetryProviderError(retryable)).toBe(true);
    expect(shouldRetryProviderError(nonRetryable)).toBe(false);
    expect(shouldRetryProviderError(new Error('other'))).toBe(false);
  });
});
