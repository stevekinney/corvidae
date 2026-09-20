import { HookRegistry } from './hook-registry';
import type { HookMap } from './types';

export function mergeHookRegistries<M extends HookMap>(
  ...registries: (HookRegistry<M> | undefined)[]
): HookRegistry<M> {
  const filtered = registries.filter(
    (registry): registry is HookRegistry<M> => registry !== undefined,
  );

  const merged = new HookRegistry<M>();

  for (let registryIndex = 0; registryIndex < filtered.length; registryIndex++) {
    const registry = filtered[registryIndex]!;
    const priorityOffset = (filtered.length - 1 - registryIndex) * 1000;

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
          priority: entry.priority + priorityOffset,
        });
      }
    }
  }

  return merged;
}
