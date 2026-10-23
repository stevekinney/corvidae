import type { ReadIdStorage } from './notification-read-state.ts';
import { NotificationStore } from './notifications.svelte.ts';

/** A storage that lives and dies with one test, so no read id leaks between tests through the page's own. */
export function memoryStorage(initial: Record<string, string> = {}): ReadIdStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/** A store that keeps its read ids in memory. */
export function memoryStore(): NotificationStore {
  return new NotificationStore({ storage: memoryStorage() });
}
