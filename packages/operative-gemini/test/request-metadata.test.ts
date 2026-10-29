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
import type { GenerateContext } from '@lostgradient/operative/provider-kit';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createGeminiProvider } from '../src/gemini.ts';
import { geminiTextResponse } from '../src/test/gemini-fixtures.ts';
import { createMockGeminiModel } from '../src/test/gemini-mock-clients.ts';

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
  it('does not send requestMetadata to Gemini (documented no-op)', async () => {
    const conversation = new Conversation();
    conversation.appendUserMessage('Step 1');
    const model = createMockGeminiModel([
      geminiTextResponse,
      geminiTextResponse,
      geminiTextResponse,
    ]);
    const generate = createGeminiProvider({
      model: 'gemini-1.5-flash',
      client: model,
      requestMetadata: { requestId: 'run-42', tenant: 'acme' },
    });

    await runThreeStepLoop(generate, conversation);

    expect(model._calls).toHaveLength(3);
    for (const call of model._calls) {
      // Asserting absence, not just an undefined value — `metadata: undefined`
      // would also satisfy `toBeUndefined()` but is not the documented no-op.
      expect(Object.hasOwn(call, 'metadata')).toBe(false);
    }
  });
});
