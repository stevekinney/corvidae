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
import { createStore, stopWhen, createAgent } from '@lostgradient/operative';
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
import type { AgentDefinitions } from './agent-catalog';

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
    const owner = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: async ({ step }) => {
            if (step === 0)
              return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
            reachedStepOne.resolve();
            return new Promise<never>(() => {});
          },
          toolbox: createToolbox([nextTool]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
      durableBackgroundTasks: 'manual',
      durableOwnership: leaseOptions,
    });
    bureaus.push(owner);
    const run = await owner.createRun({ agentName: 'default', message: 'go' });
    await reachedStepOne.promise;

    // The successor has no `generate`, so it cannot rebuild the run's session and reconciles the
    // session to `error` when the engine reclaims the run. That is a session commit, made by the
    // engine's reclaim while the Bureau is parked in the agent file scan.
    const hold = fixtures.holdAgentFileScan();
    const diagnostics: BureauDiagnostic[] = [];
    const successor = createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          toolbox: createToolbox([nextTool]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      agentDirectory: await fixtures.agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      storage: { type: 'sqlite', path: storagePath },
      durableExecution: true,
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
function captureCompositionListeners(): {
  readonly read: () => CapturedListener[];
  readonly targets: () => TypedEventTarget<never>[];
} {
  const create = runtimeCompositionModule.createRuntimeComposition;
  const readers: Array<() => CapturedListener[]> = [];
  const captured: TypedEventTarget<never>[] = [];
  const spy = spyOn(runtimeCompositionModule, 'createRuntimeComposition').mockImplementation(
    async (...args) => {
      const composition = await create(...args);
      const targets = [
        composition.skillEvents as TypedEventTarget<never>,
        composition.scheduleFireEvents as TypedEventTarget<never>,
        ...(composition.sessionStore === undefined
          ? []
          : [composition.sessionStore.events as TypedEventTarget<never>]),
      ];
      captured.push(...targets);
      readers.push(...targets.map((target) => recordListeners(target)));
      return composition;
    },
  );
  fixtures.restoreOnDispose(() => spy.mockRestore());
  return { read: () => readers.flatMap((read) => read()), targets: () => [...captured] };
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

/** Whether `value`, or anything down its `cause` chain, is a `ReferenceError` read before init. */
function readsBeforeInitialization(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof ReferenceError && value.message.includes('before initialization')) {
    return true;
  }
  const { cause, errors } = value as { cause?: unknown; errors?: unknown };
  return (
    readsBeforeInitialization(cause, seen) ||
    (Array.isArray(errors) && errors.some((entry) => readsBeforeInitialization(entry, seen)))
  );
}

/** Whether a diagnostic reports a read before initialization, in its message or down its causes. */
function reportsReadBeforeInitialization(diagnostic: BureauDiagnostic): boolean {
  return (
    diagnostic.message.includes('before initialization') ||
    readsBeforeInitialization(diagnostic.cause)
  );
}

describe('the construction-window guard', () => {
  it('finds a read before initialization however deep in a diagnostic’s cause chain it is', () => {
    const reference = new ReferenceError("Cannot access 'later' before initialization");
    const wrapped = new Error('probe wrapper', { cause: reference });
    const diagnostic = (cause: unknown): BureauDiagnostic => ({
      level: 'error',
      scope: 'durable-maintenance',
      message: '[bureau] a listener failed',
      cause,
    });

    expect(reportsReadBeforeInitialization(diagnostic(reference))).toBe(true);
    expect(reportsReadBeforeInitialization(diagnostic(wrapped))).toBe(true);
    expect(
      reportsReadBeforeInitialization(
        diagnostic(new AggregateError([new TypeError('other'), wrapped])),
      ),
    ).toBe(true);
    expect(reportsReadBeforeInitialization(diagnostic(new Error('unrelated', { cause: 1 })))).toBe(
      false,
    );
    expect(reportsReadBeforeInitialization(diagnostic(undefined))).toBe(false);
  });

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
    const captured = captureCompositionListeners();
    const readCaptured = captured.read;
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
    const building = createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          toolbox: createToolbox([nextTool]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      agentDirectory: await fixtures.agentDirectoryWithOneFile(),
      resolveAgentGenerate,
      persistence,
      auditRetention: { olderThan: 86_400_000 },
      store,
      runtime,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    // During the agent file scan: every listener registered so far, fired.
    await scan.entered;
    // A listener of a type on no list, registered on a captured target: the guard must fire it, or
    // a filter on the types it captures would pass unnoticed.
    const unlistedFired: string[] = [];
    const [skillTarget] = captured.targets();
    if (skillTarget === undefined) throw new Error('Expected a captured composition target.');
    (skillTarget as unknown as EventTarget).addEventListener('guard.unlisted-type', () => {
      unlistedFired.push('guard.unlisted-type');
    });
    fireAll();
    // Released before the assertion, so a red run does not leave this Bureau held.
    scan.release();
    expect(unlistedFired).toEqual(['guard.unlisted-type']);

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
    expect(diagnostics.filter(reportsReadBeforeInitialization)).toEqual([]);
  });
});
