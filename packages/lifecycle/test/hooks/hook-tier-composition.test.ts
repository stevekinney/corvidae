import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';
import { mergeHookRegistries } from '../../src/hooks/merge-hook-registries';
import type { HookPlanObservation } from '../../src/hooks/types';

/**
 * The value Bureau pins a registration to when it must hold final narrowing
 * power on a `runLast` or waterfall dispatch — `BUREAU_PINNED_LAST_PRIORITY` in
 * `@corvidae/bureau`'s `runtime-composition.ts`. Restated as a literal here
 * because lifecycle has no runtime dependencies and cannot import it; the
 * bureau-side tests assert the real constant against the real registrations.
 *
 * `Number.MIN_SAFE_INTEGER` plus the largest tier offset the merge can add
 * (`(3 - 1 - 0) * 1000`, Bureau always being the first participant), so adding
 * that offset back cannot leave the safe-integer range.
 */
const PINNED_LAST = Number.MIN_SAFE_INTEGER + 2000;

type TestHooks = {
  transform: (value: string) => string;
  notify: (message: string) => void;
};

/**
 * COR-1265 — the tier-composition contract `mergeHookRegistries` has to hold
 * once Bureau, Agent and direct registries are merged into one per-run plan.
 *
 * These cover the registry mechanics only. The Bureau/Agent wiring that
 * supplies the tiers is tested in operative and bureau.
 */
describe('tier provenance (criterion 17)', () => {
  it('stamps a registry-level source onto every entry it registers', () => {
    const registry = new HookRegistry<TestHooks>({ source: 'bureau' });
    registry.on('transform', (value) => value);

    const [entry] = registry.getHandlers('transform');
    expect(entry?.options.source).toBe('bureau');
  });

  it('lets a per-registration source override the registry default', () => {
    const registry = new HookRegistry<TestHooks>({ source: 'bureau' });
    registry.on('transform', (value) => value, { source: 'bureau:trailing' });

    const [entry] = registry.getHandlers('transform');
    expect(entry?.options.source).toBe('bureau:trailing');
  });

  it('leaves source undefined when no registry or registration supplies one', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('transform', (value) => value);

    const [entry] = registry.getHandlers('transform');
    expect(entry?.options.source).toBeUndefined();
  });

  it('preserves an entry source through two successive merges', () => {
    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('transform', (value) => value + '-bureau');
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('transform', (value) => value + '-agent');

    const once = mergeHookRegistries(bureau, agent);
    const twice = mergeHookRegistries(once);

    const sources = twice.getHandlers('transform').map((entry) => entry.options.source);
    expect(sources).toEqual(['bureau', 'agent']);
  });

  it('reports the source on a registered observation', () => {
    const registry = new HookRegistry<TestHooks>({ source: 'agent' });
    const seen: HookPlanObservation[] = [];
    registry.observe((observation) => seen.push(observation));

    registry.on('transform', (value) => value, { id: 'agent:one' });

    expect(seen).toEqual([
      {
        kind: 'registered',
        hookName: 'transform',
        id: 'agent:one',
        priority: 0,
        replay: 'effectful',
        source: 'agent',
      },
    ]);
  });
});

describe('tier ordering (criteria 5 and 7)', () => {
  it('bands three tiers so the first listed runs first', async () => {
    const order: string[] = [];
    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('notify', (message) => void order.push(`bureau:${message}`));
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('notify', (message) => void order.push(`agent:${message}`));
    const direct = new HookRegistry<TestHooks>({ source: 'direct' });
    direct.on('notify', (message) => void order.push(`direct:${message}`));

    // No run can populate all three tiers today — `AgentRunContext` and
    // `CreateAgentOptions` expose no direct-tier hook surface alongside an
    // agent tier. The ordering property is therefore proven here, against
    // the merge itself, rather than through a dispatch that cannot occur.
    const merged = mergeHookRegistries(bureau, agent, direct);
    await merged.run('notify', 'x');

    expect(order).toEqual(['bureau:x', 'agent:x', 'direct:x']);
  });

  it('offsets by (participants - 1 - index) * 1000, so three tiers give the first +2000', () => {
    const bureau = new HookRegistry<TestHooks>();
    bureau.on('transform', (value) => value, { id: 'b' });
    const agent = new HookRegistry<TestHooks>();
    agent.on('transform', (value) => value, { id: 'a' });
    const direct = new HookRegistry<TestHooks>();
    direct.on('transform', (value) => value, { id: 'd' });

    const three = mergeHookRegistries(bureau, agent, direct);
    expect(three.getHandlers('transform').map((entry) => entry.priority)).toEqual([2000, 1000, 0]);

    const two = mergeHookRegistries(bureau, agent);
    expect(two.getHandlers('transform').map((entry) => entry.priority)).toEqual([1000, 0]);
  });

  it('lets a pinned-last entry outrank every tier offset', async () => {
    const order: string[] = [];

    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('notify', (message) => void order.push(`bureau:${message}`), {
      priority: PINNED_LAST,
    });
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('notify', (message) => void order.push(`agent:${message}`), {
      priority: Number.MAX_SAFE_INTEGER,
    });

    const merged = mergeHookRegistries(bureau, agent);
    await merged.run('notify', 'x');

    expect(order).toEqual(['agent:x', 'bureau:x']);
  });

  it('gives a pinned-last entry the final value on a waterfall (criterion 10)', async () => {
    // The shape that makes criterion 10 about authority rather than ordering:
    // a waterfall hands each handler the previous one's return, so whoever runs
    // LAST decides what the run sees. A guardrail that narrows has to be that
    // handler, no matter what an agent- or direct-tier registration asked for.
    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('transform', (value) => `${value}|narrowed`, { priority: PINNED_LAST });
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('transform', () => 'widened', { priority: Number.MAX_SAFE_INTEGER });

    const merged = mergeHookRegistries(bureau, agent);

    expect(await merged.run('transform', 'response')).toBe('widened|narrowed');
  });

  it('gives a pinned-last entry the winning value on runLast (criterion 10)', async () => {
    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('transform', () => 'bureau', { priority: PINNED_LAST });
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('transform', () => 'agent', { priority: Number.MAX_SAFE_INTEGER });

    const merged = mergeHookRegistries(bureau, agent);

    expect(await merged.runLast('transform', 'response')).toBe('bureau');
  });

  it('lets a bureau-tier entry short-circuit runFirst before any lower tier (criterion 11)', async () => {
    const reached: string[] = [];
    // `runFirst` is the veto shape: the first handler to return a defined value
    // ends the question. Bureau's default-priority entries carry the largest
    // tier offset, so they answer before an agent's or a direct caller's — the
    // band alone does this, with no pinned priority anywhere.
    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('transform', (value) => {
      reached.push('bureau');
      return `${value}|vetoed`;
    });
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('transform', (value) => {
      reached.push('agent');
      return value;
    });
    const direct = new HookRegistry<TestHooks>({ source: 'direct' });
    direct.on('transform', (value) => {
      reached.push('direct');
      return value;
    });

    const merged = mergeHookRegistries(bureau, agent, direct);

    expect(await merged.runFirst('transform', 'step')).toBe('step|vetoed');
    expect(reached).toEqual(['bureau']);
  });
});

describe('error policy through a merge (criterion 12)', () => {
  it("keeps each tier's registry-level onError governing its own entries", async () => {
    const bureauErrors: string[] = [];
    const agentErrors: string[] = [];

    const bureau = new HookRegistry<TestHooks>({
      source: 'bureau',
      onError: (_error, context) => {
        bureauErrors.push(context.id);
        return 'continue';
      },
    });
    bureau.on(
      'notify',
      () => {
        throw new Error('bureau handler failed');
      },
      { id: 'bureau:one' },
    );

    const agent = new HookRegistry<TestHooks>({
      source: 'agent',
      onError: (_error, context) => {
        agentErrors.push(context.id);
        return 'continue';
      },
    });
    agent.on(
      'notify',
      () => {
        throw new Error('agent handler failed');
      },
      { id: 'agent:one' },
    );

    const merged = mergeHookRegistries(bureau, agent);
    await merged.run('notify', 'x');

    expect(bureauErrors).toEqual(['bureau:one']);
    expect(agentErrors).toEqual(['agent:one']);
  });

  it('lets a per-registration onError still win over its tier fallback', async () => {
    const tier: string[] = [];
    const perEntry: string[] = [];

    const registry = new HookRegistry<TestHooks>({
      onError: (_error, context) => {
        tier.push(context.id);
        return 'continue';
      },
    });
    registry.on(
      'notify',
      () => {
        throw new Error('failed');
      },
      {
        id: 'own',
        onError: (_error, context) => {
          perEntry.push(context.id);
          return 'continue';
        },
      },
    );

    const merged = mergeHookRegistries(registry);
    await merged.run('notify', 'x');

    expect(perEntry).toEqual(['own']);
    expect(tier).toEqual([]);
  });

  it('still throws from a merged entry whose tier configured no onError', async () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('notify', () => {
      throw new Error('unhandled');
    });

    const merged = mergeHookRegistries(registry);

    await expect(merged.run('notify', 'x')).rejects.toThrow('unhandled');
  });

  it("measures durations on the merged registry's own clock, not a source's", async () => {
    let sourceClockReads = 0;
    const registry = new HookRegistry<TestHooks>({
      now: () => {
        sourceClockReads += 1;
        return 0;
      },
    });
    registry.on('notify', () => undefined);

    const merged = mergeHookRegistries(registry);
    const durations: number[] = [];
    merged.observe((observation) => {
      if (observation.kind === 'invoked') durations.push(observation.durationMilliseconds);
    });

    const before = sourceClockReads;
    await merged.run('notify', 'x');

    expect(durations).toHaveLength(1);
    expect(sourceClockReads).toBe(before);
  });
});

describe('snapshot isolation (criteria 6, 11 and 13)', () => {
  it('does not see a source registry mutated after the merge', async () => {
    const order: string[] = [];
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('notify', (message) => void order.push(`first:${message}`));

    const merged = mergeHookRegistries(undefined, agent, undefined);
    agent.on('notify', (message) => void order.push(`late:${message}`));

    await merged.run('notify', 'x');

    expect(order).toEqual(['first:x']);
  });

  it('snapshots even when only one tier participates and the merge degenerates to a copy', async () => {
    const order: string[] = [];
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('notify', (message) => void order.push(`first:${message}`));

    const merged = mergeHookRegistries(undefined, agent, undefined);
    agent.clear('notify');

    await merged.run('notify', 'x');

    expect(order).toEqual(['first:x']);
    expect(merged.has('notify')).toBe(true);
  });

  it('gives two merges of one source independent revisions', () => {
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('notify', () => undefined);

    const first = mergeHookRegistries(agent);
    const second = mergeHookRegistries(agent);

    expect(first).not.toBe(second);
    first.on('notify', () => undefined);
    expect(first.revision).not.toBe(second.revision);
  });
});

describe('unclassified-replay diagnostic (COR-1267)', () => {
  it('reports a registration that omitted replay entirely', () => {
    const seen: Array<{ hookName: string; id: string }> = [];
    const registry = new HookRegistry<TestHooks>({
      onUnclassifiedReplay: (registration) => seen.push(registration),
    });

    registry.on('transform', (value) => value, { id: 'no-policy' });

    expect(seen).toEqual([{ hookName: 'transform', id: 'no-policy' }]);
  });

  it('stays silent for a registration that declared effectful deliberately', () => {
    const seen: Array<{ hookName: string; id: string }> = [];
    const registry = new HookRegistry<TestHooks>({
      onUnclassifiedReplay: (registration) => seen.push(registration),
    });

    registry.on('transform', (value) => value, { id: 'deliberate', replay: 'effectful' });

    expect(seen).toEqual([]);
  });

  it('stays silent for a registration that declared safe', () => {
    const seen: Array<{ hookName: string; id: string }> = [];
    const registry = new HookRegistry<TestHooks>({
      onUnclassifiedReplay: (registration) => seen.push(registration),
    });

    registry.on('transform', (value) => value, { id: 'read-only', replay: 'safe' });

    expect(seen).toEqual([]);
  });

  it('reports the generated id when the registration supplied none', () => {
    const seen: Array<{ hookName: string; id: string }> = [];
    const registry = new HookRegistry<TestHooks>({
      onUnclassifiedReplay: (registration) => seen.push(registration),
    });

    registry.on('transform', (value) => value);

    expect(seen).toEqual([{ hookName: 'transform', id: 'transform#1' }]);
  });

  it('never gates execution: the hook still runs, and a throwing diagnostic cannot fail the registration', async () => {
    const registry = new HookRegistry<TestHooks>({
      onUnclassifiedReplay: () => {
        throw new Error('diagnostic exploded');
      },
    });

    expect(() => registry.on('transform', (value) => value + '-ran')).not.toThrow();
    expect(await registry.run('transform', 'x')).toBe('x-ran');
  });

  it('is absent by default, so an unconfigured registry reports nothing', () => {
    const registry = new HookRegistry<TestHooks>();
    expect(() => registry.on('transform', (value) => value)).not.toThrow();
  });

  it('survives a merge: a re-registered entry that still has no policy is reported again', () => {
    const source = new HookRegistry<TestHooks>();
    source.on('transform', (value) => value, { id: 'unclassified' });
    source.on('transform', (value) => value, { id: 'classified', replay: 'safe' });

    const seen: Array<{ hookName: string; id: string }> = [];

    // The merge target is constructed by `mergeHookRegistries` with no
    // options, so it has no diagnostic of its own — the policy belongs to
    // whoever builds a tier, not to the composed plan. Re-registering the
    // same two entries onto a registry that DOES configure one reports
    // exactly the unclassified entry, which is what proves the absence
    // travels with the entry rather than being lost at the merge.
    const reported = new HookRegistry<TestHooks>({
      onUnclassifiedReplay: (registration) => seen.push(registration),
    });
    for (const entry of source.getHandlers('transform')) {
      reported.on('transform', entry.handler, entry.options);
    }

    expect(seen).toEqual([{ hookName: 'transform', id: 'unclassified' }]);
  });
});

describe('redacted effective-plan introspection (COR-1270)', () => {
  it('describes identity, ordering, replay class and tier — and nothing else', () => {
    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('transform', (value) => value, { id: 'bureau:one', replay: 'safe' });
    const agent = new HookRegistry<TestHooks>({ source: 'agent' });
    agent.on('transform', (value) => value, { id: 'agent:one' });

    const plan = mergeHookRegistries(bureau, agent).describePlan();

    expect(plan.entries).toEqual([
      { hookName: 'transform', id: 'bureau:one', priority: 1000, replay: 'safe', source: 'bureau' },
      { hookName: 'transform', id: 'agent:one', priority: 0, replay: 'effectful', source: 'agent' },
    ]);
  });

  it('reports the plan revision alongside the entries', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('transform', (value) => value);
    const before = registry.describePlan();

    registry.on('notify', () => undefined);
    const after = registry.describePlan();

    expect(before.revision).toBe(1);
    expect(after.revision).toBe(2);
    expect(after.entries).toHaveLength(2);
  });

  it('orders entries the way they would run for their hook point', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('transform', (value) => value, { id: 'low', priority: 1 });
    registry.on('transform', (value) => value, { id: 'high', priority: 100 });
    registry.on('transform', (value) => value, { id: 'middle', priority: 50 });

    // Highest priority first — the iteration order every dispatch shape uses.
    // The shapes disagree about which END of that order WINS (`runFirst` takes
    // the first to answer, `runLast` and the waterfall the last), but not
    // about the sequence, so the description can state one order honestly.
    expect(registry.describePlan().entries.map((entry) => entry.id)).toEqual([
      'high',
      'middle',
      'low',
    ]);
  });

  it('omits source entirely when no tier claimed the entry', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('transform', (value) => value, { id: 'untiered' });

    const [entry] = registry.describePlan().entries;
    expect(entry).toEqual({
      hookName: 'transform',
      id: 'untiered',
      priority: 0,
      replay: 'effectful',
    });
    expect(Object.hasOwn(entry!, 'source')).toBe(false);
  });

  it('reaches no handler, closure or secret from anywhere in the returned value', () => {
    const secret = 'sk-live-do-not-leak';
    const registry = new HookRegistry<TestHooks>({
      source: 'bureau',
      onError: () => 'continue',
    });
    const handler = (value: string) => value + secret;
    registry.on('transform', handler, {
      id: 'bureau:secret-bearing',
      replay: 'effectful',
      onError: () => 'abort',
    });

    const plan = registry.describePlan();

    // Structural, not field-name-based: walk everything reachable from the
    // description and assert no function and no secret-bearing string is in
    // there. A field-name allowlist would pass a description that gained a
    // new leaking field under an innocuous name.
    const functions: string[] = [];
    const strings: string[] = [];
    const seen = new Set<unknown>();
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'function') {
        functions.push(path);
        return;
      }
      if (typeof value === 'string') {
        strings.push(value);
        return;
      }
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    };
    walk(plan, 'plan');

    expect(functions).toEqual([]);
    expect(strings.some((value) => value.includes(secret))).toBe(false);
    // The registered handler itself is unreachable, so the `onError` closures
    // and anything either of them closes over are unreachable too.
    expect(registry.getHandlers('transform')[0]?.handler).toBe(handler);
  });

  it('leaves getHandlers as the live internal accessor, unchanged', () => {
    const registry = new HookRegistry<TestHooks>();
    const handler = (value: string) => value;
    registry.on('transform', handler, { id: 'kept' });

    // The two accessors are deliberately not merged: `mergeHookRegistries`
    // needs the live handler, and inspection must never see it.
    expect(registry.getHandlers('transform')[0]?.handler).toBe(handler);
    expect(registry.describePlan().entries[0]).not.toHaveProperty('handler');
  });

  it('describes an empty plan as an empty entry list rather than throwing', () => {
    expect(new HookRegistry<TestHooks>().describePlan()).toEqual({ revision: 0, entries: [] });
  });
});
