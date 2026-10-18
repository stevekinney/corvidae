import { HookRegistry } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createActiveRun } from '../src/create-run';
import type { OperativeHookMap } from '../src/hooks';
import type { ContentSourceResolver, GenerateContext } from '../src/types';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((_resolve) => (resolve = _resolve));
  return { promise, resolve };
}

describe('a cancel during media resolution (COR-716)', () => {
  it('does not call generate once the run was aborted while its media resolved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let resolving!: () => void;
    const started = new Promise<void>((resolve) => (resolving = resolve));
    const seen: GenerateContext[] = [];
    const conversation = new Conversation();
    conversation.appendUserMessage([
      { type: 'image', mimeType: 'image/png', source: { kind: 'managed-asset', assetId: 'a' } },
    ]);
    const run = createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      mediaCostEstimator: (part, position) => ({
        ...position,
        modality: part.type,
        outcome: 'estimated',
        tokens: 1,
        basis: 'catalog-estimate',
      }),
      contentSourceResolver: async () => {
        resolving();
        await gate;
        return {
          outcome: 'resolved',
          source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
          safety: 'clean',
        };
      },
    });
    await started;
    run.abort('user cancelled');
    release();
    const result = await run.result;
    expect(seen).toHaveLength(0);
    expect(result.finishReason).toBe('aborted');
  });

  it('does not call generate once the run was aborted while media a handler added resolved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let resolving!: () => void;
    const started = new Promise<void>((resolve) => (resolving = resolve));
    const seen: GenerateContext[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('beforeGenerate', async (context) => {
      context.conversation.appendUserMessage([
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'managed-asset', assetId: 'late' },
        },
      ]);
    });
    const conversation = new Conversation();
    conversation.appendUserMessage('plain');
    const run = createActiveRun({
      generate: async (context) => {
        seen.push(context);
        return { content: 'ok', toolCalls: [] };
      },
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
      hooks,
      mediaCostEstimator: (part, position) => ({
        ...position,
        modality: part.type,
        outcome: 'estimated',
        tokens: 1,
        basis: 'catalog-estimate',
      }),
      contentSourceResolver: async () => {
        resolving();
        await gate;
        return {
          outcome: 'resolved',
          source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
          safety: 'clean',
        };
      },
    });
    await started;
    run.abort('user cancelled');
    release();
    const result = await run.result;

    expect(seen).toHaveLength(0);
    expect(result.finishReason).toBe('aborted');
  });

  describe('a resolver that stalls', () => {
    const priced = (part: { type: never }, position: object) => ({
      ...position,
      modality: part.type,
      outcome: 'estimated' as const,
      tokens: 1,
      basis: 'catalog-estimate' as const,
    });

    function runWith(resolver: ContentSourceResolver) {
      const seen: GenerateContext[] = [];
      const conversation = new Conversation();
      conversation.appendUserMessage([
        { type: 'image', mimeType: 'image/png', source: { kind: 'managed-asset', assetId: 'a' } },
      ]);
      const run = createActiveRun({
        generate: async (context) => {
          seen.push(context);
          return { content: 'ok', toolCalls: [] };
        },
        toolbox: createToolbox([]),
        conversation,
        stopWhen: () => true,
        mediaCostEstimator: priced as never,
        contentSourceResolver: resolver,
      });
      return { run, seen };
    }

    it('is handed the run’s signal, and run.abort() settles the run as aborted when the resolver honors it', async () => {
      let received: AbortSignal | undefined;
      const started = deferred();
      const { run, seen } = runWith((_part, position) => {
        received = position.signal;
        started.resolve();
        return new Promise((_resolve, reject) => {
          position.signal?.addEventListener('abort', () => reject(position.signal?.reason), {
            once: true,
          });
        });
      });
      await started.promise;
      expect(received).toBeDefined();
      expect(received?.aborted).toBe(false);

      run.abort('user cancelled');
      const result = await run.result;

      expect(received?.aborted).toBe(true);
      expect(result.finishReason).toBe('aborted');
      expect(seen).toHaveLength(0);
    });

    it('still settles as aborted when the resolver ignores the signal and never settles', async () => {
      const started = deferred();
      const { run, seen } = runWith(() => {
        started.resolve();
        return new Promise(() => {});
      });
      await started.promise;

      run.abort('user cancelled');
      const result = await run.result;

      expect(result.finishReason).toBe('aborted');
      expect(seen).toHaveLength(0);
    });
  });
});
