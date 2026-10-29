/** The shared provider contract, run against the OpenAI definition. */
import { runProviderContract } from '@lostgradient/operative/provider-testing';
import { openaiProvider } from '../src/openai-definition.ts';
import type { OpenAIChatCompletionCreateRequest } from '../src/openai-types.ts';
import { openAIStreamTextChunks, openAITextResponse } from '../src/test/openai-fixtures.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/test/openai-mock-clients.ts';

runProviderContract<OpenAIChatCompletionCreateRequest>({
  definition: openaiProvider,
  createMockClient(shape) {
    const mock =
      shape === 'stream'
        ? createMockOpenAIStreamingClient([openAIStreamTextChunks])
        : createMockOpenAIClient([openAITextResponse]);
    return { client: mock, calls: mock._calls };
  },
  fixtures: {
    name: 'openai',
    model: 'gpt-4o',
    unknownModel: 'gpt-does-not-exist-in-the-seed',
    text: 'Hello from OpenAI!',
    readModel: (call) => call['model'],
    readMaximumTokens: (call) => call['max_tokens'],
    readToolNames: (call) =>
      (call['tools'] as Array<{ function: { name: string } }> | undefined)?.map(
        (tool) => tool.function.name,
      ),
  },
});
