import { HookRegistry } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createActiveRun } from '../src/create-run';
import type { OperativeHookMap } from '../src/hooks';
import type { GenerateContext } from '../src/types';

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
});
