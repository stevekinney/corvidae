import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import {
  createManualCheckpointStore,
  createManualDurableEngine,
  spyEngine,
  withTwoPhaseStart,
} from './durable-engine';

describe('durable engine test helpers', () => {
  it('spies on suspend, resume, and cancel while delegating to the wrapped engine', async () => {
    const delegated: string[] = [];
    const engine = {
      suspend: async (id: string) => {
        delegated.push(`suspend:${id}`);
      },
      resume: async (id: string) => {
        delegated.push(`resume:${id}`);
      },
      cancel: async (id: string) => {
        delegated.push(`cancel:${id}`);
      },
    } as unknown as RegistryAgnosticEngine;

    const spy = spyEngine(engine);

    await spy.engine.suspend('run-1');
    await spy.engine.resume('run-2');
    await spy.engine.cancel('run-3');

    expect(spy.suspends).toEqual(['run-1']);
    expect(spy.resumes).toEqual(['run-2']);
    expect(spy.cancels).toEqual(['run-3']);
    expect(delegated).toEqual(['suspend:run-1', 'resume:run-2', 'cancel:run-3']);
  });

  it('spies on start, prepare, and the prepared handle’s launch and abandon (COR-297)', async () => {
    const delegated: string[] = [];
    const engine = {
      suspend: async () => {},
      resume: async () => {},
      cancel: async () => {},
      start: async (_type: string, _input: unknown, options?: { id?: string }) => {
        delegated.push(`start:${options?.id}`);
        return { id: options?.id };
      },
      prepare: async (_type: string, _input: unknown, options?: { id?: string }) => ({
        id: options?.id ?? '',
        launch: async () => {
          delegated.push(`launch:${options?.id}`);
          return { id: options?.id };
        },
        abandon: async () => {
          delegated.push(`abandon:${options?.id}`);
        },
      }),
    } as unknown as RegistryAgnosticEngine;

    const spy = spyEngine(engine);
    await spy.engine.start('agentRun', {}, { id: 'started' });
    const launched = await spy.engine.prepare('agentRun', {}, { id: 'launched' });
    await launched.launch();
    const abandoned = await spy.engine.prepare('agentRun', {}, { id: 'abandoned' });
    await abandoned.abandon();

    expect(spy.starts).toEqual(['started']);
    expect(spy.prepares).toEqual(['launched', 'abandoned']);
    expect(spy.launches).toEqual(['launched']);
    expect(spy.abandons).toEqual(['abandoned']);
    expect(delegated).toEqual(['start:started', 'launch:launched', 'abandon:abandoned']);
  });

  it('gives a fake engine literal a prepare whose launch calls its start (COR-297)', async () => {
    const calls: unknown[] = [];
    const engine = withTwoPhaseStart({
      start: async (type: string, input: unknown, options?: { id?: string }) => {
        calls.push([type, input, options]);
        return 'handle';
      },
    });

    const prepared = await engine.prepare('agentRun', { prompt: 'hi' }, { id: 'run-1' });
    await prepared.abandon();
    expect(calls).toEqual([]);

    expect(prepared.id).toBe('run-1');
    expect(await prepared.launch()).toBe('handle');
    expect(calls).toEqual([['agentRun', { prompt: 'hi' }, { id: 'run-1' }]]);
  });

  it('prepares a manual durable run whose launch returns the shared result (COR-297)', async () => {
    const manual = createManualDurableEngine();
    const prepared = await manual.engine.prepare('agentRun', {}, { id: 'manual-run' });
    const handle = await prepared.launch();
    await prepared.abandon();
    const result = handle.result();

    manual.resolveResult();

    expect(await result).toMatchObject({ runId: 'manual-run', finishReason: 'stop-condition' });
    expect(manual.calls).toEqual({
      prepares: ['manual-run'],
      launches: ['manual-run'],
      abandons: ['manual-run'],
    });
  });

  it('creates a manual durable engine whose result can be resolved or cancelled', async () => {
    const manual = createManualDurableEngine();
    const started = await manual.engine.start('agentRun', {}, { id: 'manual-run' });
    const result = started.result();

    manual.resolveResult();

    expect(await result).toMatchObject({
      runId: 'manual-run',
      content: 'manual',
      finishReason: 'stop-condition',
    });

    const cancelled = createManualDurableEngine();
    const resumed = await cancelled.engine.resume('manual-run');
    const cancelledResult = resumed.result();

    await cancelled.engine.cancel('manual-run');

    try {
      await cancelledResult;
      throw new Error('expected cancelled result to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Workflow cancelled');
    }
  });

  it('creates a manual durable engine whose result can be rejected directly', async () => {
    const manual = createManualDurableEngine();
    const started = await manual.engine.start('agentRun', {}, { id: 'manual-run' });
    const result = started.result();

    manual.rejectResult(new Error('manual failure'));

    try {
      await result;
      throw new Error('expected manual result to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('manual failure');
    }
  });

  it('creates a checkpoint store stub with no-op persistence methods', async () => {
    const store = createManualCheckpointStore();

    expect(await store.loadCheckpoint('run-1')).toMatchObject({
      runId: 'run-1',
      cursor: {
        step: 0,
        lastContent: '',
        schemaAttempts: 0,
      },
      conversation: null,
      steps: [],
    });
    expect(await store.saveCursor('run-1', {} as never)).toBeUndefined();
    expect(await store.loadCursor('run-1')).toBeNull();
    expect(
      await store.saveConversation(
        'run-1',
        new Conversation(
          createConversationHistory({
            id: 'conversation-1',
          }),
          { now: () => '2026-01-01T00:00:00.000Z' },
        ).snapshot(),
      ),
    ).toBeUndefined();
    expect(await store.loadConversation('run-1')).toBeNull();
    expect(await store.saveStep('run-1', {} as never)).toBeUndefined();
    expect(await store.loadSteps('run-1')).toEqual([]);
    expect(await store.clear('run-1')).toBe(0);
  });
});
