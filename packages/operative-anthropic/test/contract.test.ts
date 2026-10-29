/** The shared provider contract, run against the Anthropic definition. */
import { runProviderContract } from '@lostgradient/operative/provider-testing';
import { anthropicProvider } from '../src/anthropic-definition.ts';
import type { AnthropicMessageCreateRequest } from '../src/anthropic-types.ts';
import {
  anthropicStreamTextEvents,
  anthropicTextResponse,
} from '../src/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/test/anthropic-mock-clients.ts';

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
