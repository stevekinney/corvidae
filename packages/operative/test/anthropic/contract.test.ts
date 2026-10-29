/** The shared provider contract, run against the Anthropic definition. */
import { runProviderContract } from '../../src/provider-testing.ts';
import { anthropicProvider } from '../../src/providers/anthropic-definition.ts';
import type { AnthropicMessageCreateRequest } from '../../src/providers/anthropic-types.ts';
import {
  anthropicStreamTextEvents,
  anthropicTextResponse,
} from '../../src/providers/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../../src/providers/test/anthropic-mock-clients.ts';

runProviderContract<AnthropicMessageCreateRequest>({
  definition: anthropicProvider,
  createMockClient(shape) {
    const mock =
      shape === 'stream'
        ? createMockAnthropicStreamingClient([anthropicStreamTextEvents])
        : createMockAnthropicClient([anthropicTextResponse]);
    return { client: mock, calls: mock._calls };
  },
  fixtures: {
    name: 'anthropic',
    model: 'claude-sonnet-5',
    unknownModel: 'claude-does-not-exist-in-the-seed',
    text: 'Hello from Anthropic!',
    readModel: (call) => call['model'],
    readMaximumTokens: (call) => call['max_tokens'],
    readToolNames: (call) =>
      (call['tools'] as Array<{ name: string }> | undefined)?.map((tool) => tool.name),
  },
});
