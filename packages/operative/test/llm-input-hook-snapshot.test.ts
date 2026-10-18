import { HookRegistry } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { Conversation } from 'conversationalist';

import { createActiveRun } from '../src/create-run';
import type { OperativeHookMap } from '../src/hooks';
import type { ContentSourceResolver, GenerateContext } from '../src/types';

const flagged: MediaContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId: 'flagged-1' },
};
const resolver: ContentSourceResolver = async () => ({
  outcome: 'resolved',
  source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
  byteLength: 3,
  safety: 'flagged',
});

/**
 * COR-716 — `onLLMInput` runs after the binding derivation and before the
 * call, so it is handed a snapshot, not the live conversation: the hook is
 * read-only by contract, and media it appends to its copy never reaches
 * `generate`, admitted or not.
 */
describe('onLLMInput cannot change what generate receives', () => {
  it('media an onLLMInput handler appends is not in the sent conversation', async () => {
    const seen: GenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onLLMInput', async (context) => {
      context.conversation.appendUserMessage([flagged]);
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');
    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      hooks,
      contentSourceResolver: resolver,
      mediaCostEstimator: (part, position) => ({
        ...position,
        modality: part.type,
        outcome: 'estimated',
        tokens: 1,
        basis: 'catalog-estimate',
      }),
    }).result;
    const sentMedia = seen.flatMap((context) =>
      context.conversation
        .getMessages()
        .flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'image')
            : [],
        ),
    );
    expect(result.finishReason).toBe('stop-condition');
    expect(sentMedia).toHaveLength(0);
    // The run's own conversation is untouched too: the hook wrote to a copy.
    expect(conversation.getMessages()).toHaveLength(2);
  });
});
