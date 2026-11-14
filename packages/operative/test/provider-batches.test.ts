/**
 * Cross-provider batch capabilities (AB-156).
 *
 * `getProviderCapabilities` is provider-neutral: it answers from the rows it is given, and reports
 * nothing for a provider none of them names. What each vendor's own rows report, and the OpenAI
 * endpoint rule, are tested in the vendor packages (`test/catalog-rows.test.ts`). The batch
 * clients themselves, hermetic against a fake client and against a local `Bun.serve`, are tested
 * per provider in `test/<provider>/batches.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { getProviderCapabilities } from '../src/providers/capabilities.ts';
import { fixtureRows } from '../src/testing/model-catalog.test-support.ts';

const descriptors = fixtureRows();

describe('getProviderCapabilities', () => {
  it('reports every capability for a provider whose rows have them all', () => {
    expect(getProviderCapabilities('alpha', { descriptors })).toEqual({
      batchInference: true,
      explicitThinkingRequest: true,
      requestControlledContextCaching: true,
      serverSideTokenCounting: true,
    });
  });

  it('reports batch inference only for a provider whose rows offer nothing else', () => {
    expect(getProviderCapabilities('beta', { descriptors })).toEqual({
      batchInference: true,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    });
  });

  it('reports a capability only when every one of the provider’s rows has it', () => {
    const [first, ...rest] = descriptors.filter((row) => row.provider === 'alpha');
    const withoutBatches = [{ ...first!, batchInference: false }, ...rest];
    expect(getProviderCapabilities('alpha', { descriptors: withoutBatches }).batchInference).toBe(
      false,
    );
  });

  it('reports nothing for a provider no row names, and for every provider when given no rows', () => {
    const none = {
      batchInference: false,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    };

    expect(getProviderCapabilities('voyage', { descriptors })).toEqual(none);
    expect(getProviderCapabilities('alpha')).toEqual(none);
  });

  it('is unmoved by OPENAI_BASE_URL: Operative reads no vendor’s endpoint, a vendor’s rows say it', () => {
    const previous = process.env['OPENAI_BASE_URL'];
    process.env['OPENAI_BASE_URL'] = 'http://localhost:1234/v1';
    try {
      expect(getProviderCapabilities('beta', { descriptors }).batchInference).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['OPENAI_BASE_URL'];
      else process.env['OPENAI_BASE_URL'] = previous;
    }
  });
});
