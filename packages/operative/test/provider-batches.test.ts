/**
 * Cross-provider batch capabilities (AB-156).
 *
 * `getProviderCapabilities` is provider-neutral. The batch clients themselves, hermetic against a
 * fake client and against a local `Bun.serve`, are tested per provider in
 * `test/<provider>/batches.test.ts`.
 *
 * `getProviderCapabilities('openai')` reports on the *effective* endpoint, so an `OPENAI_BASE_URL`
 * inherited from the shell would otherwise decide the answer the assertions here are making, and
 * the suite pins it.
 */
import { describe, expect, it } from 'bun:test';
import { getProviderCapabilities } from '../src/providers/capabilities.ts';

/**
 * Runs `body` with `OPENAI_BASE_URL` set to `value` — or unset, for
 * `undefined` — and restores whatever the process had before.
 *
 * That variable is ambient input to `getProviderCapabilities('openai')`, which reads it so its
 * answer describes the endpoint a request would actually reach. The assertions cannot inherit
 * whatever shell ran the suite, so they pin it here.
 */
async function withOpenAIBaseUrl<T>(
  value: string | undefined,
  body: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env['OPENAI_BASE_URL'];
  if (value === undefined) delete process.env['OPENAI_BASE_URL'];
  else process.env['OPENAI_BASE_URL'] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env['OPENAI_BASE_URL'];
    else process.env['OPENAI_BASE_URL'] = previous;
  }
}

// ── Capability reporting ────────────────────────────────────────────

describe('getProviderCapabilities', () => {
  it('reports every capability for anthropic', () => {
    expect(getProviderCapabilities('anthropic')).toEqual({
      batchInference: true,
      explicitThinkingRequest: true,
      requestControlledContextCaching: true,
      serverSideTokenCounting: true,
    });
  });

  it('reports batch inference only for openai on its default endpoint', async () => {
    await withOpenAIBaseUrl(undefined, () => {
      expect(getProviderCapabilities('openai')).toEqual({
        batchInference: true,
        explicitThinkingRequest: false,
        requestControlledContextCaching: false,
        serverSideTokenCounting: false,
      });
    });
  });

  it('withholds batch inference for openai behind a custom base URL', async () => {
    await withOpenAIBaseUrl(undefined, () => {
      expect(getProviderCapabilities('openai', { baseURL: 'http://localhost:11434/v1' })).toEqual({
        batchInference: false,
        explicitThinkingRequest: false,
        requestControlledContextCaching: false,
        serverSideTokenCounting: false,
      });
    });
  });

  it('treats an empty-string base URL as the default openai endpoint', async () => {
    // Client construction writes the option through `if (baseURL)`, so an empty
    // string never reaches the SDK and the default endpoint is used. The
    // capability report has to agree with that or it would contradict the
    // request the caller will actually make.
    await withOpenAIBaseUrl(undefined, () => {
      expect(getProviderCapabilities('openai', { baseURL: '' }).batchInference).toBe(true);
    });
  });

  // `openai`'s `client.d.ts` documents `baseURL` as defaulting to
  // `process.env['OPENAI_BASE_URL']`, and `createOpenAIBatchClient` constructs
  // its client without one — so an unset option is not the same claim as the
  // default endpoint, and the report has to answer for the effective endpoint.
  it('withholds batch inference for openai when OPENAI_BASE_URL is set', async () => {
    await withOpenAIBaseUrl('http://localhost:1234/v1', () => {
      expect(getProviderCapabilities('openai')).toEqual({
        batchInference: false,
        explicitThinkingRequest: false,
        requestControlledContextCaching: false,
        serverSideTokenCounting: false,
      });
    });
  });

  it('still withholds batch inference when both the option and OPENAI_BASE_URL are set', async () => {
    await withOpenAIBaseUrl('http://localhost:1234/v1', () => {
      expect(
        getProviderCapabilities('openai', { baseURL: 'https://proxy.internal/v1' }).batchInference,
      ).toBe(false);
    });
  });

  it('treats an empty-string OPENAI_BASE_URL as the default openai endpoint', async () => {
    // Same truthiness the SDK applies to the option: an empty override leaves
    // the default endpoint in place, so the report agrees with it.
    await withOpenAIBaseUrl('', () => {
      expect(getProviderCapabilities('openai').batchInference).toBe(true);
    });
  });

  it('leaves the other providers unmoved by OPENAI_BASE_URL', async () => {
    // The variable names one SDK's endpoint. Letting it perturb the Anthropic
    // or Gemini rows would be a different kind of wrong answer.
    await withOpenAIBaseUrl('http://localhost:1234/v1', () => {
      expect(getProviderCapabilities('anthropic').batchInference).toBe(true);
      expect(getProviderCapabilities('gemini').batchInference).toBe(true);
    });
  });

  it('reports batching, caching, and token counting — but not thinking — for gemini', () => {
    expect(getProviderCapabilities('gemini')).toEqual({
      batchInference: true,
      explicitThinkingRequest: false,
      requestControlledContextCaching: true,
      serverSideTokenCounting: true,
    });
  });

  it('reports nothing for the embedding-only providers', () => {
    const none = {
      batchInference: false,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    };

    expect(getProviderCapabilities('voyage')).toEqual(none);
    expect(getProviderCapabilities('ollama')).toEqual(none);
  });

  it('ignores a base URL for providers whose baseURL means a forwarding proxy', () => {
    // Anthropic's and Gemini's `baseURL` document a credential-injecting proxy
    // origin, which still speaks the full provider API — unlike OpenAI's, which
    // is the documented OpenAI-compatible-server escape hatch.
    expect(getProviderCapabilities('anthropic', { baseURL: 'https://proxy.internal' })).toEqual(
      getProviderCapabilities('anthropic'),
    );
    expect(getProviderCapabilities('gemini', { baseURL: 'https://proxy.internal' })).toEqual(
      getProviderCapabilities('gemini'),
    );
  });
});
