/**
 * Strategy-level tests for `RevisionRealmExecutionStrategy` (COR-249's
 * engine integration, R2E), mirroring `worker-execution-strategy.test.ts`'s
 * own convention of driving the strategy directly rather than only through
 * a full `Engine`. `revision-realm-execution.test.ts` (engine-level) already
 * proves `startWorkflow`/activation/recovery end to end; this file covers
 * `cancelWorkflow` and disposal, which that suite's scenarios never
 * exercise.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import type { WorkerOutboundMessage } from '../types.ts';
import { RevisionRealmExecutionStrategy } from './revision-realm-execution-strategy.ts';
import { RevisionRealmRegistry } from './revision-realm-registry.ts';

const ORDER_WORKFLOW_NAME = 'r2e-order-workflow';
const REVISION = 'revision-a';
const workerUrl = new URL('./__fixtures__/revision-a-order-worker.fixture.ts', import.meta.url);

function newStrategy(): {
  strategy: RevisionRealmExecutionStrategy;
  registry: RevisionRealmRegistry;
  messages: WorkerOutboundMessage[];
} {
  const registry = new RevisionRealmRegistry();
  const messages: WorkerOutboundMessage[] = [];
  const strategy = new RevisionRealmExecutionStrategy({
    registry,
    resolveRevisionRealmConfig: () => ({ workerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }),
    getWorkflowRevisionPin: () => undefined,
  });
  strategy.onMessage((message) => {
    messages.push(message);
  });
  return { strategy, registry, messages };
}

describe('RevisionRealmExecutionStrategy', () => {
  describe('cancelWorkflow', () => {
    it('is a no-op for a workflow id with no active execution', () => {
      const { strategy, registry } = newStrategy();
      const disposeSpy = spyOn(registry, 'dispose');
      expect(() => strategy.cancelWorkflow('unknown-workflow')).not.toThrow();
      expect(disposeSpy).not.toHaveBeenCalled();
    });

    it('releases the realm for an in-flight execution and emits nothing further for it (non-cooperative cancel)', async () => {
      const { strategy, registry, messages } = newStrategy();
      strategy.startWorkflow({
        workflowId: 'wf-realm-cancel',
        revision: REVISION,
        workflowType: ORDER_WORKFLOW_NAME,
        input: 'input',
        checkpoint: new ArrayBuffer(0),
      });
      await waitForCondition(() => registry.activeRealmCount(ORDER_WORKFLOW_NAME, REVISION) === 1, {
        label: 'realm active for wf-realm-cancel',
      });

      strategy.cancelWorkflow('wf-realm-cancel');

      await waitForCondition(
        () => (registry.getPool(ORDER_WORKFLOW_NAME, REVISION)?.realmCount ?? 0) === 0,
        { label: 'realm released after cancel' },
      );
      // The cancel-triggered rejection of the pending turn must never
      // surface as a workflow message — the engine already recorded the
      // cancellation itself. (A LATER resumeWorkflow() call for the same,
      // now fully torn-down workflow id legitimately reports "no realm
      // assigned" instead, matching WorkerExecutionStrategy's identical
      // consumeCancelled-is-single-use precedent — the swallow only covers
      // the one settlement cancelWorkflow() itself triggered.)
      expect(messages).toEqual([]);
    });
  });

  describe('disposal (COR-113 memoized idempotent disposal)', () => {
    it('[Symbol.dispose]() disposes the registry synchronously and only once', () => {
      const { strategy, registry } = newStrategy();
      const disposeSpy = spyOn(registry, 'dispose');
      strategy[Symbol.dispose]();
      strategy[Symbol.dispose]();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('[Symbol.asyncDispose]() disposes the registry and memoizes concurrent calls into one promise', async () => {
      const { strategy, registry } = newStrategy();
      const disposeSpy = spyOn(registry, 'dispose');
      await Promise.all([strategy[Symbol.asyncDispose](), strategy[Symbol.asyncDispose]()]);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
