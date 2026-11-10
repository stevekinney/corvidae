import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';
import {
  HOOK_TIER_PRIORITY_BANDS,
  HOOK_TIERS,
  mergeHookRegistries,
} from '../../src/hooks/merge-hook-registries';

type TestHooks = {
  transform: (value: string) => string;
  notify: (message: string) => void;
};

describe('mergeHookRegistries', () => {
  it('returns an empty registry when no tier is given', async () => {
    const merged = mergeHookRegistries<TestHooks>({});

    expect(merged.has('transform')).toBe(false);

    const result = await merged.run('transform', 'input');
    expect(result).toBeUndefined();
  });

  it('returns an equivalent registry when merging one tier', async () => {
    const original = new HookRegistry<TestHooks>();
    original.on('transform', (value) => value + '-only');

    const merged = mergeHookRegistries({ agent: original });

    const result = await merged.run('transform', 'input');
    expect(result).toBe('input-only');
  });

  it('runs a higher tier first at an equal declared priority', async () => {
    const bureau = new HookRegistry<TestHooks>();
    const agent = new HookRegistry<TestHooks>();
    bureau.on('transform', (value) => value + '-bureau', { priority: 0 });
    agent.on('transform', (value) => value + '-agent', { priority: 0 });

    const merged = mergeHookRegistries({ agent, bureau });

    expect(await merged.run('transform', 'start')).toBe('start-bureau-agent');
  });

  it('interleaves handlers from two tiers by their banded priority', async () => {
    const plugin = new HookRegistry<TestHooks>();
    const agent = new HookRegistry<TestHooks>();
    const order: string[] = [];
    plugin.on('notify', () => void order.push('plugin-low'), { priority: 0 });
    agent.on('notify', () => void order.push('agent-high'), { priority: 1500 });
    plugin.on('notify', () => void order.push('plugin-high'), { priority: 500 });
    agent.on('notify', () => void order.push('agent-low'), { priority: 0 });

    const merged = mergeHookRegistries({ plugin, agent });

    // plugin-high: 500 + 2000 = 2500; agent-high: 1500 + 1000 = 2500 (a tie, and the plugin tier
    // was copied first); plugin-low: 0 + 2000; agent-low: 0 + 1000.
    await merged.run('notify', 'test');
    expect(order).toEqual(['plugin-high', 'agent-high', 'plugin-low', 'agent-low']);
  });
});

/**
 * COR-2127 — each tier's band is fixed, so a plan's priorities do not depend on which other tiers
 * a run happens to have.
 */
describe('fixed tier bands (COR-2127)', () => {
  it('orders the four tiers bureau, plugin, agent, direct, a band apart', () => {
    expect([...HOOK_TIERS]).toEqual(['bureau', 'plugin', 'agent', 'direct']);
    expect(HOOK_TIERS.map((tier) => HOOK_TIER_PRIORITY_BANDS[tier])).toEqual([3000, 2000, 1000, 0]);
  });

  it('gives a tier the same band whichever other tiers are present', () => {
    const tiers = () => {
      const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
      bureau.on('notify', () => {}, { id: 'bureau:one', priority: 5 });
      const plugin = new HookRegistry<TestHooks>();
      plugin.on('notify', () => {}, { id: 'plugin:one', priority: 5 });
      const agent = new HookRegistry<TestHooks>({ source: 'agent' });
      agent.on('notify', () => {}, { id: 'agent:one', priority: 5 });
      return { bureau, plugin, agent };
    };
    const priorities = (registry: HookRegistry<TestHooks>) =>
      Object.fromEntries(
        registry.describePlan().entries.map((entry) => [entry.id, entry.priority] as const),
      );

    const { bureau, plugin, agent } = tiers();
    const withPlugin = priorities(mergeHookRegistries({ bureau, plugin, agent }));
    const withoutPlugin = priorities(mergeHookRegistries({ bureau, agent }));
    const agentAlone = priorities(mergeHookRegistries({ agent }));

    expect(withPlugin).toEqual({ 'bureau:one': 3005, 'plugin:one': 2005, 'agent:one': 1005 });
    expect(withoutPlugin).toEqual({ 'bureau:one': 3005, 'agent:one': 1005 });
    expect(agentAlone).toEqual({ 'agent:one': 1005 });
  });

  it('stamps each entry with the tier it was merged under, beside its source', () => {
    const bureau = new HookRegistry<TestHooks>({ source: 'bureau' });
    bureau.on('notify', () => {}, { id: 'bureau:one' });
    const plugin = new HookRegistry<TestHooks>();
    plugin.on('notify', () => {}, { id: 'audit:one', source: 'audit' });

    const entries = mergeHookRegistries({ bureau, plugin }).describePlan().entries;

    expect(entries.map(({ id, tier, source }) => ({ id, tier, source }))).toEqual([
      { id: 'bureau:one', tier: 'bureau', source: 'bureau' },
      { id: 'audit:one', tier: 'plugin', source: 'audit' },
    ]);
  });

  it('never moves an entry that already has a tier, so merging a plan again is a copy', () => {
    const agent = new HookRegistry<TestHooks>();
    agent.on('notify', () => {}, { id: 'agent:one', priority: 7 });
    const once = mergeHookRegistries({ agent });
    // A registration made on the merged plan, as Operative's agent policy does, has no tier yet.
    once.on('notify', () => {}, { id: 'agent:late', priority: 3 });

    const bureau = new HookRegistry<TestHooks>();
    bureau.on('notify', () => {}, { id: 'bureau:one' });
    const twice = mergeHookRegistries({ bureau, agent: once });

    expect(
      twice.describePlan().entries.map(({ id, tier, priority }) => ({ id, tier, priority })),
    ).toEqual([
      { id: 'bureau:one', tier: 'bureau', priority: 3000 },
      { id: 'agent:one', tier: 'agent', priority: 1007 },
      { id: 'agent:late', tier: 'agent', priority: 1003 },
    ]);
  });

  it('keeps a tier a registration names for itself, even under another tier’s key', () => {
    const agent = new HookRegistry<TestHooks>();
    agent.on('notify', () => {}, { id: 'claimed', tier: 'plugin', priority: 2001 });

    const [entry] = mergeHookRegistries({ agent }).describePlan().entries;

    expect(entry).toMatchObject({ id: 'claimed', tier: 'plugin', priority: 2001 });
  });

  it.each([
    ['a registry passed in the positional form', () => new HookRegistry<TestHooks>()],
    ['a tier name it does not know', () => ({ agents: new HookRegistry<TestHooks>() })],
    ['nothing at all', () => undefined],
  ])('refuses %s, rather than compose a plan without that tier', (_label, tiers) => {
    expect(() => mergeHookRegistries(tiers() as never)).toThrow(TypeError);
  });
});
