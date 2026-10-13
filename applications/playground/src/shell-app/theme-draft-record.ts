/**
 * The versioned IndexedDB record for one theme (COR-490). A record is written whole, with the
 * embedded base, the draft source, the input buffer and the history. Reading classifies it:
 * readable, corrupt, or written by a newer version. Corrupt and future records are never
 * rewritten; they are offered for download exactly as stored.
 */

import type { InputBufferEntry } from './theme-draft-types.ts';
import { restoreDraft } from './theme-draft.ts';
import { envelopeFromValue } from './theme-envelope.ts';
import type { HistoryEntry, ThemeHistory } from './theme-history.ts';
import type { ThemeEntry, Tombstone } from './theme-library.ts';

export const THEME_RECORD_VERSION = 1;

export type StoredThemeRecord = {
  recordVersion: typeof THEME_RECORD_VERSION;
  id: string;
  name: string;
  revision: number;
  tombstone: Tombstone | null;
  updatedAt: string;
  envelope: unknown;
  history: Pick<ThemeHistory, 'baseline' | 'entries' | 'cursor' | 'limitNotice'>;
  inputBuffer: Record<string, InputBufferEntry>;
};

export function toStoredRecord(entry: ThemeEntry, updatedAt: string): StoredThemeRecord {
  const { draft, history, trashed } = entry;
  return {
    recordVersion: THEME_RECORD_VERSION,
    id: draft.envelope.id,
    name: draft.envelope.name,
    revision: draft.revision,
    tombstone: trashed,
    updatedAt,
    envelope: draft.envelope,
    history: {
      baseline: history.baseline,
      entries: history.entries,
      cursor: history.cursor,
      limitNotice: history.limitNotice,
    },
    inputBuffer: draft.inputBuffer,
  };
}

export type ClassifiedRecord =
  | { kind: 'ok'; entry: ThemeEntry; revision: number; name: string }
  | { kind: 'future-version'; version: number }
  | { kind: 'corrupt'; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isEditableState(value: unknown): boolean {
  return isObject(value) && isObject(value['overrides']) && isObject(value['cssOverrides']);
}

export function classifyRecord(raw: unknown): ClassifiedRecord {
  if (!isObject(raw)) return { kind: 'corrupt', reason: 'The record is not an object.' };
  const version = raw['recordVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'corrupt', reason: 'The record has no valid version.' };
  }
  if (version > THEME_RECORD_VERSION) return { kind: 'future-version', version };
  const envelope = envelopeFromValue(raw['envelope']);
  const { revision, history, tombstone, inputBuffer } = raw;
  if (envelope === null) return { kind: 'corrupt', reason: 'The theme envelope is unreadable.' };
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return { kind: 'corrupt', reason: 'The revision is invalid.' };
  }
  if (!isObject(history) || !isEditableState(history['baseline'])) {
    return { kind: 'corrupt', reason: 'The history is unreadable.' };
  }
  const entries = history['entries'];
  const cursor = history['cursor'];
  if (
    !Array.isArray(entries) ||
    !entries.every((entry) => isObject(entry) && isEditableState(entry['state'])) ||
    typeof cursor !== 'number' ||
    cursor < 0 ||
    cursor > entries.length
  ) {
    return { kind: 'corrupt', reason: 'The history is unreadable.' };
  }
  if (tombstone !== null && !(isObject(tombstone) && typeof tombstone['version'] === 'number')) {
    return { kind: 'corrupt', reason: 'The tombstone is unreadable.' };
  }
  if (!isObject(inputBuffer)) return { kind: 'corrupt', reason: 'The input buffer is unreadable.' };
  return {
    kind: 'ok',
    revision,
    name: envelope.name,
    entry: {
      draft: restoreDraft(envelope, revision, inputBuffer as Record<string, InputBufferEntry>),
      history: {
        baseline: history['baseline'] as ThemeHistory['baseline'],
        entries: entries as HistoryEntry[],
        cursor,
        limitNotice: history['limitNotice'] === true,
        gesture: null,
      },
      trashed: tombstone as Tombstone | null,
    },
  };
}

/** The unchanged bytes of a record the app could not or must not interpret. */
export function rawDownload(
  id: string,
  raw: unknown,
): { filename: string; mime: string; text: string } {
  return {
    filename: `cinder-theme-${id.slice(0, 8)}-stored.json`,
    mime: 'application/json',
    text: `${JSON.stringify(raw, null, 2)}\n`,
  };
}
