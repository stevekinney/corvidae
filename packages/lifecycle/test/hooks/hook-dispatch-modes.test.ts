import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';
import type { HookPlanObservation } from '../../src/hooks/types';

/**
 * A hook whose return type is NOT its first parameter type — the shape that
 * `run()`'s waterfall cannot express. `prepareStep`, `selectTools`,
 * `selectToolChoice` and `beforeCompaction` in `@corvidae/operative` are all
 * this shape: they take a step context and return something else entirely.
 */
type ContextHooks = {
  prepare: (context: { step: number }) => { text: string } | undefined;
  select: (context: { step: number }) => string | undefined;
};

describe('dispatch modes for hooks whose return type is not their first argument', () => {
  it('runFirst hands every handler the caller arguments, not the previous return', async () => {
    const registry = new HookRegistry<ContextHooks>();
    const seen: unknown[] = [];

    registry.on('prepare', (context) => {
      seen.push(context);
      return undefined;
    });
    registry.on('prepare', (context) => {
      seen.push(context);
      return { text: 'answered' };
    });

    const result = await registry.runFirst('prepare', { step: 7 });

    expect(result).toEqual({ text: 'answered' });
    // The regression this pins: under `run()`'s waterfall the second handler
    // would receive `undefined`-or-the-first-return in place of its context.
    expect(seen).toEqual([{ step: 7 }, { step: 7 }]);
  });

  it('runFirst stops at the first defined result', async () => {
    const registry = new HookRegistry<ContextHooks>();
    const called: string[] = [];

    registry.on('prepare', () => {
      called.push('first');
      return { text: 'short-circuit' };
    });
    registry.on('prepare', () => {
      called.push('second');
      return { text: 'never reached' };
    });

    expect(await registry.runFirst('prepare', { step: 0 })).toEqual({ text: 'short-circuit' });
    expect(called).toEqual(['first']);
  });

  it('runLast runs every handler against the caller arguments and the last answer wins', async () => {
    const registry = new HookRegistry<ContextHooks>();
    const seen: unknown[] = [];

    registry.on('select', (context) => {
      seen.push(context);
      return 'first';
    });
    registry.on('select', (context) => {
      seen.push(context);
      return 'second';
    });

    expect(await registry.runLast('select', { step: 3 })).toBe('second');
    expect(seen).toEqual([{ step: 3 }, { step: 3 }]);
  });

  it('runLast keeps an earlier answer when a later handler declines', async () => {
    const registry = new HookRegistry<ContextHooks>();

    registry.on('select', () => 'chosen');
    registry.on('select', () => undefined);

    expect(await registry.runLast('select', { step: 1 })).toBe('chosen');
  });

  it('run still waterfalls for a hook whose return type IS its first argument', async () => {
    const registry = new HookRegistry<{ transform: (value: string) => string }>();

    registry.on('transform', (value) => `${value}-a`);
    registry.on('transform', (value) => `${value}-b`);

    expect(await registry.run('transform', 'seed')).toBe('seed-a-b');
  });

  it('applies the error policy in runFirst and runLast, not only in run', async () => {
    const seen: string[] = [];
    const registry = new HookRegistry<ContextHooks>({
      onError: (_error, context) => {
        seen.push(context.id);
        return 'continue';
      },
    });

    registry.on(
      'prepare',
      () => {
        throw new Error('boom');
      },
      { id: 'thrower' },
    );
    registry.on('prepare', () => ({ text: 'recovered' }), { id: 'survivor' });

    expect(await registry.runFirst('prepare', { step: 0 })).toEqual({ text: 'recovered' });
    expect(seen).toEqual(['thrower']);
  });
});

describe('plan observation (COR-766)', () => {
  it('reports registration, invocation and removal with stable ids', async () => {
    const observed: HookPlanObservation[] = [];
    let clock = 100;
    const registry = new HookRegistry<ContextHooks>({ now: () => clock });
    registry.observe((observation) => observed.push(observation));

    const dispose = registry.on('prepare', () => undefined, { id: 'catalog', priority: 5 });
    clock = 100;
    await registry.runFirst('prepare', { step: 0 });
    dispose();

    // COR-1269 — `revision` rides on every variant. It advances on membership
    // changes only, so the invocation between the registration and the removal
    // reports the same 1 the registration did.
    expect(observed).toEqual([
      {
        kind: 'registered',
        hookName: 'prepare',
        id: 'catalog',
        priority: 5,
        replay: 'effectful',
        revision: 1,
      },
      {
        kind: 'invoked',
        hookName: 'prepare',
        id: 'catalog',
        durationMilliseconds: 0,
        revision: 1,
      },
      { kind: 'removed', hookName: 'prepare', id: 'catalog', revision: 2 },
    ]);
  });

  it('reports a throwing handler as failed exactly once, never also as invoked', async () => {
    const observed: HookPlanObservation[] = [];
    const failure = new Error('handler exploded');
    const registry = new HookRegistry<ContextHooks>({
      now: () => 0,
      onError: () => 'continue',
    });
    registry.observe((observation) => observed.push(observation));

    registry.on(
      'prepare',
      () => {
        throw failure;
      },
      { id: 'thrower' },
    );
    await registry.runFirst('prepare', { step: 0 });

    const outcomes = observed.filter((entry) => entry.kind !== 'registered');
    expect(outcomes).toEqual([
      {
        kind: 'failed',
        hookName: 'prepare',
        id: 'thrower',
        durationMilliseconds: 0,
        error: failure,
        revision: 1,
      },
    ]);
  });

  it('observes a hand-iterated handler invoked through runHandler', async () => {
    const observed: HookPlanObservation[] = [];
    const registry = new HookRegistry<ContextHooks>({ now: () => 0 });
    registry.on('select', () => 'value', { id: 'manual' });
    registry.observe((observation) => observed.push(observation));

    const entry = registry.getHandlers('select')[0]!;
    expect(await registry.runHandler('select', entry, [{ step: 2 }])).toBe('value');

    expect(observed).toEqual([
      { kind: 'invoked', hookName: 'select', id: 'manual', durationMilliseconds: 0, revision: 1 },
    ]);
  });

  it('does not replay registrations that predate the observer', () => {
    const observed: HookPlanObservation[] = [];
    const registry = new HookRegistry<ContextHooks>();
    registry.on('select', () => 'early', { id: 'early' });
    registry.observe((observation) => observed.push(observation));
    registry.on('select', () => 'late', { id: 'late' });

    expect(observed.map((entry) => entry.id)).toEqual(['late']);
  });

  it('reports every entry individually when a hook name is cleared', () => {
    const observed: HookPlanObservation[] = [];
    const registry = new HookRegistry<ContextHooks>();
    registry.on('select', () => undefined, { id: 'one' });
    registry.on('select', () => undefined, { id: 'two' });
    registry.observe((observation) => observed.push(observation));

    registry.clear('select');

    // Both report the revision AFTER the clear: `clear()` is one membership
    // change, not one per departing entry, so the two removals it announces
    // share a revision rather than counting up.
    expect(observed).toEqual([
      { kind: 'removed', hookName: 'select', id: 'one', revision: 3 },
      { kind: 'removed', hookName: 'select', id: 'two', revision: 3 },
    ]);
  });

  it('keeps a throwing observer from failing the invocation it observed', async () => {
    const survivors: HookPlanObservation[] = [];
    const registry = new HookRegistry<ContextHooks>({
      now: () => 0,
      // Present so the throwing observer is reported here rather than
      // re-thrown from a microtask, which a test cannot catch.
      onError: () => 'continue',
    });
    registry.observe(() => {
      throw new Error('observer exploded');
    });
    registry.observe((observation) => survivors.push(observation));

    registry.on('select', () => 'value', { id: 'watched' });
    expect(await registry.runLast('select', { step: 0 })).toBe('value');
    expect(survivors.map((entry) => entry.kind)).toEqual(['registered', 'invoked']);
  });
});
