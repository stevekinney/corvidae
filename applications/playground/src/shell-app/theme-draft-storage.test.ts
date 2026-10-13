import { describe, expect, it } from 'bun:test';

import { THEME_DATA_LIMITS } from './theme-draft-limits.ts';
import { THEME_RECORD_VERSION } from './theme-draft-record.ts';
import { ThemeDraftStorage, type SaveResult } from './theme-draft-storage.ts';
import {
  domError,
  memoryThemeStore,
  richNode,
  savedDraft,
  succeeds,
  testEntry,
} from './theme-draft-test-support.ts';
import { editableState } from './theme-draft-types.ts';
import { applyEdit, markSaved, setInput } from './theme-draft.ts';
import { commitTransaction } from './theme-history.ts';
import { deleteTheme, restoreTheme, type ThemeEntry, type ThemeLibrary } from './theme-library.ts';

const NOW = () => '2026-10-13T12:00:00.000Z';

function edited(entry: ThemeEntry, scope: 'light' | 'dark' = 'light'): ThemeEntry {
  const result = applyEdit(entry.draft, {
    kind: 'set-override',
    scope,
    path: 'palette.accent',
    node: richNode,
  });
  if (!result.ok) throw new Error('edit refused');
  return {
    ...entry,
    draft: result.draft,
    history: commitTransaction(
      entry.history,
      'edit',
      'Edit accent',
      editableState(result.draft.envelope),
    ),
  };
}

function setup() {
  const store = memoryThemeStore();
  return { store, storage: new ThemeDraftStorage(store, NOW) };
}

function succeeded(result: SaveResult, entry: ThemeEntry): ThemeEntry {
  expect(result.ok).toBe(true);
  return {
    ...entry,
    draft: { ...entry.draft, savedRevision: entry.draft.revision, unsavedInput: false },
  };
}

describe('save and reload round-trip', () => {
  it('restores the exact draft, history and authored metadata', async () => {
    const { storage } = setup();
    let entry = edited(testEntry('a'));
    entry = {
      ...entry,
      draft: setInput(entry.draft, 'palette.ink@light/default', {
        text: '#12',
        error: 'Incomplete',
      }),
    };
    const saved = succeeded(await storage.save(entry), entry);
    await storage.setActive('a');
    const loaded = await storage.load();
    if (!loaded.ok) throw new Error('load failed');
    const reloaded = loaded.library.entries['a']!;
    expect(reloaded.draft.envelope).toEqual(entry.draft.envelope);
    expect(reloaded.draft.envelope.overrides.light).toEqual({ palette: { accent: richNode } });
    expect(reloaded.draft.revision).toBe(entry.draft.revision);
    expect(reloaded.draft.savedRevision).toBe(entry.draft.revision);
    expect(reloaded.draft.inputBuffer).toEqual(entry.draft.inputBuffer);
    expect({ ...reloaded.history, gesture: null }).toEqual({ ...saved.history, gesture: null });
    expect(loaded.library.activeId).toBe('a');
    expect(loaded.problems).toEqual([]);
  });

  it('loads an empty library from a fresh database', async () => {
    const { storage } = setup();
    const loaded = await storage.load();
    expect(loaded.ok && loaded.library).toEqual({ entries: {}, activeId: null });
  });
});

describe('compare-and-set', () => {
  it('writes when the persisted revision equals savedRevision', async () => {
    const { storage } = setup();
    const first = succeeded(await storage.save(edited(testEntry('a'))), edited(testEntry('a')));
    const next = edited(first, 'dark');
    expect(await succeeds(storage.save(next))).toBe(true);
  });

  it('refuses a stale writer and never overwrites the stored data', async () => {
    const { storage, store } = setup();
    const base = succeeded(await storage.save(testEntry('a')), testEntry('a'));
    const tabA = edited(base, 'light');
    const tabB = edited(base, 'dark');
    expect(await succeeds(storage.save(tabA))).toBe(true);
    const stored = structuredClone(store.data.themes.get('a'));
    const result = await storage.save(tabB);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('conflict');
      expect(result.failure.storedRevision).toBe(tabA.draft.revision);
      expect(result.failure.actions).toContain('reload-stored');
      expect(result.failure.actions).toContain('save-as-copy');
    }
    expect(store.data.themes.get('a')).toEqual(stored);
  });

  it('treats a first save over an existing record as a conflict', async () => {
    const { storage } = setup();
    await storage.save(testEntry('a'));
    const result = await storage.save(testEntry('a'));
    expect(!result.ok && result.failure.kind).toBe('conflict');
  });

  it('treats a save of a theme that was permanently deleted elsewhere as a conflict', async () => {
    const { storage, store } = setup();
    const entry = succeeded(await storage.save(testEntry('a')), testEntry('a'));
    store.data.themes.delete('a');
    const result = await storage.save(edited(entry));
    expect(!result.ok && result.failure).toMatchObject({ kind: 'conflict', storedRevision: null });
  });

  it('serializes concurrent writers so exactly one wins', async () => {
    const { storage } = setup();
    const base = succeeded(await storage.save(testEntry('a')), testEntry('a'));
    const results = await Promise.all([
      storage.save(edited(base, 'light')),
      storage.save(edited(base, 'dark')),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });
});

describe('Trash and tombstones', () => {
  it('writes the tombstone in the same transaction as the revision bump, and restores', async () => {
    const { storage } = setup();
    const entry = succeeded(await storage.save(testEntry('a')), testEntry('a'));
    const library: ThemeLibrary = { entries: { a: entry }, activeId: 'a' };
    const deleted = deleteTheme(library, 'a', NOW());
    if (!deleted.ok) throw new Error('delete refused');
    const trashed = deleted.library.entries['a']!;
    expect(await succeeds(storage.save(trashed))).toBe(true);
    const loaded = await storage.load();
    if (!loaded.ok) throw new Error('load failed');
    expect(loaded.library.entries['a']?.trashed).toEqual({ deletedAt: NOW(), version: 2 });
    expect(loaded.library.activeId).toBeNull();

    const savedTrash = succeeded({ ok: true, revision: 2 }, trashed);
    const restored = restoreTheme({ entries: { a: savedTrash }, activeId: null }, 'a');
    if (!restored.ok) throw new Error('restore refused');
    expect(await succeeds(storage.save(restored.library.entries['a']!))).toBe(true);
    const after = await storage.load();
    expect(after.ok && after.library.entries['a']?.trashed).toBeNull();
  });

  it('removes a record permanently only from Trash and only at the expected revision', async () => {
    const { storage, store } = setup();
    const entry = succeeded(await storage.save(testEntry('a')), testEntry('a'));
    const live = await storage.removePermanently('a', entry.draft.revision);
    expect(!live.ok && live.failure.kind).toBe('conflict');
    expect(store.data.themes.has('a')).toBe(true);

    const deleted = deleteTheme({ entries: { a: entry }, activeId: 'a' }, 'a', NOW());
    if (!deleted.ok) throw new Error('delete refused');
    const trashed = deleted.library.entries['a']!;
    await storage.save(trashed);
    const stale = await storage.removePermanently('a', 1);
    expect(stale.ok).toBe(false);
    expect(await succeeds(storage.removePermanently('a', trashed.draft.revision))).toBe(true);
    expect(store.data.themes.has('a')).toBe(false);
  });
});

describe('caps', () => {
  it('admits the 50th theme and refuses the 51st, counting Trash', async () => {
    const { storage } = setup();
    for (let i = 0; i < THEME_DATA_LIMITS.themes; i += 1) {
      expect(await succeeds(storage.save(testEntry(`t${i}`, `Theme ${i}`)))).toBe(true);
    }
    const result = await storage.save(testEntry('extra', 'Extra'));
    expect(!result.ok && result.failure.kind).toBe('theme-limit');
    expect(!result.ok && result.failure.actions).toEqual(['download', 'manage-storage']);
    const loaded = await storage.load();
    expect(loaded.ok && Object.keys(loaded.library.entries)).toHaveLength(50);
  });

  it('refuses a write that would pass 50 MiB and admits one that lands exactly on it', async () => {
    const { storage, store } = setup();
    const entry = testEntry('a');
    const probe = await storage.save(entry);
    expect(probe.ok).toBe(true);
    const size = new TextEncoder().encode(JSON.stringify(store.data.themes.get('a'))).length;
    // Seed a neighbour so the library total is exactly the cap with the next write.
    const room = THEME_DATA_LIMITS.storageBytes - size;
    const filler = (bytes: number) => ({ pad: 'x'.repeat(bytes - '{"pad":""}'.length) });
    store.seed('themes', 'filler', filler(room));
    const same = succeeded(probe, entry);
    expect(await succeeds(storage.save(same))).toBe(true); // total == cap exactly
    store.seed('themes', 'filler', filler(room + 1));
    const over = await storage.save(same);
    expect(!over.ok && over.failure.kind).toBe('size-limit');
    expect(!over.ok && over.failure.actions).toContain('manage-storage');
  });
});

describe('storage failures keep the in-memory draft and offer recovery', () => {
  it('reports storage denied with a download action', async () => {
    const { storage, store } = setup();
    store.failAlways = domError('SecurityError');
    const entry = edited(testEntry('a'));
    const result = await storage.save(entry);
    expect(!result.ok && result.failure.kind).toBe('storage-denied');
    expect(!result.ok && result.failure.actions).toContain('download');
    expect(!result.ok && result.failure.message).toContain('unsaved locally');
    expect(entry.draft.envelope.overrides.light).toEqual({ palette: { accent: richNode } });
    const loaded = await storage.load();
    expect(!loaded.ok && loaded.failure.kind).toBe('storage-denied');
  });

  it('reports quota exceeded with download and manage-storage actions, writing nothing', async () => {
    const { storage, store } = setup();
    store.failWrites = domError('QuotaExceededError');
    const result = await storage.save(testEntry('a'));
    expect(!result.ok && result.failure.kind).toBe('quota-exceeded');
    expect(!result.ok && result.failure.actions).toEqual(['download', 'manage-storage']);
    expect(store.data.themes.size).toBe(0);
  });

  it('reports an unknown failure as a storage error with download', async () => {
    const { storage, store } = setup();
    store.failNext = new Error('boom');
    const result = await storage.save(testEntry('a'));
    expect(!result.ok && result.failure).toMatchObject({
      kind: 'storage-error',
      actions: ['download'],
    });
  });

  it('retries cleanly after a failure without losing the edit', async () => {
    const { storage, store } = setup();
    const entry = edited(testEntry('a'));
    store.failNext = domError('QuotaExceededError');
    expect(await succeeds(storage.save(entry))).toBe(false);
    expect(await succeeds(storage.save(entry))).toBe(true);
  });
});

describe('corrupt and future-version records', () => {
  const futureRecord = {
    recordVersion: THEME_RECORD_VERSION + 1,
    id: 'f',
    name: 'From the future',
    payload: { unknown: [1, 2] },
  };

  it('surfaces a corrupt record as a downloadable problem and never rewrites it', async () => {
    const { storage, store } = setup();
    const corrupt = { recordVersion: 1, id: 'c', envelope: 'nope' };
    store.seed('themes', 'c', corrupt);
    const loaded = await storage.load();
    if (!loaded.ok) throw new Error('load failed');
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]).toMatchObject({ id: 'c', kind: 'corrupt-record' });
    expect(JSON.parse(loaded.problems[0]!.download.text)).toEqual(corrupt);
    expect(loaded.library.entries['c']).toBeUndefined();
    const attempt = await storage.save(testEntry('c'));
    expect(!attempt.ok && attempt.failure.kind).toBe('corrupt-record');
    expect(!attempt.ok && attempt.failure.actions).toContain('download');
    expect(store.data.themes.get('c')).toEqual(corrupt);
  });

  it('keeps a future-version draft downloadable, byte for byte, and never rewrites it', async () => {
    const { storage, store } = setup();
    store.seed('themes', 'f', futureRecord);
    const loaded = await storage.load();
    if (!loaded.ok) throw new Error('load failed');
    expect(loaded.problems[0]).toMatchObject({ id: 'f', kind: 'future-version' });
    expect(JSON.parse(loaded.problems[0]!.download.text)).toEqual(futureRecord);
    const attempt = await storage.save(testEntry('f'));
    expect(!attempt.ok && attempt.failure.kind).toBe('future-version');
    const removal = await storage.removePermanently('f', 1);
    expect(!removal.ok && removal.failure.kind).toBe('future-version');
    expect(store.data.themes.get('f')).toEqual(futureRecord);
  });

  it('still loads the readable themes next to a bad record', async () => {
    const { storage, store } = setup();
    await storage.save(testEntry('a'));
    store.seed('themes', 'f', futureRecord);
    store.seed('themes', 'junk', 42);
    const loaded = await storage.load();
    if (!loaded.ok) throw new Error('load failed');
    expect(Object.keys(loaded.library.entries)).toEqual(['a']);
    expect(loaded.problems.map((problem) => problem.kind).toSorted()).toEqual([
      'corrupt-record',
      'future-version',
    ]);
  });
});

describe('reading a stored version', () => {
  it('returns the stored entry for "Reload stored version"', async () => {
    const { storage } = setup();
    const first = edited(testEntry('a'));
    await storage.save(first);
    const read = await storage.read('a');
    expect(read.ok && read.entry.draft.revision).toBe(first.draft.revision);
    const missing = await storage.read('nope');
    expect(!missing.ok && missing.failure.storedRevision).toBeNull();
  });
});

describe('no network', () => {
  it('uses no network primitive in the modules it owns', async () => {
    const sources = await Promise.all(
      [
        'theme-draft.ts',
        'theme-history.ts',
        'theme-library.ts',
        'theme-draft-storage.ts',
        'theme-draft-store.ts',
        'theme-draft-record.ts',
        'theme-draft-sync.ts',
        'theme-envelope.ts',
        'legacy-color-override-notice.ts',
      ].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    }
  });

  it('markSaved is exercised so a successful save clears dirtiness', () => {
    const entry = edited(testEntry('a'));
    expect(markSaved(entry.draft, savedDraft(entry.draft)).savedRevision).toBe(
      entry.draft.revision,
    );
  });
});
