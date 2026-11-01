/**
 * COR-1961 — `GenerateContext.runId` names the run a step belongs to, so a generate function that
 * needs whose step it answers (a host's policy lookup) does not parse `assistantMessageId`. Like
 * `assistantMessageId`, a `beforeGenerate` hook or a retry mutator cannot replace or drop it, and a
 * run with no run id has none.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import type { OperativeHookMap } from './hooks';
import type { GenerateContext } from './types';

const textResponse = { content: 'done', toolCalls: [] };

describe('GenerateContext.runId', () => {
  it('is the run’s id on every step', async () => {
    const seen: Array<string | undefined> = [];
    const result = await createActiveRun({
      generate: async (context) => {
        seen.push(context.runId);
        return textResponse;
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runId: 'run-61',
    }).result;

    expect(result.finishReason).toBe('stop-condition');
    expect(seen).toEqual(['run-61']);
  });

  it('is the one the loop minted when the caller supplied none', async () => {
    const seen: Array<string | undefined> = [];
    const activeRun = createActiveRun({
      generate: async (context) => {
        seen.push(context.runId);
        return textResponse;
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    await activeRun.result;

    expect(seen).toEqual([activeRun.snapshot().id]);
  });

  it('is re-applied after a beforeGenerate hook that replaces or drops it', async () => {
    const seen: Array<string | undefined> = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('beforeGenerate', async (context: GenerateContext) => ({
      ...context,
      runId: 'forged',
    }));
    hooks.on('beforeGenerate', async (context: GenerateContext) => {
      const { runId: _dropped, ...rest } = context;
      return rest;
    });
    await createActiveRun({
      generate: async (context) => {
        seen.push(context.runId);
        return textResponse;
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      runId: 'run-61',
    }).result;

    expect(seen).toEqual(['run-61']);
  });

  it('is re-applied to a retried attempt whose mutator omits it', async () => {
    const seen: Array<string | undefined> = [];
    let attempts = 0;
    await createActiveRun({
      generate: async (context) => {
        seen.push(context.runId);
        attempts++;
        if (attempts === 1) throw new Error('transient');
        return textResponse;
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runId: 'run-61',
      retry: {
        attempts: 2,
        delay: 0,
        mutate: () => ({
          conversation: new Conversation(),
          step: 0,
          toolbox: createTestToolbox([]),
        }),
      },
    }).result;

    expect(seen).toEqual(['run-61', 'run-61']);
  });
});
