/**
 * Strategy-level tests for `RevisionRealmExecutionStrategy` (COR-249's
 * engine integration, R2E), mirroring `worker-execution-strategy.test.ts`'s
 * own convention of driving the strategy directly rather than only through
 * a full `Engine`. `revision-realm-execution.test.ts` (engine-level) already
 * proves `startWorkflow`/activation/recovery end to end; this file covers
 * `cancelWorkflow`, disposal, and crash-triggered realm reclamation, which
 * that suite's scenarios never exercise.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import type { WorkerOutboundMessage } from '../types.ts';
import { RevisionRealmExecutionStrategy } from './revision-realm-execution-strategy.ts';
import { RevisionRealmRegistry } from './revision-realm-registry.ts';

const ORDER_WORKFLOW_NAME = 'r2e-order-workflow';
const REVISION = 'revision-a';
const workerUrl = new URL('./__fixtures__/revision-a-order-worker.fixture.ts', import.meta.url);
const crashWorkerUrl = new URL('./__fixtures__/revision-crash-worker.fixture.ts', import.meta.url);
const CRASH_REVISION = 'revision-crash';
// Matching `ORDER_WORKFLOW_NAME`/`REVISION` above: a literal duplicate of
// `crash-workflow-handler.fixture.ts`'s own exported constants, not an
// import of them. That fixture's crash branch only ever runs inside the
// spawned Worker `crashWorkerUrl` points at; importing its constants here
// would pull the whole module into THIS test file's own static import
// graph, which is what the main (non-Worker) test process instruments for
// coverage — turning an already-covered-by-design "runs only inside a
// Worker" file into a spurious line-coverage gap (order-workflow-handler
// and sentinel-workflow's own fixtures avoid this the same way).
const CRASH_WORKFLOW_NAME = 'r2e-crash-workflow';
const CRASH_WORKFLOW_TRIGGER_INPUT = 'crash-mid-turn';

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

    it('cancelling a PARKED execution does not poison a later, unrelated execution that reuses the same workflow id (P-COR-29 criterion 7 regression)', async () => {
      // Regression for a permanent `#cancelled` entry: cancelling while
      // PARKED (no turn in flight — a workflow waiting on a signal, the
      // ordinary cancel target) must not leave anything for a future
      // execution reusing this workflow id to mistake for its own
      // cancellation. Before the fix, `cancelWorkflow` added to `#cancelled`
      // unconditionally, and nothing ever removed a park-time entry, so the
      // second execution's genuine mid-turn crash below was silently
      // swallowed by `#dispatch`'s catch block instead of being reported,
      // and its realm's pool slot was never reclaimed.
      const registry = new RevisionRealmRegistry();
      const messages: WorkerOutboundMessage[] = [];
      const strategy = new RevisionRealmExecutionStrategy({
        registry,
        resolveRevisionRealmConfig: (workflowType) =>
          workflowType === ORDER_WORKFLOW_NAME
            ? { workerUrl, expectedWorkflowTypes: [ORDER_WORKFLOW_NAME] }
            : {
                workerUrl: crashWorkerUrl,
                expectedWorkflowTypes: [CRASH_WORKFLOW_NAME],
                // Concurrency 1: proves the crashed realm's pool slot is
                // actually reclaimed, not merely that some realm exists.
                concurrency: 1,
              },
        getWorkflowRevisionPin: () => undefined,
      });
      strategy.onMessage((message) => {
        messages.push(message);
      });
      const workflowId = 'wf-reused-after-park-cancel';

      // First execution: parks on a signal-wait. Waiting for its `checkpoint`
      // outbound message (not merely `activeRealmCount === 1`, which the
      // in-flight cancel test above uses) proves the turn has already
      // SETTLED — no dispatch is pending — before cancel runs.
      strategy.startWorkflow({
        workflowId,
        revision: REVISION,
        workflowType: ORDER_WORKFLOW_NAME,
        input: 'input',
        checkpoint: new ArrayBuffer(0),
      });
      await waitForCondition(() => messages.length === 1, {
        label: 'first execution parked on signal-wait',
      });
      expect(messages[0]?.type).toBe('checkpoint');

      strategy.cancelWorkflow(workflowId);
      await waitForCondition(
        () => (registry.getPool(ORDER_WORKFLOW_NAME, REVISION)?.realmCount ?? 0) === 0,
        { label: 'first executions realm released after cancel' },
      );

      // Second, unrelated execution reuses the SAME workflow id, routed to a
      // still-active, concurrency-1 revision whose realm genuinely crashes
      // mid-turn.
      strategy.startWorkflow({
        workflowId,
        revision: CRASH_REVISION,
        workflowType: CRASH_WORKFLOW_NAME,
        input: CRASH_WORKFLOW_TRIGGER_INPUT,
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => messages.length === 2, {
        label: 'reused workflow id crash reported instead of silently dropped',
      });
      const crashMessage = messages[1];
      if (!crashMessage || crashMessage.type !== 'failed') throw new Error('unreachable');
      expect(crashMessage.error).toContain('realm-not-active');

      // The crashed realm's pool slot must be reclaimed too — otherwise this
      // reproduces P-COR-29 criterion 7's pool-at-capacity defect via a
      // different trigger.
      expect(registry.getPool(CRASH_WORKFLOW_NAME, CRASH_REVISION)?.realmCount ?? 0).toBe(0);

      strategy.startWorkflow({
        workflowId: 'wf-reused-after-park-cancel-followup',
        revision: CRASH_REVISION,
        workflowType: CRASH_WORKFLOW_NAME,
        input: 'ordinary-input',
        checkpoint: new ArrayBuffer(0),
      });
      await waitForCondition(() => messages.length === 3, {
        label: 'concurrency-1 revision accepts a fresh start after reclaim',
      });
      expect(messages[2]).toEqual({
        type: 'completed',
        workflowId: 'wf-reused-after-park-cancel-followup',
        result: { ok: true, input: 'ordinary-input' },
      });
    });
  });

  describe('dispatch reclaims a crashed realm (COR-249 mid-turn Worker crash recovery)', () => {
    function newCrashStrategy(): {
      strategy: RevisionRealmExecutionStrategy;
      registry: RevisionRealmRegistry;
      messages: WorkerOutboundMessage[];
    } {
      const registry = new RevisionRealmRegistry();
      const messages: WorkerOutboundMessage[] = [];
      const strategy = new RevisionRealmExecutionStrategy({
        registry,
        resolveRevisionRealmConfig: () => ({
          workerUrl: crashWorkerUrl,
          expectedWorkflowTypes: [CRASH_WORKFLOW_NAME],
          // Concurrency 1: if the crashed realm's pool slot is never
          // reclaimed, the SECOND startWorkflow() below (same still-active
          // revision) has no capacity left and reports `pool-at-capacity`
          // forever — reproducing P-COR-29 criterion 7's empirical failure
          // exactly.
          concurrency: 1,
        }),
        getWorkflowRevisionPin: () => undefined,
      });
      strategy.onMessage((message) => {
        messages.push(message);
      });
      return { strategy, registry, messages };
    }

    it('releases a realm that crashed mid-turn so a still-active, concurrency-1 revision is not permanently at capacity', async () => {
      const { strategy, registry, messages } = newCrashStrategy();

      strategy.startWorkflow({
        workflowId: 'wf-realm-crash',
        revision: CRASH_REVISION,
        workflowType: CRASH_WORKFLOW_NAME,
        input: CRASH_WORKFLOW_TRIGGER_INPUT,
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => messages.length === 1, {
        label: 'crash-settled failure emitted for wf-realm-crash',
      });

      const crashMessage = messages[0];
      if (!crashMessage || crashMessage.type !== 'failed') throw new Error('unreachable');
      // `WorkerRealm#settlePendingTurns`'s own rejection text for a realm
      // forced down while a turn was still pending — distinguishes a
      // genuine crash-settled turn from a graceful workflow-level failure
      // (which would instead carry the handler's own error message and
      // never reach this catch branch at all).
      expect(crashMessage.error).toContain('realm-not-active');

      // The strategy's catch branch releases the realm back to the
      // registry BEFORE emitting the failure above, so observing that
      // failure already proves the release happened — no polling needed.
      expect(registry.getPool(CRASH_WORKFLOW_NAME, CRASH_REVISION)?.realmCount ?? 0).toBe(0);

      // The killer assertion: a second start for the SAME still-active
      // revision, at the same concurrency-1 ceiling, must be able to warm
      // a fresh realm and complete normally — refuting "a concurrency-1
      // revision whose sole realm crashes mid-turn permanently returns
      // pool-at-capacity for every subsequent start."
      strategy.startWorkflow({
        workflowId: 'wf-realm-after-crash',
        revision: CRASH_REVISION,
        workflowType: CRASH_WORKFLOW_NAME,
        input: 'ordinary-input',
        checkpoint: new ArrayBuffer(0),
      });

      await waitForCondition(() => messages.length === 2, {
        label: 'post-crash start completes on a freshly warmed realm',
      });
      expect(messages[1]).toEqual({
        type: 'completed',
        workflowId: 'wf-realm-after-crash',
        result: { ok: true, input: 'ordinary-input' },
      });
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
