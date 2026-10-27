import { HookRegistry } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
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
import { drainMicrotasks } from '../src/testing/drain-microtasks.test-support.ts';
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

    // Admission's verdict, at the step boundary, before the guardrail runs:
    // the turn ends as a typed policy error, and generate is never called.
    const first = await handle.run([managed]).result();
    expect(first.finishReason).toBe('error');
    expect(first.error).toBeInstanceOf(MediaAdmissionError);
    expect(seen).toHaveLength(0);
    await drainMicrotasks();

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

  it('sends the bytes the guardrail inspected when it sanitizes a descriptive field, resolving once', async () => {
    const seen: GenerateContext[] = [];
    const answers = ['QUJD', 'REVG'];
    let calls = 0;
    const resolver: ContentSourceResolver = async () => ({
      outcome: 'resolved',
      // A source that changes between reads: only the first is what the guardrail saw.
      source: { kind: 'inline', data: answers[Math.min(calls++, 1)]!, encoding: 'base64' },
      byteLength: 3,
      safety: 'clean',
    });
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on(
      'prepareStep',
      createInputGuardrail({
        action: 'sanitize',
        detectors: [
          {
            name: 'keyword',
            detect: async (input: string) =>
              input.includes('attack')
                ? {
                    triggered: true,
                    confidence: 1,
                    category: 'keyword',
                    sanitized: input.replaceAll('attack', '[removed]'),
                  }
                : { triggered: false, confidence: 0, category: 'keyword' },
          },
        ],
      }),
    );
    const conversation = new Conversation();
    conversation.appendUserMessage([
      {
        type: 'image',
        mimeType: 'image/png',
        caption: 'please attack',
        source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 },
      },
    ]);

    await createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: estimate,
      contentSourceResolver: resolver,
      hooks,
    }).result;

    expect(calls).toBe(1);
    const context = seen[0]!;
    const user = context.conversation.getMessages().find((message) => message.role === 'user');
    // The caption was sanitized, so the part the model sees is not the one that was resolved...
    expect(user?.content).toMatchObject([{ caption: 'please [removed]' }]);
    // ...yet the bytes are the ones the guardrail inspected.
    expect(context.resolvedSources?.get(`${user!.id}:0`)).toMatchObject({
      source: { data: 'QUJD' },
    });
  });
});
