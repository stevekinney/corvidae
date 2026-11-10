import { HookRegistry } from './hook-registry';
import type { HookMap, HookTier } from './types';

/**
 * The composition tiers, highest first: the order a merged plan copies them in, and the order of
 * their priority bands (COR-2127).
 */
export const HOOK_TIERS = Object.freeze([
  'bureau',
  'plugin',
  'agent',
  'direct',
] as const satisfies readonly HookTier[]);

/** The distance between two adjacent tiers' bands. */
export const HOOK_TIER_BAND_WIDTH = 1000;

/**
 * The offset `mergeHookRegistries` adds to the priority of an entry it stamps with each tier
 * (COR-2127): `bureau` +3000, `plugin` +2000, `agent` +1000, `direct` +0.
 *
 * Fixed per tier rather than counted from the tiers a run happens to have, so an entry's priority
 * in a plan is the same whether or not another tier is present. A registry sorts descending, so a
 * higher tier runs earlier at an equal declared priority. The largest band, `bureau`'s, is the
 * most a merge adds to any priority.
 */
export const HOOK_TIER_PRIORITY_BANDS: Readonly<Record<HookTier, number>> = Object.freeze({
  bureau: 3 * HOOK_TIER_BAND_WIDTH,
  plugin: 2 * HOOK_TIER_BAND_WIDTH,
  agent: HOOK_TIER_BAND_WIDTH,
  direct: 0,
});

/** The registries one run's plan is composed from, each under the tier it belongs to. */
export type HookTierRegistries<M extends HookMap> = {
  readonly [Tier in HookTier]?: HookRegistry<M> | undefined;
};

/**
 * Throws `TypeError` unless `tiers` is a plain bag of known tier names. A registry passed where the
 * bag belongs (the positional form this function took before COR-2127) or a misspelled tier would
 * otherwise compose a plan that silently lacks that tier's hooks.
 */
function assertTierRegistries(tiers: unknown): void {
  if (typeof tiers !== 'object' || tiers === null || tiers instanceof HookRegistry) {
    throw new TypeError(
      'mergeHookRegistries takes one object naming each tier: { bureau, plugin, agent, direct }.',
    );
  }
  for (const key of Object.keys(tiers)) {
    if (!(HOOK_TIERS as readonly string[]).includes(key)) {
      throw new TypeError(`mergeHookRegistries has no tier "${key}".`);
    }
  }
}

/**
 * Composes one plan from each tier's registry (COR-567, COR-2127). Every entry is copied into a
 * fresh registry, so the plan is a snapshot: a registration added to a tier's registry afterwards
 * does not reach it. An absent tier contributes nothing.
 *
 * An entry with no tier yet is stamped with the tier it was given under, and that tier's band in
 * {@link HOOK_TIER_PRIORITY_BANDS} is added to its priority. An entry that already has one (from an
 * earlier merge, or named by its registration) keeps that tier and its priority, so merging a plan
 * again never moves an entry. Throws `TypeError` for anything but an object of known tier names.
 */
export function mergeHookRegistries<M extends HookMap>(
  tiers: HookTierRegistries<M>,
): HookRegistry<M> {
  assertTierRegistries(tiers);
  const merged = new HookRegistry<M>();

  for (const tier of HOOK_TIERS) {
    const registry = tiers[tier];
    if (registry === undefined) continue;

    for (const hookName of registry.getHookNames()) {
      const handlers = registry.getHandlers(hookName);
      for (const entry of handlers) {
        merged.on(hookName, entry.handler, {
          ...entry.options,
          // The resolved id, not `entry.options.id`: a generated id lives on
          // the entry rather than the caller's options, and dropping it here
          // would mint a fresh one in the merged registry — so an observer
          // correlating by id would see the same registration under two names
          // either side of a merge.
          id: entry.id,
          tier: entry.options.tier ?? tier,
          priority:
            entry.options.tier === undefined
              ? entry.priority + HOOK_TIER_PRIORITY_BANDS[tier]
              : entry.priority,
          // Materialize the SOURCE registry's error fallback onto the entry
          // (COR-1265). `merged` is constructed with no options, so after a
          // merge `dispatch()`'s `entry.options.onError ?? registryOptions.
          // onError` has nothing to fall back to — every tier's registry-level
          // `onError` would silently stop governing its own entries, and a
          // handler that used to be caught would throw uncaught. Each tier
          // keeps its own policy because the fallback is resolved per entry,
          // against the registry the entry actually came from, before the
          // entry leaves it.
          ...(entry.options.onError === undefined && registry.onError !== undefined
            ? { onError: registry.onError }
            : {}),
        });
      }
    }
  }

  return merged;
}
