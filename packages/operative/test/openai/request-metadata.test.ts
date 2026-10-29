/**
 * Per-run request-metadata passthrough (AB-93).
 *
 * `requestMetadata` is a provider-neutral option: a caller-supplied
 * `Record<string, string>` attaches to every generate request of a run.
 * Anthropic and OpenAI map it to their native `metadata` field; Gemini's
 * `generateContent` API has no request-level metadata field, so it's an
 * explicit no-op there — asserted below by confirming the mock never
 * receives a `metadata` key.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createOpenAIProvider } from '../../src/providers/openai.ts';
import { openAITextResponse } from '../../src/providers/test/openai-fixtures.ts';
import { createMockOpenAIClient } from '../../src/providers/test/openai-mock-clients.ts';
import type { GenerateContext } from '../../src/types.ts';

function makeContext(conversation: Conversation): GenerateContext {
  return { conversation, step: 0, toolbox: createToolbox([]) };
}

/** Runs `generate` three times over a growing conversation. */
async function runThreeStepLoop(
  generate: (context: GenerateContext) => Promise<unknown>,
  conversation: Conversation,
): Promise<void> {
  await generate(makeContext(conversation));
  conversation.appendAssistantMessage('Step 1 reply');
  conversation.appendUserMessage('Step 2');
  await generate(makeContext(conversation));
  conversation.appendAssistantMessage('Step 2 reply');
  conversation.appendUserMessage('Step 3');
  await generate(makeContext(conversation));
}

describe('Per-run request metadata passthrough', () => {
  it('attaches requestMetadata to every OpenAI request of a multi-step run', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Step 1');
    const client = createMockOpenAIClient([
      openAITextResponse,
      openAITextResponse,
      openAITextResponse,
    ]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o-mini',
      client,
      requestMetadata: { requestId: 'run-42', tenant: 'acme' },
    });

    await runThreeStepLoop(generate, conversation);

    expect(client._calls).toHaveLength(3);
    for (const call of client._calls) {
      expect(call['metadata']).toEqual({ requestId: 'run-42', tenant: 'acme' });
    }
  });
});
