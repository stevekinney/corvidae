import { describe, expect, it } from 'bun:test';

import { richNode, testBase } from './theme-draft-test-support.ts';
import { applyEdit } from './theme-draft.ts';
import { envelopeDownload, parseThemeEnvelope } from './theme-envelope.ts';
import {
  createTheme,
  deleteTheme,
  duplicateTheme,
  emptyLibrary,
  importThemeCopy,
  permanentDeleteCopy,
  permanentlyDeleteTheme,
  renameTheme,
  restoreTheme,
  saveDraftAsCopy,
  switchTheme,
  themeCount,
  type LibraryResult,
  type ThemeLibrary,
} from './theme-library.ts';
import { checkThemeName, MAX_THEME_NAME_LENGTH, uniqueThemeName } from './theme-names.ts';

function ok(result: LibraryResult): ThemeLibrary {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.library;
}

describe('theme names', () => {
  it('trims and requires 1 to 80 characters', () => {
    expect(checkThemeName('  Brand  ', [])).toEqual({ ok: true, name: 'Brand' });
    expect(checkThemeName('   ', [])).toEqual({ ok: false, reason: 'name-empty' });
    expect(checkThemeName('a'.repeat(MAX_THEME_NAME_LENGTH), []).ok).toBe(true);
    expect(checkThemeName('a'.repeat(MAX_THEME_NAME_LENGTH + 1), [])).toEqual({
      ok: false,
      reason: 'name-too-long',
    });
  });

  it('compares case-insensitively', () => {
    expect(checkThemeName('brand', ['BRAND'])).toEqual({ ok: false, reason: 'name-conflict' });
  });

  it('appends the first free numeric suffix and trims the stem to stay within 80', () => {
    expect(uniqueThemeName('Brand', ['Brand'])).toBe('Brand 2');
    expect(uniqueThemeName('Brand', ['Brand', 'brand 2', 'Brand 3'])).toBe('Brand 4');
    const long = 'x'.repeat(80);
    const copy = uniqueThemeName(long, [long]);
    expect(copy).toBe(`${'x'.repeat(78)} 2`);
    expect(copy.length).toBe(80);
  });
});

describe('local theme library', () => {
  function two(): ThemeLibrary {
    let library = ok(createTheme(emptyLibrary(), 'a', 'Alpha', testBase()));
    library = ok(createTheme(library, 'b', 'Beta', testBase()));
    return library;
  }

  it('creates and switches themes, restoring exactly the selected theme content', () => {
    let library = two();
    const edit = applyEdit(library.entries['a']!.draft, {
      kind: 'set-override',
      scope: 'light',
      path: 'palette.accent',
      node: richNode,
    });
    if (!edit.ok) throw new Error('edit refused');
    library = {
      ...library,
      entries: { ...library.entries, a: { ...library.entries['a']!, draft: edit.draft } },
    };
    library = ok(switchTheme(library, 'b'));
    expect(library.activeId).toBe('b');
    library = ok(switchTheme(library, 'a'));
    expect(library.entries['a']!.draft.envelope.overrides.light).toEqual({
      palette: { accent: richNode },
    });
    expect(library.entries['b']!.draft.envelope.overrides.light).toEqual({});
  });

  it('reports a rename conflict instead of renaming', () => {
    const library = two();
    expect(renameTheme(library, 'b', 'ALPHA')).toEqual({ ok: false, reason: 'name-conflict' });
    expect(renameTheme(library, 'b', '')).toEqual({ ok: false, reason: 'name-empty' });
    const renamed = ok(renameTheme(library, 'b', 'Gamma'));
    expect(renamed.entries['b']!.draft.envelope.name).toBe('Gamma');
    // Renaming a theme to its own name (different case) is not a conflict with itself.
    expect(renameTheme(library, 'b', 'beta').ok).toBe(true);
  });

  it('duplicates with a suffix and a new immutable id, copying content', () => {
    const library = ok(duplicateTheme(two(), 'a', 'c'));
    expect(library.entries['c']!.draft.envelope.name).toBe('Alpha 2');
    expect(library.entries['c']!.draft.envelope.id).toBe('c');
    expect(library.entries['c']!.draft.savedRevision).toBeNull();
    expect(library.activeId).toBe('c');
  });

  it('delete moves to Trash with a versioned tombstone, and restore brings it back', () => {
    const library = ok(deleteTheme(two(), 'b', '2026-10-13T00:00:00Z'));
    const trashed = library.entries['b']!;
    expect(trashed.trashed).toEqual({
      deletedAt: '2026-10-13T00:00:00Z',
      version: trashed.draft.revision,
    });
    expect(trashed.draft.revision).toBe(2);
    expect(library.activeId).toBe('a');
    expect(switchTheme(library, 'b')).toEqual({ ok: false, reason: 'in-trash' });
    const restored = ok(restoreTheme(library, 'b'));
    expect(restored.entries['b']!.trashed).toBeNull();
    expect(restored.entries['b']!.draft.revision).toBe(3);
  });

  it('keeps trashed names reserved so a restore can never collide', () => {
    const library = ok(deleteTheme(two(), 'b', 'now'));
    expect(createTheme(library, 'c', 'beta', testBase())).toEqual({
      ok: false,
      reason: 'name-conflict',
    });
  });

  it('only permanently deletes from Trash, and the copy names what is lost', () => {
    const library = two();
    expect(permanentlyDeleteTheme(library, 'b')).toEqual({ ok: false, reason: 'not-in-trash' });
    const gone = ok(permanentlyDeleteTheme(ok(deleteTheme(library, 'b', 'now')), 'b'));
    expect(gone.entries['b']).toBeUndefined();
    const copy = permanentDeleteCopy('Beta');
    expect(copy).toContain('Beta');
    expect(copy).toContain('embedded Cinder base');
    expect(copy).toContain('draft');
    expect(copy).toContain('undo history');
  });

  it('counts Trash toward the 50 theme cap and refuses the 51st', () => {
    let library = emptyLibrary();
    for (let i = 0; i < 50; i += 1)
      library = ok(createTheme(library, `id${i}`, `T${i}`, testBase()));
    expect(themeCount(library)).toBe(50);
    expect(createTheme(library, 'x', 'Extra', testBase())).toEqual({
      ok: false,
      reason: 'theme-limit',
    });
    const trashed = ok(deleteTheme(library, 'id0', 'now'));
    expect(createTheme(trashed, 'x', 'Extra', testBase())).toEqual({
      ok: false,
      reason: 'theme-limit',
    });
    expect(duplicateTheme(library, 'id1', 'y')).toEqual({ ok: false, reason: 'theme-limit' });
  });

  it('save as copy keeps the original untouched and gives the copy a unique name', () => {
    const library = two();
    const copied = ok(saveDraftAsCopy(library, 'a', 'c'));
    expect(copied.entries['a']).toBe(library.entries['a']);
    expect(copied.entries['c']!.draft.envelope.name).toBe('Alpha 2');
  });

  it('imports an envelope as a copy with a suffix and refuses one over the limits', () => {
    const library = two();
    const envelope = library.entries['a']!.draft.envelope;
    const imported = ok(importThemeCopy(library, envelope, 'z'));
    expect(imported.entries['z']!.draft.envelope.name).toBe('Alpha 2');
    const tooBig = { ...envelope, cssOverrides: { p: { 'light/default': 'a'.repeat(4097) } } };
    expect(importThemeCopy(library, tooBig, 'q')).toEqual({ ok: false, reason: 'limits' });
  });
});

describe('lossless download', () => {
  it('round-trips the envelope, preserving every authored relationship', () => {
    const library = two();
    const edit = applyEdit(library.entries['a']!.draft, {
      kind: 'set-override',
      scope: 'dark',
      path: 'palette.accent',
      node: richNode,
    });
    if (!edit.ok) throw new Error('edit refused');
    const download = envelopeDownload(edit.draft.envelope);
    expect(download.filename).toBe('alpha-a.cinder-theme.json');
    const parsed = parseThemeEnvelope(download.text);
    expect(parsed.ok && parsed.envelope).toEqual(edit.draft.envelope);
  });

  function two(): ThemeLibrary {
    return ok(createTheme(emptyLibrary(), 'a', 'Alpha', testBase()));
  }
});
