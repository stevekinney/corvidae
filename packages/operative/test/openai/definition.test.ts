/**
 * The OpenAI provider definition accepts a configuration typed as the shared base. The behavior
 * every definition shares is in `contract.test.ts`.
 */
import { describe, expect, it } from 'bun:test';

import { openaiProvider, type ProviderConfigurationBase } from '@lostgradient/operative';

describe('provider definitions', () => {
  it('accepts a configuration typed as the shared base', () => {
    const configuration: ProviderConfigurationBase = { provider: 'openai', model: 'gpt-4o' };

    expect(typeof openaiProvider.generate(configuration)).toBe('function');
  });
});
