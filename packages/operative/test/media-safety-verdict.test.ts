import { HookRegistry } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';
import { Conversation } from 'conversationalist';

import type { MediaCostEstimator } from '../src/context/types';
import { createActiveRun } from '../src/create-run';
import { MediaAdmissionError } from '../src/errors';
import { createInputGuardrail } from '../src/guardrails/input-guardrail';
import type { OperativeHookMap } from '../src/hooks';
import { createSessionStore } from '../src/session/create-session-store';
import { createSessionHandle } from '../src/session/session-handle';
import type { ContentSourceResolver, GenerateContext, GenerateFunction } from '../src/types';

const estimate: MediaCostEstimator = (part, position) => ({
  ...position,
  modality: part.type,
  outcome: 'estimated',
  tokens: 10,
  basis: 'catalog-estimate',
});

const managed: MediaContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId: 'asset-flagged', revision: 1 },
};

const flaggedResolver: ContentSourceResolver = async () => ({
  outcome: 'resolved',
  source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
  byteLength: 3,
  safety: 'flagged',
});

function guardrailHooks() {
  const hooks = new HookRegistry<OperativeHookMap>();
  hooks.on('prepareStep', createInputGuardrail({ detectors: [] }));
  return hooks;
}

/**
 * COR-716 — admission owns the safety verdict for every media part the step sends,
 * and the guardrail reads the text a provider would read, resolved bodies included.
 */
describe('a flagged asset never reaches generate (COR-716)', () => {
  it('a follow-up text turn does not carry a flagged asset the guardrail blocked on the previous turn', async () => {
    await yieldToPortableEventLoop();
    const store = createSessionStore(textValueStore(new MemoryStorage()));
    const seen: GenerateContext[] = [];
    const generate: GenerateFunction = async (context) => {
      seen.push(context);
      return { content: 'ok', toolCalls: [] };
    };
    const handle = createSessionHandle('flagged-session', {
      store,
      agentName: 'agent',
      runOptions: {
        generate,
        toolbox: createToolbox([]),
        stopWhen: () => true,
        mediaCostEstimator: estimate,
        contentSourceResolver: flaggedResolver,
        hooks: guardrailHooks(),
      },
    });

    const first = await handle.run([managed]).result();
    expect(first.content).toContain('blocked');
    expect(seen).toHaveLength(0);
    await yieldToPortableEventLoop();

    await handle.run('thanks, anything else?').result();
    // The flagged asset is still in the history. If generate ran, it was handed the flagged bytes.
    const flaggedDelivered = seen.some((context) =>
      [...(context.resolvedSources ?? new Map()).values()].some(
        (entry) => entry.safety === 'flagged',
      ),
    );
    expect(flaggedDelivered).toBe(false);
  });

  it('without an input guardrail, a flagged asset is still refused before generate', async () => {
    const seen: GenerateContext[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage([managed]);
    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      contentSourceResolver: flaggedResolver,
    }).result;
    expect(seen).toHaveLength(0);
    expect(result.finishReason).toBe('error');
  });

  it('the input guardrail reads the text of a clean managed text document it resolved', async () => {
    const seen: GenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on(
      'prepareStep',
      createInputGuardrail({
        detectors: [
          {
            name: 'secret',
            detect: async (input: string) => ({
              triggered: input.includes('SECRET'),
              confidence: 1,
              category: 'secret',
            }),
          },
        ],
      }),
    );
    const conversation = new Conversation();
    conversation.appendUserMessage([
      {
        type: 'document',
        mimeType: 'text/plain',
        source: { kind: 'managed-asset', assetId: 'doc', revision: 1 },
      },
    ]);
    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      hooks,
      contentSourceResolver: async () => ({
        outcome: 'resolved',
        source: { kind: 'inline', data: 'the SECRET is 42', encoding: 'utf8' },
        mimeType: 'text/plain',
        safety: 'clean',
      }),
    }).result;
    expect(seen).toHaveLength(0);
    expect(result.content).toContain('blocked');
  });

  it('refuses a flagged asset when the input guardrail only warns, whatever its detectors say', async () => {
    const seen: GenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', createInputGuardrail({ detectors: [], action: 'warn' }));
    const conversation = new Conversation();
    conversation.appendUserMessage([managed]);

    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      contentSourceResolver: flaggedResolver,
      hooks,
    }).result;

    expect(seen).toHaveLength(0);
    expect(result.finishReason).toBe('error');
    expect((result.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      reason: 'asset-flagged',
    });
  });

  it('applies the unverified-asset policy to an asset in an earlier message, with no guardrail', async () => {
    const seen: GenerateContext[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage([managed]);
    conversation.appendAssistantMessage('noted');
    conversation.appendUserMessage('and now?');

    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      assetSafety: { unknown: 'block' },
      contentSourceResolver: async () => ({
        outcome: 'resolved',
        source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
        byteLength: 3,
        safety: 'unknown',
      }),
    }).result;

    expect(seen).toHaveLength(0);
    expect((result.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      reason: 'asset-unverified',
      partIndex: 0,
    });
  });

  it('refuses text a provider would read but no detector can, whatever the guardrail action', async () => {
    for (const action of ['block', 'warn'] as const) {
      const seen: GenerateContext[] = [];
      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('prepareStep', createInputGuardrail({ detectors: [], action }));
      const conversation = new Conversation();
      conversation.appendUserMessage([
        {
          type: 'document',
          mimeType: 'text/plain',
          source: { kind: 'inline', data: btoa('\xff\xfe'), encoding: 'base64' },
        },
      ]);
      const result = await createActiveRun({
        generate: async (context) => {
          seen.push(context);
          return { content: 'ok', toolCalls: [] };
        },
        toolbox: createToolbox([]),
        conversation,
        stopWhen: () => true,
        mediaCostEstimator: estimate,
        hooks,
      }).result;

      expect(seen).toHaveLength(0);
      expect(result.content).toContain('blocked');
    }
  });
});
