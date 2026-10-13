import { describe, expect, it } from 'bun:test';

import { COLOR_TOKEN_SESSION_KEY } from './color-token-overrides.ts';
import {
  clearLegacyColorOverrides,
  detectLegacyColorOverrides,
} from './legacy-color-override-notice.ts';
import { ThemeDraftStorage, failure } from './theme-draft-storage.ts';
import {
  THEME_CHANNEL_NAME,
  announceRevision,
  decideRemoteRevision,
  listenForRevisions,
  reloadDiscardCopy,
  type ChannelLike,
} from './theme-draft-sync.ts';
import {
  memoryThemeStore,
  richNode,
  savedDraft,
  succeeds,
  testEntry,
} from './theme-draft-test-support.ts';
import { applyEdit, setInput } from './theme-draft.ts';
import { saveDraftAsCopy } from './theme-library.ts';
import { saveIndicator } from './theme-save-status.ts';

function pair(): [ChannelLike, ChannelLike] {
  const listeners: Array<Set<(event: { data: unknown }) => void>> = [new Set(), new Set()];
  const make = (self: number): ChannelLike => ({
    postMessage: (data) => {
      for (const listener of listeners[1 - self]!) listener({ data: structuredClone(data) });
    },
    addEventListener: (_type, listener) => listeners[self]!.add(listener),
    removeEventListener: (_type, listener) => listeners[self]!.delete(listener),
    close: () => listeners[self]!.clear(),
  });
  return [make(0), make(1)];
}

describe('revision announcements', () => {
  it('announce only ids and revisions, and are ignored from the same tab', () => {
    const [one, two] = pair();
    const seen: unknown[] = [];
    listenForRevisions(two, 'tab-2', (announcement) => seen.push(announcement));
    announceRevision(one, 'tab-1', 'theme-a', 7);
    expect(seen).toEqual([{ type: 'revision', themeId: 'theme-a', revision: 7, sender: 'tab-1' }]);
    announceRevision(one, 'tab-2', 'theme-a', 8);
    expect(seen).toHaveLength(1);
    expect(THEME_CHANNEL_NAME).toContain('theme');
  });

  it('drops malformed messages and survives a missing or throwing channel', () => {
    const [, two] = pair();
    const seen: unknown[] = [];
    const stop = listenForRevisions(two, 'x', (a) => seen.push(a));
    stop();
    announceRevision(null, 'x', 't', 1);
    const broken: ChannelLike = {
      ...two,
      postMessage: () => {
        throw new Error('closed');
      },
    };
    expect(() => announceRevision(broken, 'x', 't', 1)).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('what a tab does with a newer stored revision', () => {
  it('lets a clean tab reload automatically with an announcement', () => {
    const clean = savedDraft(testEntry('a').draft);
    const action = decideRemoteRevision(clean, clean.revision + 1);
    expect(action.kind).toBe('auto-reload');
    expect(action.kind === 'auto-reload' && action.announcement).toContain('another tab');
  });

  it('never silently overwrites a dirty tab: it offers reload (with confirmation) or save as copy', () => {
    const edit = applyEdit(savedDraft(testEntry('a').draft), {
      kind: 'set-override',
      scope: 'light',
      path: 'p',
      node: richNode,
    });
    if (!edit.ok) throw new Error('refused');
    const action = decideRemoteRevision(edit.draft, edit.draft.savedRevision! + 1);
    expect(action).toMatchObject({ kind: 'conflict', offers: ['reload-stored', 'save-as-copy'] });
    expect(reloadDiscardCopy('My theme')).toContain('discarded');
  });

  it('treats unsaved partial input as dirty', () => {
    const typing = setInput(savedDraft(testEntry('a').draft), 'k', { text: '#1', error: 'x' });
    expect(decideRemoteRevision(typing, typing.revision + 1).kind).toBe('conflict');
  });

  it('ignores a revision it already has, so correctness never depends on delivery', () => {
    const clean = savedDraft(testEntry('a').draft);
    expect(decideRemoteRevision(clean, clean.revision).kind).toBe('ignore');
  });
});

describe('two tabs end to end', () => {
  it('a dirty tab gets a conflict, saves a copy, and the other tab keeps its write', async () => {
    const store = memoryThemeStore();
    const tabA = new ThemeDraftStorage(store);
    const tabB = new ThemeDraftStorage(store);
    const base = testEntry('a');
    await tabA.save(base);
    const synced = { ...base, draft: savedDraft(base.draft) };
    const editA = applyEdit(synced.draft, {
      kind: 'set-override',
      scope: 'light',
      path: 'p',
      node: richNode,
    });
    const editB = applyEdit(synced.draft, {
      kind: 'set-override',
      scope: 'dark',
      path: 'p',
      node: richNode,
    });
    if (!editA.ok || !editB.ok) throw new Error('refused');
    expect(await succeeds(tabA.save({ ...synced, draft: editA.draft }))).toBe(true);
    const lost = await tabB.save({ ...synced, draft: editB.draft });
    expect(!lost.ok && lost.failure.kind).toBe('conflict');

    const library = { entries: { a: { ...synced, draft: editB.draft } }, activeId: 'a' };
    const copied = saveDraftAsCopy(library, 'a', 'b');
    if (!copied.ok) throw new Error('refused');
    expect(copied.library.entries['b']!.draft.envelope.name).toBe('My theme 2');
    expect(await succeeds(tabB.save(copied.library.entries['b']!))).toBe(true);
    const stored = await tabB.read('a');
    expect(stored.ok && stored.entry.draft.envelope.overrides.light).toEqual({ p: richNode });
  });
});

describe('save indicator', () => {
  it('reads Saved locally only for a clean, healthy draft', () => {
    const clean = savedDraft(testEntry('a').draft);
    expect(saveIndicator(clean, null)).toMatchObject({ label: 'Saved locally', notice: null });
    expect(saveIndicator(testEntry('a').draft, null).label).toBe('Unsaved locally');
  });

  it('reads Unsaved locally with an actionable notice for every failure', () => {
    const clean = savedDraft(testEntry('a').draft);
    for (const kind of [
      'storage-denied',
      'quota-exceeded',
      'storage-error',
      'corrupt-record',
      'future-version',
    ] as const) {
      const indicator = saveIndicator(clean, failure(kind));
      expect(indicator.label).toBe('Unsaved locally');
      expect(indicator.notice).not.toBeNull();
      expect(indicator.actions).toContain('download');
    }
  });
});

describe('old color-panel session data', () => {
  function sessionStore(initial: string | null) {
    const data = new Map<string, string>(
      initial === null ? [] : [[COLOR_TOKEN_SESSION_KEY, initial]],
    );
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      removeItem: (key: string) => void data.delete(key),
    };
  }

  it('reports nothing when there is no legacy data', () => {
    expect(detectLegacyColorOverrides(sessionStore(null))).toBeNull();
  });

  it('offers the raw JSON byte for byte and does not touch it', () => {
    const raw = '{"light":{"--cinder-color-accent":"#123456"},"dark":{}}';
    const storage = sessionStore(raw);
    const notice = detectLegacyColorOverrides(storage);
    expect(notice?.download.text).toBe(raw);
    expect(notice?.download.mime).toBe('application/json');
    expect(storage.data.get(COLOR_TOKEN_SESSION_KEY)).toBe(raw);
  });

  it('keeps even unparseable data, and clears only on the explicit action', () => {
    const storage = sessionStore('{not json');
    expect(detectLegacyColorOverrides(storage)?.rawText).toBe('{not json');
    expect(clearLegacyColorOverrides(storage)).toBe(true);
    expect(detectLegacyColorOverrides(storage)).toBeNull();
  });

  it('degrades to no notice when session storage throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(detectLegacyColorOverrides(throwing)).toBeNull();
    expect(clearLegacyColorOverrides(throwing)).toBe(false);
  });
});
