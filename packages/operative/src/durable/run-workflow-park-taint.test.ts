/**
 * COR-2387 — a durable child wait's answer is scanned at the park, and a block the scan raises
 * taints the session through the run's `onToolResultTaint`, even when the handler that failed is no
 * guardrail and so stores no taint of its own.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { GUARDRAIL_BLOCKED_CODE } from '../guardrails/tool-result-guardrail';
import type { SessionTaintedEvent } from '../guardrails/types';
import type { OperativeHookMap } from '../hooks';
import {
  runWorkflowPark,
  type WorkflowParkContext,
  type WorkflowParkState,
} from './run-workflow-park';

/** Runs a workflow generator, awaiting each promise it yields. */
async function drive<T>(generator: Generator<unknown, T, unknown>): Promise<T> {
  let step = generator.next();
  while (!step.done) step = generator.next(await step.value);
  return step.value;
}

async function parkOn(hooks: HookRegistry<OperativeHookMap>) {
  const taints: SessionTaintedEvent[] = [];
  const services = {
    resolveChildWait: async () => ({ status: 'settled', child: 'a child answer' }),
    options: { hooks, onToolResultTaint: (event: SessionTaintedEvent) => void taints.push(event) },
  };
  const ctx = {
    services,
    memo: (_key: string, run: () => Promise<unknown>) =>
      (function* (): Generator<Promise<unknown>, unknown, unknown> {
        return yield run();
      })(),
    run: () => (function* () {})(),
    waitForSignal: () => (function* () {})(),
    sleep: () => (function* () {})(),
    log: () => (function* () {})(),
  } as unknown as WorkflowParkContext;
  const conversation = new Conversation();
  conversation.appendToolCalls([{ id: 'call-1', name: 'wait-for-child', arguments: {} }]);
  const state = {
    snapshot: conversation.snapshot(),
    cursor: { schemaVersion: 1, step: 0 },
    finishReason: undefined,
    stoppedEarly: false,
    pendingChildWait: {
      schemaVersion: 1,
      parentRunId: 'parent',
      childRunId: 'child',
      toolCallId: 'call-1',
      principal: 'principal',
    },
    runId: 'parent',
  } as unknown as WorkflowParkState;
  await drive(runWorkflowPark(ctx, state) as Generator<unknown, boolean, unknown>);
  return { taints, snapshot: state.snapshot };
}

describe('a durable child wait’s answer scanned at the park (COR-2387)', () => {
  it('stores a detector-failure taint when a handler that is no guardrail throws', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async () => {
      throw new Error('handler crashed');
    });
    const { taints, snapshot } = await parkOn(hooks);

    expect(taints).toEqual([
      expect.objectContaining({
        category: 'detector-failure',
        provenance: 'tool-result',
        step: 0,
      }),
    ]);
    expect(JSON.stringify(snapshot)).toContain(GUARDRAIL_BLOCKED_CODE);
    expect(JSON.stringify(snapshot)).not.toContain('a child answer');
  });

  it('stores no taint for an answer the hooks let through', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async () => undefined);
    const { taints } = await parkOn(hooks);

    expect(taints).toEqual([]);
  });
});
