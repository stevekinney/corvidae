/**
 * Test-only support for the theme draft suites: a small embedded base and an in-memory
 * `ThemeStore` double with real transaction semantics (serialized, atomic, structured-clone
 * values) and failure injection. No IndexedDB dependency is added to the workspace.
 */

import type { StoreName, StoreTransaction, ThemeStore } from './theme-draft-store.ts';
import type { JsonObject, ThemeBase, ThemeDraft } from './theme-draft-types.ts';
import { editableState } from './theme-draft-types.ts';
import { createDraft } from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';
import { createHistory } from './theme-history.ts';
import type { ThemeEntry } from './theme-library.ts';

export function testBase(): ThemeBase {
  const documents: Record<string, JsonObject> = {
    'base.tokens.json': {
      $schema: 'https://www.designtokens.org/schemas/2025.10/format.json',
      palette: {
        $type: 'color',
        ink: { $value: { colorSpace: 'srgb', components: [0, 0, 0] } },
        accent: { $value: '{palette.ink}', $description: 'Accent follows ink.' },
      },
      space: { $type: 'dimension', md: { $value: { value: 1, unit: 'rem' } } },
    },
  };
  return {
    packageVersion: '0.27.0',
    sourceDigest: 'sha256:fixture',
    resolver: {
      version: '2025.10',
      sets: { foundation: { sources: [{ $ref: 'base.tokens.json' }] } },
    },
    documents,
  };
}

/** Authored source nodes carrying every kind of metadata a round-trip must keep. */
export const richNode: JsonObject = {
  $type: 'color',
  $value: '{palette.ink}',
  $description: 'Alias to ink',
  $deprecated: 'Use palette.accent',
  $extends: '{palette.accent}',
  $root: { $value: '{palette.ink}' },
  $extensions: {
    'com.lostgradient.cinder': { cssProperty: '--cinder-accent', recipe: { input: [1, 2, 3] } },
    'com.example.unknown': { keep: true, nested: { n: [null, 'x'] } },
  },
};

export function testEntry(id = 'theme-1', name = 'My theme'): ThemeEntry {
  const envelope = createEnvelope(id, name, testBase());
  return {
    draft: createDraft(envelope),
    history: createHistory(editableState(envelope)),
    trashed: null,
  };
}

export function savedDraft(draft: ThemeDraft): ThemeDraft {
  return { ...draft, savedRevision: draft.revision, unsavedInput: false };
}

export type MemoryThemeStore = ThemeStore & {
  data: Record<StoreName, Map<string, unknown>>;
  /** The next `transact` call rejects with this error (once). */
  failNext: Error | null;
  /** Every `transact` call rejects with this error. */
  failAlways: Error | null;
  /** Writes inside readwrite transactions reject with this error. */
  failWrites: Error | null;
  /** Seed a raw value, bypassing the module under test. */
  seed(store: StoreName, key: string, value: unknown): void;
};

export function memoryThemeStore(): MemoryThemeStore {
  const data: Record<StoreName, Map<string, unknown>> = { themes: new Map(), meta: new Map() };
  let queue: Promise<unknown> = Promise.resolve();
  const store: MemoryThemeStore = {
    data,
    failNext: null,
    failAlways: null,
    failWrites: null,
    seed: (name, key, value) => {
      data[name].set(key, structuredClone(value));
    },
    transact(mode, run) {
      const result = queue.then(async () => {
        const injected = store.failNext ?? store.failAlways;
        store.failNext = null;
        if (injected !== null) throw injected;
        const staged: Record<StoreName, Map<string, unknown>> = {
          themes: new Map(data.themes),
          meta: new Map(data.meta),
        };
        const tx: StoreTransaction = {
          get: async (name, key) => structuredClone(staged[name].get(key)),
          getAll: async (name) => [...staged[name].values()].map((value) => structuredClone(value)),
          put: async (name, key, value) => {
            if (mode === 'readonly') throw new Error('read-only transaction');
            if (store.failWrites !== null) throw store.failWrites;
            staged[name].set(key, structuredClone(value));
          },
          delete: async (name, key) => {
            if (mode === 'readonly') throw new Error('read-only transaction');
            staged[name].delete(key);
          },
        };
        const value = await run(tx);
        data.themes = staged.themes;
        data.meta = staged.meta;
        return value;
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
  return store;
}

export function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** Resolve a save result to whether it succeeded. */
export async function succeeds(result: Promise<{ ok: boolean }>): Promise<boolean> {
  const settled = await result;
  return settled.ok;
}
