/** The shared provider contract, run against the OpenAI definition. */
import type { ProviderDefinition } from '@lostgradient/operative/provider-kit';
import { runProviderContract } from '@lostgradient/operative/provider-testing';
import { openaiProvider, type OpenAIProviderConfiguration } from '../src/openai-definition.ts';
import type { OpenAIChatCompletionCreateRequest } from '../src/openai-types.ts';
import { openAIStreamTextChunks, openAITextResponse } from '../src/test/openai-fixtures.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/test/openai-mock-clients.ts';

type StatefulProvider = ProviderDefinition<'openai', OpenAIProviderConfiguration> & {
  readonly delegate: typeof openaiProvider;
};

/** Exercises the shared contract with real methods, whose receiver must survive factory calls. */
const statefulProvider: StatefulProvider = {
  name: 'openai',
  delegate: openaiProvider,
  generate(configuration) {
    if (this.delegate !== openaiProvider) throw new Error('lost provider receiver');
    return this.delegate.generate!(configuration);
  },
  stream(configuration) {
    if (this.delegate !== openaiProvider) throw new Error('lost provider receiver');
    return this.delegate.stream!(configuration);
  },
};

runProviderContract<OpenAIChatCompletionCreateRequest>({
  definition: statefulProvider,
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
