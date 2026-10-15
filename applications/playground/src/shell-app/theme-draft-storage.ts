/**
 * Versioned IndexedDB persistence for the local theme library (COR-490). Every write is one
 * readwrite transaction that compares the persisted revision with the editor's
 * `savedRevision` before it writes; a failed comparison never overwrites. The module never
 * throws to its caller and never sends theme values anywhere but the local database (and a
 * same-origin BroadcastChannel that carries only ids and revision numbers).
 */

import { THEME_DATA_LIMITS, utf8Length } from './theme-draft-limits.ts';
import {
  classifyRecord,
  rawDownload,
  toStoredRecord,
  type ClassifiedRecord,
} from './theme-draft-record.ts';
import { classifyStorageError, type ThemeStore } from './theme-draft-store.ts';
import type { ThemeEntry, ThemeLibrary } from './theme-library.ts';

export type StorageAction = 'download' | 'manage-storage' | 'reload-stored' | 'save-as-copy';

export type StorageFailureKind =
  | 'storage-denied'
  | 'quota-exceeded'
  | 'storage-error'
  | 'corrupt-record'
  | 'future-version'
  | 'conflict'
  | 'theme-limit'
  | 'size-limit';

export type StorageFailure = {
  kind: StorageFailureKind;
  /** Plain-language, actionable copy for the status area. */
  message: string;
  actions: readonly StorageAction[];
  /** For a conflict: the revision found in storage, or `null` when the theme was removed. */
  storedRevision?: number | null;
};

export type StorageProblem = {
  id: string;
  kind: 'corrupt-record' | 'future-version';
  message: string;
  download: { filename: string; mime: string; text: string };
};

export type LoadResult =
  | { ok: true; library: ThemeLibrary; problems: StorageProblem[] }
  | { ok: false; failure: StorageFailure };

export type SaveResult = { ok: true; revision: number } | { ok: false; failure: StorageFailure };

const MESSAGES: Record<StorageFailureKind, string> = {
  'storage-denied':
    'This browser is not letting the theme builder store drafts. Your edits are kept in memory but are unsaved locally. Download the theme to keep it.',
  'quota-exceeded':
    'Browser storage is full. Your edits are kept in memory but are unsaved locally. Download the theme or free space by managing stored themes.',
  'storage-error':
    'Saving failed. Your edits are kept in memory but are unsaved locally. Download the theme to keep it.',
  'corrupt-record':
    'The stored copy of this theme is unreadable and was left untouched. Your in-memory draft is unsaved locally; download it or save it as a copy.',
  'future-version':
    'This theme was saved by a newer version of the theme builder. It is left untouched and cannot be edited here; download it to keep it. Once downloaded, you can delete it permanently to free its slot.',
  conflict:
    'Another tab changed this theme. Reload the stored version, or save your draft as a copy. Nothing was overwritten.',
  'theme-limit': `The library holds ${THEME_DATA_LIMITS.themes} themes including Trash. Download or permanently delete a theme to make room.`,
  'size-limit':
    'Local theme storage is at its 50 MiB limit. Download a theme or manage stored themes before saving more.',
};

const ACTIONS: Record<StorageFailureKind, readonly StorageAction[]> = {
  'storage-denied': ['download'],
  'quota-exceeded': ['download', 'manage-storage'],
  'storage-error': ['download'],
  'corrupt-record': ['download', 'save-as-copy'],
  'future-version': ['download', 'save-as-copy'],
  conflict: ['reload-stored', 'save-as-copy', 'download'],
  'theme-limit': ['download', 'manage-storage'],
  'size-limit': ['download', 'manage-storage'],
};

export function failure(
  kind: StorageFailureKind,
  extra: { storedRevision?: number | null } = {},
): StorageFailure {
  return { kind, message: MESSAGES[kind], actions: ACTIONS[kind], ...extra };
}

const serializedBytes = (value: unknown): number => utf8Length(JSON.stringify(value) ?? '');
const ACTIVE_KEY = 'activeTheme';

export class ThemeDraftStorage {
  readonly #store: ThemeStore;
  readonly #now: () => string;

  constructor(store: ThemeStore, now: () => string = () => new Date().toISOString()) {
    this.#store = store;
    this.#now = now;
  }

  /** Read the whole library; unreadable records become downloadable problems, never edits. */
  async load(): Promise<LoadResult> {
    try {
      return await this.#store.transact('readonly', async (tx) => {
        const raws = await tx.getAll('themes');
        const active = await tx.get('meta', ACTIVE_KEY);
        const entries: Record<string, ThemeEntry> = {};
        const problems: StorageProblem[] = [];
        raws.forEach((raw, index) => {
          const classified = classifyRecord(raw);
          if (classified.kind === 'ok') {
            entries[classified.entry.draft.envelope.id] = classified.entry;
            return;
          }
          const id = recordId(raw, index);
          problems.push({
            id,
            kind: classified.kind === 'corrupt' ? 'corrupt-record' : 'future-version',
            message: MESSAGES[classified.kind === 'corrupt' ? 'corrupt-record' : 'future-version'],
            download: rawDownload(id, raw),
          });
        });
        const activeId =
          typeof active === 'string' && entries[active]?.trashed === null ? active : null;
        return { ok: true as const, library: { entries, activeId }, problems };
      });
    } catch (error) {
      return { ok: false, failure: failure(classifyStorageError(error)) };
    }
  }

  /** Read one theme as stored, for "Reload stored version". */
  async read(
    id: string,
  ): Promise<{ ok: true; entry: ThemeEntry } | { ok: false; failure: StorageFailure }> {
    try {
      const raw = await this.#store.transact('readonly', (tx) => tx.get('themes', id));
      const classified = classifyRecord(raw);
      if (classified.kind === 'ok') return { ok: true, entry: classified.entry };
      if (raw === undefined)
        return { ok: false, failure: failure('conflict', { storedRevision: null }) };
      return {
        ok: false,
        failure: failure(classified.kind === 'corrupt' ? 'corrupt-record' : 'future-version'),
      };
    } catch (error) {
      return { ok: false, failure: failure(classifyStorageError(error)) };
    }
  }

  /**
   * Persist `entry` if storage still holds `entry.draft.savedRevision` (or nothing, for a
   * theme never saved). Delete and restore are saves of an entry whose tombstone changed, so
   * the tombstone lands in the same transaction as the revision bump.
   */
  async save(entry: ThemeEntry): Promise<SaveResult> {
    const expected = entry.draft.savedRevision;
    const record = toStoredRecord(entry, this.#now());
    const id = record.id;
    const incomingBytes = serializedBytes(record);
    try {
      return await this.#store.transact('readwrite', async (tx) => {
        const existing = await tx.get('themes', id);
        if (existing !== undefined) {
          const classified = classifyRecord(existing);
          const refusal = unwritable(classified);
          if (refusal !== null) return { ok: false as const, failure: refusal };
          if (classified.kind === 'ok' && classified.revision !== expected) {
            return {
              ok: false as const,
              failure: failure('conflict', { storedRevision: classified.revision }),
            };
          }
        } else if (expected !== null) {
          return { ok: false as const, failure: failure('conflict', { storedRevision: null }) };
        }
        const all = await tx.getAll('themes');
        const others = existing === undefined ? all : all.filter((raw) => recordId(raw, -1) !== id);
        if (others.length + 1 > THEME_DATA_LIMITS.themes) {
          return { ok: false as const, failure: failure('theme-limit') };
        }
        const total = others.reduce<number>(
          (sum, raw) => sum + serializedBytes(raw),
          incomingBytes,
        );
        if (total > THEME_DATA_LIMITS.storageBytes) {
          return { ok: false as const, failure: failure('size-limit') };
        }
        await tx.put('themes', id, record);
        return { ok: true as const, revision: record.revision };
      });
    } catch (error) {
      return { ok: false, failure: failure(classifyStorageError(error)) };
    }
  }

  /** Remove a record for good. Compares revisions like any write, and only a Trash record goes. */
  async removePermanently(id: string, expectedRevision: number): Promise<SaveResult> {
    try {
      return await this.#store.transact('readwrite', async (tx) => {
        const existing = await tx.get('themes', id);
        if (existing === undefined) return { ok: true as const, revision: expectedRevision };
        const classified = classifyRecord(existing);
        const refusal = unwritable(classified);
        if (refusal !== null) return { ok: false as const, failure: refusal };
        if (
          classified.kind === 'ok' &&
          (classified.revision !== expectedRevision || classified.entry.trashed === null)
        ) {
          return {
            ok: false as const,
            failure: failure('conflict', { storedRevision: classified.revision }),
          };
        }
        await tx.delete('themes', id);
        return { ok: true as const, revision: expectedRevision };
      });
    } catch (error) {
      return { ok: false, failure: failure(classifyStorageError(error)) };
    }
  }

  /**
   * Permanently remove a record written by a newer version of the theme builder. This version
   * never rewrites such a record, so this is the only way to free its slot, and it requires
   * proof that the user kept a copy: `downloadedText` must equal the stored record's download,
   * byte for byte. That comparison is also the compare-and-set — a record another tab changed
   * after the download no longer matches and is left untouched. Corrupt records are not covered.
   */
  async removeFutureVersionRecord(id: string, downloadedText: string): Promise<SaveResult> {
    try {
      return await this.#store.transact('readwrite', async (tx) => {
        const existing = await tx.get('themes', id);
        if (existing === undefined) return { ok: true as const, revision: 0 };
        const classified = classifyRecord(existing);
        if (classified.kind === 'corrupt') {
          return { ok: false as const, failure: failure('corrupt-record') };
        }
        if (classified.kind !== 'future-version') {
          return { ok: false as const, failure: failure('conflict', { storedRevision: null }) };
        }
        if (rawDownload(id, existing).text !== downloadedText) {
          return { ok: false as const, failure: failure('conflict', { storedRevision: null }) };
        }
        await tx.delete('themes', id);
        return { ok: true as const, revision: 0 };
      });
    } catch (error) {
      return { ok: false, failure: failure(classifyStorageError(error)) };
    }
  }

  async setActive(
    id: string | null,
  ): Promise<{ ok: true } | { ok: false; failure: StorageFailure }> {
    try {
      await this.#store.transact('readwrite', async (tx) => {
        if (id === null) await tx.delete('meta', ACTIVE_KEY);
        else await tx.put('meta', ACTIVE_KEY, id);
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, failure: failure(classifyStorageError(error)) };
    }
  }
}

function unwritable(classified: ClassifiedRecord): StorageFailure | null {
  if (classified.kind === 'corrupt') return failure('corrupt-record');
  if (classified.kind === 'future-version') return failure('future-version');
  return null;
}

function recordId(raw: unknown, index: number): string {
  if (typeof raw === 'object' && raw !== null) {
    const id = Reflect.get(raw, 'id');
    if (typeof id === 'string' && id !== '') return id;
  }
  return index < 0 ? '' : `unreadable-${index + 1}`;
}
