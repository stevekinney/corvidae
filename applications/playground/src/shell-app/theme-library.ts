/**
 * The local theme library (COR-490): create, rename, duplicate, switch, delete to Trash,
 * restore, permanently delete, import as a copy and save as a copy. Pure functions over an
 * immutable library. Identity is the immutable id; names are display labels, unique
 * case-insensitively across every theme including those in Trash (so a restore can never
 * collide).
 */

import { THEME_DATA_LIMITS } from './theme-draft-limits.ts';
import {
  editableState,
  type ThemeBase,
  type ThemeDraft,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import { createDraft, renameDraft } from './theme-draft.ts';
import { createEnvelope, envelopeLimitViolations } from './theme-envelope.ts';
import { createHistory, type ThemeHistory } from './theme-history.ts';
import { checkThemeName, uniqueThemeName, type NameProblem } from './theme-names.ts';

export type Tombstone = { deletedAt: string; version: number };

export type ThemeEntry = {
  draft: ThemeDraft;
  history: ThemeHistory;
  /** A versioned tombstone: the theme is in Trash and restorable. */
  trashed: Tombstone | null;
};

export type ThemeLibrary = {
  entries: Readonly<Record<string, ThemeEntry>>;
  activeId: string | null;
};

export type LibraryProblem =
  NameProblem | 'theme-limit' | 'limits' | 'not-found' | 'not-in-trash' | 'in-trash';

export type LibraryResult =
  { ok: true; library: ThemeLibrary; id: string } | { ok: false; reason: LibraryProblem };

export const emptyLibrary = (): ThemeLibrary => ({ entries: {}, activeId: null });

export const themeCount = (library: ThemeLibrary): number => Object.keys(library.entries).length;

export const allNames = (library: ThemeLibrary, exceptId?: string): string[] =>
  Object.entries(library.entries)
    .filter(([id]) => id !== exceptId)
    .map(([, entry]) => entry.draft.envelope.name);

export const activeThemes = (library: ThemeLibrary): ThemeEntry[] =>
  Object.values(library.entries).filter((entry) => entry.trashed === null);

export const trashedThemes = (library: ThemeLibrary): ThemeEntry[] =>
  Object.values(library.entries).filter((entry) => entry.trashed !== null);

function withEntry(
  library: ThemeLibrary,
  id: string,
  entry: ThemeEntry,
  activate: boolean,
): ThemeLibrary {
  return {
    entries: { ...library.entries, [id]: entry },
    activeId: activate ? id : library.activeId,
  };
}

function freshEntry(envelope: ThemeEnvelope): ThemeEntry {
  return {
    draft: createDraft(envelope),
    history: createHistory(editableState(envelope)),
    trashed: null,
  };
}

/** Create a theme from an embedded base; `id` is supplied by the caller (`crypto.randomUUID`). */
export function createTheme(
  library: ThemeLibrary,
  id: string,
  rawName: string,
  base: ThemeBase,
): LibraryResult {
  if (themeCount(library) >= THEME_DATA_LIMITS.themes) return { ok: false, reason: 'theme-limit' };
  const name = checkThemeName(rawName, allNames(library));
  if (!name.ok) return { ok: false, reason: name.reason };
  return {
    ok: true,
    id,
    library: withEntry(library, id, freshEntry(createEnvelope(id, name.name, base)), true),
  };
}

/** Rename; a name that is empty, over-long or already taken reports instead of changing. */
export function renameTheme(library: ThemeLibrary, id: string, rawName: string): LibraryResult {
  const entry = library.entries[id];
  if (entry === undefined) return { ok: false, reason: 'not-found' };
  const name = checkThemeName(rawName, allNames(library, id));
  if (!name.ok) return { ok: false, reason: name.reason };
  const draft = renameDraft(entry.draft, name.name);
  return { ok: true, id, library: withEntry(library, id, { ...entry, draft }, false) };
}

function copyOf(
  library: ThemeLibrary,
  newId: string,
  source: ThemeEnvelope,
  stem: string,
  history: ThemeHistory | null,
): LibraryResult {
  if (themeCount(library) >= THEME_DATA_LIMITS.themes) return { ok: false, reason: 'theme-limit' };
  const envelope: ThemeEnvelope = {
    ...source,
    id: newId,
    name: uniqueThemeName(stem, allNames(library)),
  };
  const entry = freshEntry(envelope);
  return {
    ok: true,
    id: newId,
    library: withEntry(library, newId, history === null ? entry : { ...entry, history }, true),
  };
}

/** Duplicate with the first free numeric suffix; the copy starts a fresh history. */
export function duplicateTheme(library: ThemeLibrary, id: string, newId: string): LibraryResult {
  const entry = library.entries[id];
  if (entry === undefined) return { ok: false, reason: 'not-found' };
  if (entry.trashed !== null) return { ok: false, reason: 'in-trash' };
  return copyOf(library, newId, entry.draft.envelope, entry.draft.envelope.name, null);
}

/** Import an already-parsed envelope as a new theme; the name gets a suffix when taken. */
export function importThemeCopy(
  library: ThemeLibrary,
  envelope: ThemeEnvelope,
  newId: string,
): LibraryResult {
  if (envelopeLimitViolations(envelope).length > 0) return { ok: false, reason: 'limits' };
  return copyOf(library, newId, envelope, envelope.name, null);
}

/**
 * Save as copy for a conflicted dirty tab: the in-memory content (and its history) goes to
 * a new theme; the original entry is left exactly as it is.
 */
export function saveDraftAsCopy(library: ThemeLibrary, id: string, newId: string): LibraryResult {
  const entry = library.entries[id];
  if (entry === undefined) return { ok: false, reason: 'not-found' };
  return copyOf(library, newId, entry.draft.envelope, entry.draft.envelope.name, entry.history);
}

export function switchTheme(library: ThemeLibrary, id: string): LibraryResult {
  const entry = library.entries[id];
  if (entry === undefined) return { ok: false, reason: 'not-found' };
  if (entry.trashed !== null) return { ok: false, reason: 'in-trash' };
  return { ok: true, id, library: { ...library, activeId: id } };
}

/** Move to Trash: a versioned tombstone, bumping the revision so other tabs notice. */
export function deleteTheme(library: ThemeLibrary, id: string, deletedAt: string): LibraryResult {
  const entry = library.entries[id];
  if (entry === undefined) return { ok: false, reason: 'not-found' };
  if (entry.trashed !== null) return { ok: false, reason: 'in-trash' };
  const draft: ThemeDraft = { ...entry.draft, revision: entry.draft.revision + 1 };
  const next = withEntry(
    library,
    id,
    { ...entry, draft, trashed: { deletedAt, version: draft.revision } },
    false,
  );
  const activeId =
    library.activeId === id
      ? (activeThemes(next).find((candidate) => candidate.draft.envelope.id !== id)?.draft.envelope
          .id ?? null)
      : library.activeId;
  return { ok: true, id, library: { ...next, activeId } };
}

export function restoreTheme(library: ThemeLibrary, id: string): LibraryResult {
  const entry = library.entries[id];
  if (entry === undefined) return { ok: false, reason: 'not-found' };
  if (entry.trashed === null) return { ok: false, reason: 'not-in-trash' };
  const draft: ThemeDraft = { ...entry.draft, revision: entry.draft.revision + 1 };
  return {
    ok: true,
    id,
    library: withEntry(library, id, { ...entry, draft, trashed: null }, true),
  };
}

/** Remove the record, base and history for good. Only a Trash entry can be removed. */
export function permanentlyDeleteTheme(library: ThemeLibrary, id: string): LibraryResult {
  const entry = library.entries[id];
  if (entry === undefined) return { ok: false, reason: 'not-found' };
  if (entry.trashed === null) return { ok: false, reason: 'not-in-trash' };
  const entries = { ...library.entries };
  delete entries[id];
  return { ok: true, id, library: { ...library, entries } };
}

/** What the permanent-delete confirmation says is lost. */
export function permanentDeleteCopy(name: string): string {
  return `Permanently delete “${name}”? This removes its embedded Cinder base, your draft and its undo history from this browser. It cannot be undone.`;
}
