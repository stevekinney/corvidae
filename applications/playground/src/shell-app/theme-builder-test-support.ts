/**
 * Test-only wiring for the draft controller: a stand-in evaluator, an in-process channel
 * bus, and a factory for a controller over a memory store.
 */

import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { ThemeBuilderPersistence } from './theme-builder-persistence.svelte.ts';
import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
import type { ChannelLike } from './theme-draft-sync.ts';
import type { MemoryThemeStore } from './theme-draft-test-support.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

/** A stand-in for the runtime: `radius.medium` in the shared (or dark) override is the map. */
export const evaluator: ThemeEvaluator = {
  async evaluate(source, revision, context) {
    const node = (scope: 'shared' | 'dark') =>
      (
        source.overrides[scope]['radius'] as
          { medium?: { $value?: { unit?: string; value?: number } } } | undefined
      )?.medium?.$value;
    const value = context.startsWith('dark') ? (node('dark') ?? node('shared')) : node('shared');
    if (value?.unit === 'furlong') {
      return {
        revision,
        context,
        ok: false,
        diagnostics: [
          { path: 'radius.medium', code: 'invalid-theme', message: 'unit is not valid' },
        ],
      };
    }
    return {
      revision,
      context,
      ok: true,
      properties: [
        {
          name: '--cinder-radius-md',
          value: value === undefined ? '0.5rem' : `${value.value}${value.unit}`,
        },
      ],
    };
  },
};

export function bus(): () => ChannelLike {
  const members = new Set<{ deliver: (data: unknown) => void }>();
  return () => {
    const listeners = new Set<(event: { data: unknown }) => void>();
    const member = {
      deliver: (data: unknown) => listeners.forEach((listener) => listener({ data })),
    };
    members.add(member);
    return {
      postMessage(message) {
        for (const other of members)
          if (other !== member) queueMicrotask(() => other.deliver(message));
      },
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
      close: () => void members.delete(member),
    };
  };
}

let counter = 0;
export function tab(store: MemoryThemeStore, channel: ChannelLike | null = null) {
  const workbench = new ThemeWorkbenchState();
  const persistence = new ThemeBuilderPersistence({
    openStore: async () => store,
    channel,
    tabId: `tab-${(counter += 1)}`,
  });
  const controller = new ThemeBuilderController({
    workbench,
    evaluator,
    persistence,
    newId: () => `theme-${(counter += 1)}`,
    now: () => '2026-10-13T00:00:00.000Z',
  });
  return { workbench, controller, persistence };
}
