import { type TokenCountResult, ProviderError } from '@lostgradient/operative/provider-kit';
import { createAnthropicSdkClient, isAnthropicTokenCountingClient } from './anthropic-sdk.ts';
import type {
  AnthropicCountTokensRequest,
  AnthropicTokenCountingClient,
} from './anthropic-types.ts';

/** Options for {@link createAnthropicTokenCounter}. */
export interface AnthropicTokenCounterOptions {
  /** A client to use instead of constructing the SDK one. */
  client?: AnthropicTokenCountingClient | undefined;
  /** The API key for the SDK client. Defaults to the `ANTHROPIC_API_KEY` environment variable. */
  apiKey?: string | undefined;
  /** Overrides the SDK's default base URL. */
  baseURL?: string | undefined;
}

/** The token-counting surface {@link createAnthropicTokenCounter} returns. */
export interface AnthropicTokenCountingOperations {
  /**
   * Counts the input tokens of one request without running it. Failures are thrown as `ProviderError`.
   */
  countTokens(request: AnthropicCountTokensRequest): Promise<TokenCountResult>;
}

/**
 * Creates a token counter backed by the Anthropic `messages.countTokens` endpoint.
 *
 * Like the generate factories, it loads the SDK on first use, so creating one costs nothing until `countTokens` is called.
 */
export function createAnthropicTokenCounter(
  options: AnthropicTokenCounterOptions = {},
): AnthropicTokenCountingOperations {
  let clientPromise: Promise<AnthropicTokenCountingClient> | undefined;

  function getClient(): Promise<AnthropicTokenCountingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() => {
        const clientOptions: Record<string, unknown> = {};
        if (options.apiKey) clientOptions['apiKey'] = options.apiKey;
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return createAnthropicSdkClient<AnthropicTokenCountingClient>(
          clientOptions,
          isAnthropicTokenCountingClient,
        );
      });
    }
    return clientPromise;
  }

  return {
    async countTokens(request: AnthropicCountTokensRequest): Promise<TokenCountResult> {
      try {
        const client = await getClient();
        const response = await client.messages.countTokens(request);
        return {
          totalTokens: response.input_tokens ?? 0,
          provider: 'anthropic',
          model: request.model,
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError({ provider: 'anthropic', cause: error });
      }
    },
  };
}
