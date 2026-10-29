/** The shared provider contract, run against the Gemini definition. */
import { runProviderContract } from '../../src/provider-testing.ts';
import { geminiProvider } from '../../src/providers/gemini-definition.ts';
import type { GeminiGenerateContentRequest } from '../../src/providers/gemini-types.ts';
import {
  geminiStreamTextChunks,
  geminiTextResponse,
} from '../../src/providers/test/gemini-fixtures.ts';
import {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from '../../src/providers/test/gemini-mock-clients.ts';

function readConfig(call: GeminiGenerateContentRequest): Record<string, unknown> | undefined {
  return call.config as Record<string, unknown> | undefined;
}

runProviderContract<GeminiGenerateContentRequest>({
  definition: geminiProvider,
  createMockClient(shape) {
    const mock =
      shape === 'stream'
        ? createMockGeminiStreamingModel([geminiStreamTextChunks])
        : createMockGeminiModel([geminiTextResponse]);
    return { client: mock, calls: mock._calls };
  },
  fixtures: {
    name: 'gemini',
    model: 'gemini-2.5-flash',
    unknownModel: 'gemini-does-not-exist-in-the-seed',
    text: 'Hello from Gemini!',
    readModel: (call) => call.model,
    readMaximumTokens: (call) => readConfig(call)?.['maxOutputTokens'],
    readToolNames: (call) =>
      (
        readConfig(call)?.['tools'] as
          Array<{ functionDeclarations: Array<{ name: string }> }> | undefined
      )?.flatMap((tool) => tool.functionDeclarations.map((entry) => entry.name)),
  },
});
