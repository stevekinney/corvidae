/**
 * COR-1585 — nothing `createBureau` registers may read state that is still uninitialised.
 *
 * `createBureau` awaits at the top level a few times while it builds the Bureau: the agent file
 * scan (`await fileAgents?.files.refresh()`) and the audit sequence seed (inside `if (runtime.kv)`)
 * are the two that run in practice. A listener or timer registered before one of them can fire
 * during it, while every `let` and `const` declared after it is still in its temporal dead zone.
 * These tests hold each of those two awaits open and fire what was registered before it.
 */
import { join } from 'node:path';

import { createManualRuntimeServices, TypedEventTarget } from '@lostgradient/lifecycle';
import { createStore, stopWhen } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, type ConditionalTextValueStore } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import * as runtimeCompositionModule from './runtime-composition';
import {
  createConstructionWindowFixtures,
  resolveAgentGenerate,
} from './testing/construction-window.test-support';
import { pollUntil } from './testing/goal-fixtures.test-support';
import type { Bureau, BureauDiagnostic } from './types';

const bureaus: Bureau[] = [];
const fixtures = createConstructionWindowFixtures();

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.shutdown();
  await fixtures.dispose();
});

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

describe('a session commit while the agent files are being scanned (COR-1585)', () => {
  it('records no diagnostic, and its outbox entry is drained by the time the Bureau is built', async () => {
    const root = await fixtures.scratchDirectory('bureau-construction-commit-');
    const storagePath = join(root, 'bureau.sqlite');
    const leaseOptions = {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: 200,
      workflowClaimRenewIntervalMs: 50,
    } as const;

    // The owner reaches step 1 and then stops: its claim is never renewed, so it lapses, and its
    // session is left `running`.
    const reachedStepOne = Promise.withResolvers<void>();
    const owner = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        if (step === 0) return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        reachedStepOne.resolve();
        return new Promise<never>(() => {});
      },
      toolbox: createToolbox([nextTool]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableBackgroundTasks: 'manual',
      durableOwnership: leaseOptions,
    });
    bureaus.push(owner);
    const run = await owner.createRun({ message: 'go' });
    await reachedStepOne.promise;

    // The successor has no `generate`, so it cannot rebuild the run's session and reconciles the
    // session to `error` when the engine reclaims the run. That is a session commit, made by the
    // engine's reclaim while the Bureau is parked in the agent file scan.
    const hold = fixtures.holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const successor = createBureau({
      agents: {},
      agentDirectory: await fixtures.agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      toolbox: createToolbox([nextTool]),
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      durableOwnership: leaseOptions,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await hold.entered;
    const committed = await pollUntil(async () => {
      const session = await owner.getSession(run.sessionId);
      return session?.metadata['lastRunStatus'] === 'error';
    });
    expect(committed).toBe(true);
    const outbox = await owner.kv?.list('agent-session-outbox:v1:entry:');
    expect(outbox?.length).toBeGreaterThan(0);

    hold.release();
    bureaus.push(await successor);

    expect(diagnostics.filter((entry) => entry.scope === 'durable-maintenance')).toEqual([]);
    expect(diagnostics.map((entry) => entry.message).join('\n')).not.toContain(
      'before initialization',
    );
    expect(await owner.kv?.list('agent-session-outbox:v1:entry:')).toEqual([]);
  });
});

/** A listener registered on one of the composition's event targets, with the type it listens to. */
interface CapturedListener {
  readonly type: string;
  readonly listener: (event: Event) => void;
}

/**
 * What a listener registered on `target` has been, in registration order. `spyOn` on the instance
 * records every call and still runs the real method, so the target behaves as it always did.
 */
function recordListeners(target: TypedEventTarget<never>): () => CapturedListener[] {
  const spy = spyOn(target, 'addEventListener');
  fixtures.restoreOnDispose(() => spy.mockRestore());
  return () =>
    spy.mock.calls.flatMap(([type, listener]) =>
      typeof listener === 'function' ? [{ type, listener }] : [],
    );
}

/**
 * Every listener `createBureau` registers on the composition's event targets: `skillEvents`,
 * `scheduleFireEvents`, and `sessionStore.events`. The three instances are taken from the
 * composition `createBureau` builds, by wrapping the `createRuntimeComposition` export; every
 * listener the guard needs is registered after it returns, so none is missed. It is not filtered
 * by type, so a listener of a type nobody has thought of is fired too.
 *
 * Out of scope, because they are not event targets: the `catalogRunSettlements` subscriptions and
 * `store.toObservable()`.
 */
function captureCompositionListeners(): () => CapturedListener[] {
  const create = runtimeCompositionModule.createRuntimeComposition;
  const readers: Array<() => CapturedListener[]> = [];
  const spy = spyOn(runtimeCompositionModule, 'createRuntimeComposition').mockImplementation(
    async (...args) => {
      const composition = await create(...args);
      readers.push(
        recordListeners(composition.skillEvents as TypedEventTarget<never>),
        recordListeners(composition.scheduleFireEvents as TypedEventTarget<never>),
        ...(composition.sessionStore === undefined
          ? []
          : [recordListeners(composition.sessionStore.events as TypedEventTarget<never>)]),
      );
      return composition;
    },
  );
  fixtures.restoreOnDispose(() => spy.mockRestore());
  return () => readers.flatMap((read) => read());
}

/** The fields the forwarding listeners read, on an event of the given type. */
function eventOf(type: string): Event {
  return Object.assign(new Event(type), {
    scheduleId: 'schedule-1',
    runId: 'run-1',
    occurrence: 1,
    policy: 'skip',
    blockingRunId: 'run-2',
    skillName: 'skill-1',
    correlation: undefined,
    reason: 'because',
    rule: 'rule-1',
    ordinal: 0,
  });
}

/**
 * Fire every captured listener and collect what a Bureau still under construction must never
 * produce: a `ReferenceError` saying a binding is read before it is initialised. Any other throw is
 * a listener objecting to an event whose fields are made up, which is not what this guards.
 */
function fireCaptured(captured: readonly CapturedListener[], failures: string[]): void {
  for (const { type, listener } of captured) {
    try {
      listener(eventOf(type));
    } catch (error) {
      if (error instanceof ReferenceError && error.message.includes('before initialization')) {
        failures.push(`${type}: ${error.message}`);
      }
    }
  }
}

describe('the construction-window guard', () => {
  it('fires a listener of a type that is not on any list, and reports a read before initialization', () => {
    const target = new TypedEventTarget<never>();
    const read = recordListeners(target);
    (target as unknown as EventTarget).addEventListener('never-listed.event', () => {
      throw new ReferenceError("Cannot access 'later' before initialization");
    });
    (target as unknown as EventTarget).addEventListener('never-listed.other', () => {
      throw new TypeError('an unrelated failure');
    });

    const failures: string[] = [];
    fireCaptured(read(), failures);

    expect(failures).toEqual(["never-listed.event: Cannot access 'later' before initialization"]);
  });
});

describe('every listener and timer registered before a top-level await (COR-1585)', () => {
  it('can fire during the agent file scan and the audit sequence seed without reading uninitialised state', async () => {
    const readCaptured = captureCompositionListeners();
    const failures: string[] = [];
    const fireAll = (): void => fireCaptured(readCaptured(), failures);

    // The agent file scan: held until released.
    const scan = fixtures.holdAgentFileScan();
    // The audit sequence seed lists `audit:v1:` before anything else reads it: held until released.
    const seedEntered = Promise.withResolvers<void>();
    const seedReleased = Promise.withResolvers<void>();
    const base = textValueStore(new MemoryStorage());
    const persistence: ConditionalTextValueStore = {
      ...base,
      list: async (prefix) => {
        if (prefix === 'audit:v1:') {
          seedEntered.resolve();
          await seedReleased.promise;
        }
        return base.list(prefix);
      },
    };
    const runtime = createManualRuntimeServices({ origin: '2026-10-19T00:00:00.000Z' });
    const store = createStore({ runtime });
    const diagnostics: BureauDiagnostic[] = [];
    const building = createBureau({
      agents: {},
      agentDirectory: await fixtures.agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      toolbox: createToolbox([nextTool]),
      persistence,
      auditRetention: { olderThan: 86_400_000 },
      store,
      runtime,
      stopWhen: stopWhen.noToolCalls(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    // During the agent file scan: every listener registered so far, fired.
    await scan.entered;
    fireAll();
    scan.release();

    // During the audit sequence seed: the same listeners again, a store event for the store's
    // subscriber, and the maintenance timer, advanced past its interval.
    await seedEntered.promise;
    fireAll();
    store.recordAction('run-1', 'step.completed', {});
    // The 5-minute maintenance interval is armed by now; advancing past it fires it.
    expect(runtime.pendingTimers().length).toBeGreaterThan(0);
    await runtime.advance(300_000);
    seedReleased.resolve();
    bureaus.push(await building);
    await runtime.deferred.drain();

    // And once construction is over.
    fireAll();
    await runtime.deferred.drain();

    // Skill events, schedule events, and the session outbox: three targets, at least ten listeners.
    expect(new Set(readCaptured().map((entry) => entry.type)).size).toBeGreaterThanOrEqual(10);
    expect(failures).toEqual([]);
    expect(
      diagnostics.filter((entry) =>
        `${entry.message} ${entry.cause instanceof Error ? entry.cause.message : ''}`.includes(
          'before initialization',
        ),
      ),
    ).toEqual([]);
  });
});
