import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { settle } from '../components/terminal/terminal-test-support.ts';
import { textSaver } from './export.ts';
import { inspectionTimer } from './inspection-controller.ts';
import { createFakeSource, createHarness } from './inspection-test-support.ts';
import {
  RETAINED_READ_CEILING,
  SEARCH_REFRESH_DELAY_MS,
  SEARCH_TEXT_BYTE_LIMIT,
  SEARCH_TYPING_DELAY_MS,
  SNAPSHOT_BYTE_LIMIT,
} from './inspection-types.ts';

/** Type a query and let the pause that follows it pass. */
function typed(harness: ReturnType<typeof createHarness>, query: string): void {
  harness.inspection.setQuery(query);
  harness.timer.flush();
}

const originalSave = textSaver.save;
const saved: string[] = [];

beforeEach(() => {
  textSaver.save = (text) => {
    saved.push(text);
  };
});

afterEach(() => {
  textSaver.save = originalSave;
  saved.length = 0;
});

describe('search', () => {
  test('cannot open without a live source', () => {
    const harness = createHarness();
    harness.inspection.openSearch();
    expect(harness.inspection.view.searchOpen).toBe(false);
    expect(harness.inspection.view.available).toBe(false);
  });

  test('searches the bounded retained text and reports the result as counts only', () => {
    const source = createFakeSource('alpha beta alpha');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    expect(source.reads).toEqual([]);
    typed(harness, 'alpha');
    expect(source.reads).toEqual([SEARCH_TEXT_BYTE_LIMIT]);
    expect(harness.inspection.view.search.count).toBe(2);
    expect(harness.inspection.view.query).toBe('alpha');
    expect(harness.events).toEqual([
      { kind: 'search', matches: 2, capped: false, truncated: false },
    ]);
  });

  test('next and previous wrap once and report the match count, not the match', () => {
    const harness = createHarness(createFakeSource('a a'));
    harness.inspection.openSearch();
    typed(harness, 'a');
    harness.events.length = 0;
    harness.inspection.next();
    harness.inspection.next();
    harness.inspection.next();
    expect(harness.inspection.view.search.index).toBe(0);
    harness.inspection.previous();
    expect(harness.inspection.view.search.index).toBe(1);
    expect(harness.events).toEqual([
      { kind: 'navigate', direction: 'next', wrapped: false, matches: 2 },
      { kind: 'navigate', direction: 'next', wrapped: false, matches: 2 },
      { kind: 'navigate', direction: 'next', wrapped: true, matches: 2 },
      { kind: 'navigate', direction: 'previous', wrapped: true, matches: 2 },
    ]);
  });

  test('stepping while the search is closed does nothing', () => {
    const harness = createHarness(createFakeSource('a'));
    harness.inspection.next();
    harness.inspection.previous();
    expect(harness.events).toEqual([]);
  });

  test('new output re-searches once per scheduled frame, however many chunks arrive', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    source.reads.length = 0;
    source.text = 'find find';
    harness.inspection.contentChanged();
    harness.inspection.contentChanged();
    harness.inspection.contentChanged();
    expect(source.reads).toEqual([]);
    expect(harness.timer.pending).toBe(1);
    harness.timer.flush();
    expect(source.reads).toHaveLength(1);
    expect(harness.inspection.view.search.count).toBe(2);
  });

  test('stepping reads the output as it is now when a re-search is still waiting', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    source.text = 'find find find';
    harness.inspection.contentChanged();
    harness.inspection.next();
    expect(harness.inspection.view.search.count).toBe(3);
    expect(harness.timer.pending).toBe(0);
  });

  test('a re-search that fires after the search closed or the controller was disposed does nothing', () => {
    const source = createFakeSource('find');
    const closed = createHarness(source);
    closed.inspection.openSearch();
    closed.inspection.contentChanged();
    closed.inspection.closeSearch();
    expect(closed.timer.pending).toBe(0);
    const disposed = createHarness(createFakeSource('find'));
    disposed.inspection.openSearch();
    disposed.inspection.contentChanged();
    disposed.inspection.dispose();
    expect(disposed.timer.pending).toBe(0);
  });

  test('a re-search that was scheduled and then closed in place does nothing when it runs', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    harness.inspection.contentChanged();
    // The frame callback escapes cancellation, as a callback already queued can.
    harness.inspection.closeSearch();
    source.reads.length = 0;
    harness.timer.flush();
    expect(source.reads).toEqual([]);
  });

  test('evicted or cleared output is unavailable to a search', () => {
    const source = createFakeSource('keep drop');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'drop');
    expect(harness.inspection.view.search.count).toBe(1);
    source.text = 'keep';
    harness.inspection.contentChanged();
    harness.timer.flush();
    expect(harness.inspection.view.search.count).toBe(0);
    expect(harness.inspection.view.search.status).toBe('no-matches');
  });

  test('a replaced or vanished source makes the search unavailable', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    harness.source.current = undefined;
    harness.inspection.sourceChanged();
    expect(harness.inspection.view.search.status).toBe('unavailable');
    expect(harness.inspection.view.available).toBe(false);
    harness.source.current = createFakeSource('find', 2);
    harness.inspection.sourceChanged();
    expect(harness.inspection.view.search.status).toBe('matches');
  });

  test('a gone engine makes the search unavailable even before the source is replaced', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    source.gone = true;
    harness.inspection.contentChanged();
    harness.timer.flush();
    expect(harness.inspection.view.search.status).toBe('unavailable');
  });

  test('closing the search stops work: a source change afterwards reads nothing', () => {
    const source = createFakeSource('a');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'a');
    harness.inspection.closeSearch();
    expect(harness.inspection.view.searchOpen).toBe(false);
    source.reads.length = 0;
    harness.inspection.sourceChanged();
    expect(source.reads).toEqual([]);
  });
});

describe('the real clock', () => {
  test('runs a callback after its delay, and not at all once cancelled', async () => {
    const ran: string[] = [];
    inspectionTimer.start(() => ran.push('kept'), 0);
    inspectionTimer.start(() => ran.push('cancelled'), 0)();
    await settle();
    await settle();
    expect(ran).toEqual(['kept']);
  });
});

describe('typing a query', () => {
  test('echoes the query at once but searches once per pause, however many keys came first', () => {
    const source = createFakeSource('a b a b');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    source.reads.length = 0;
    for (const query of ['a', 'a ', 'a b']) harness.inspection.setQuery(query);
    expect(harness.inspection.view.query).toBe('a b');
    expect(source.reads).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.timer.delays).toEqual([SEARCH_TYPING_DELAY_MS]);
    harness.timer.flush();
    expect(source.reads).toEqual([SEARCH_TEXT_BYTE_LIMIT]);
    expect(harness.inspection.view.search.count).toBe(2);
    expect(harness.events).toEqual([
      { kind: 'search', matches: 2, capped: false, truncated: false },
    ]);
  });

  test('a one-character query and a query with a line feed are searched after the pause', () => {
    const harness = createHarness(createFakeSource('x\ny'));
    harness.inspection.openSearch();
    typed(harness, 'x');
    expect(harness.inspection.view.search.count).toBe(1);
    typed(harness, 'x\ny');
    expect(harness.inspection.view.search.count).toBe(1);
  });

  test('stepping before the pause ends searches the query the reader typed', () => {
    const harness = createHarness(createFakeSource('find find'));
    harness.inspection.openSearch();
    harness.inspection.setQuery('find');
    harness.inspection.next();
    expect(harness.inspection.view.search.index).toBe(0);
    expect(harness.inspection.view.search.count).toBe(2);
    expect(harness.timer.pending).toBe(0);
  });

  test('a search that outlives its pause because the search closed does nothing', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    harness.inspection.setQuery('find');
    harness.inspection.closeSearch();
    expect(harness.timer.pending).toBe(0);
    harness.timer.flush();
    expect(harness.inspection.view.search.count).toBe(0);
  });

  test('output refreshes the results at most once per refresh interval', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    harness.inspection.contentChanged();
    harness.inspection.contentChanged();
    expect(harness.timer.delays).toEqual([SEARCH_REFRESH_DELAY_MS]);
  });
});

describe('closing the search', () => {
  test('releases the searched text, the matches and the query, so a reopened search starts empty', () => {
    const source = createFakeSource('find find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    harness.inspection.next();
    expect(harness.inspection.view.search.count).toBe(2);
    harness.inspection.closeSearch();
    const closed = harness.inspection.view;
    expect(closed.query).toBe('');
    expect(closed.search).toMatchObject({ status: 'idle', count: 0, index: undefined });
    expect(closed.search.excerpt).toBeUndefined();
    expect(closed.search.match).toBeUndefined();
    source.reads.length = 0;
    harness.inspection.openSearch();
    expect(harness.inspection.view.query).toBe('');
    expect(harness.inspection.view.search.count).toBe(0);
    // With no query there is nothing to search for, so nothing is read.
    expect(source.reads).toEqual([]);
  });

  test('no match survives a replaced session', () => {
    const first = createFakeSource('find here');
    const harness = createHarness(first);
    harness.inspection.openSearch();
    typed(harness, 'find');
    harness.inspection.next();
    expect(harness.inspection.view.search.match).toBeDefined();
    const second = createFakeSource('nothing like it', 2);
    harness.source.current = second;
    harness.inspection.sourceChanged();
    expect(harness.inspection.view.search).toMatchObject({ count: 0, index: undefined });
    expect(harness.inspection.view.search.match).toBeUndefined();
    expect(harness.inspection.view.search.excerpt).toBeUndefined();
    expect(second.selectionClears).toBeGreaterThan(0);
    harness.source.current = undefined;
    harness.inspection.sourceChanged();
    expect(harness.inspection.view.search.status).toBe('unavailable');
  });
});

describe('a match that cannot be selected', () => {
  test('is reported, and the report ends when a match can be selected or the search closes', () => {
    const source = createFakeSource('find find');
    source.selectable = false;
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    expect(harness.inspection.view.selectionFailed).toBe(false);
    harness.inspection.next();
    expect(harness.inspection.view.selectionFailed).toBe(true);
    source.selectable = true;
    harness.inspection.next();
    expect(harness.inspection.view.selectionFailed).toBe(false);
    source.selectable = false;
    harness.inspection.next();
    expect(harness.inspection.view.selectionFailed).toBe(true);
    typed(harness, 'fin');
    expect(harness.inspection.view.selectionFailed).toBe(false);
    harness.inspection.next();
    expect(harness.inspection.view.selectionFailed).toBe(true);
    harness.inspection.closeSearch();
    expect(harness.inspection.view.selectionFailed).toBe(false);
  });
});

describe('the snapshot', () => {
  test('cannot open without a source or when the engine vanished', () => {
    const harness = createHarness();
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.snapshotOpen).toBe(false);
    const source = createFakeSource('x');
    source.gone = true;
    const other = createHarness(source);
    other.inspection.openSnapshot();
    expect(other.inspection.view.snapshotOpen).toBe(false);
  });

  test('is captured within the snapshot budget and announced', () => {
    const source = createFakeSource('hello');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    expect(source.reads).toEqual([SNAPSHOT_BYTE_LIMIT, RETAINED_READ_CEILING]);
    const shown = harness.inspection.view.snapshot!;
    expect(shown.snapshot.text).toBe('hello');
    expect(shown).toMatchObject({ stale: false, replaced: false, refreshable: true });
    expect(harness.announcements).toEqual(['Terminal snapshot ready']);
    expect(harness.events).toEqual([
      { kind: 'snapshot', action: 'open', bytes: 5, truncated: false, stale: false },
    ]);
  });

  test('a truncated download is announced even when the snapshot itself fits', () => {
    const source = createFakeSource('x');
    const original = source.readProjection;
    source.readProjection = (maximumBytes) => {
      const projection = original(maximumBytes);
      return projection === undefined || maximumBytes !== RETAINED_READ_CEILING
        ? projection
        : { ...projection, truncated: true };
    };
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.snapshot!.snapshot.truncated).toBe(false);
    expect(harness.announcements).toEqual(['Terminal snapshot truncated']);
  });

  test('an empty terminal gives an empty snapshot', () => {
    const harness = createHarness(createFakeSource(''));
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.snapshot!.snapshot.text).toBe('');
  });

  test('a truncated snapshot is announced as truncated', () => {
    const source = createFakeSource('abc');
    source.truncated = true;
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    expect(harness.announcements).toEqual(['Terminal snapshot truncated']);
    expect(harness.inspection.view.snapshot!.snapshot.truncated).toBe(true);
  });

  test('new output never changes it, and marks it stale', () => {
    const source = createFakeSource('before');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    const first = harness.inspection.view.snapshot!.snapshot;
    source.text = 'before and after';
    harness.inspection.contentChanged();
    const shown = harness.inspection.view.snapshot!;
    expect(shown.stale).toBe(true);
    expect(shown.snapshot).toBe(first);
    expect(shown.snapshot.text).toBe('before');
  });

  test('only the first change after a capture republishes the view', () => {
    const harness = createHarness(createFakeSource('x'));
    harness.inspection.openSnapshot();
    let heard = 0;
    harness.inspection.subscribe(() => {
      heard += 1;
    });
    harness.inspection.contentChanged();
    harness.inspection.contentChanged();
    harness.inspection.contentChanged();
    expect(heard).toBe(1);
  });

  test('refresh recaptures the same live generation, and is announced', () => {
    const source = createFakeSource('before');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    source.text = 'after';
    harness.inspection.contentChanged();
    harness.inspection.refreshSnapshot();
    const shown = harness.inspection.view.snapshot!;
    expect(shown.snapshot.text).toBe('after');
    expect(shown.stale).toBe(false);
    expect(harness.announcements.at(-1)).toBe('Terminal snapshot refreshed');
    expect(harness.events.at(-1)).toEqual({
      kind: 'snapshot',
      action: 'refresh',
      bytes: 5,
      truncated: false,
      stale: false,
    });
  });

  test('a replaced source disables refresh and link activation, and the snapshot stays as it was', () => {
    const source = createFakeSource('see https://a.example');
    const harness = createHarness(source);
    const activated: string[] = [];
    harness.link.current = (url) => activated.push(url);
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.snapshot!.linksActive).toBe(true);
    const replacement = createFakeSource('different https://b.example', 2);
    harness.source.current = replacement;
    harness.inspection.sourceChanged();
    const shown = harness.inspection.view.snapshot!;
    expect(shown).toMatchObject({ replaced: true, refreshable: false, linksActive: false });
    harness.inspection.refreshSnapshot();
    harness.inspection.activateLink('https://a.example');
    expect(harness.inspection.view.snapshot!.snapshot.text).toBe('see https://a.example');
    expect(activated).toEqual([]);
    expect(replacement.reads).toEqual([]);
    expect(harness.events.at(-1)).toEqual({ kind: 'link', action: 'refuse' });
  });

  test('a refresh that cannot recapture changes nothing, reports false, and says the snapshot is stale', () => {
    const source = createFakeSource('x');
    const harness = createHarness(source);
    expect(harness.inspection.refreshSnapshot()).toBe(false);
    harness.inspection.openSnapshot();
    const first = harness.inspection.view.snapshot!.snapshot;
    source.gone = true;
    harness.events.length = 0;
    harness.announcements.length = 0;
    expect(harness.inspection.refreshSnapshot()).toBe(false);
    harness.source.current = undefined;
    expect(harness.inspection.refreshSnapshot()).toBe(false);
    expect(harness.events).toEqual([]);
    expect(harness.announcements).toEqual(['Terminal snapshot stale', 'Terminal snapshot stale']);
    expect(harness.inspection.view.snapshot!.snapshot).toBe(first);
  });

  test('closing keeps the text until the dialog has gone, then releases it', () => {
    const harness = createHarness(createFakeSource('secret output'));
    harness.inspection.openSnapshot();
    harness.inspection.closeSnapshot();
    expect(harness.inspection.view.snapshotOpen).toBe(false);
    expect(harness.inspection.view.snapshot).toBeDefined();
    harness.inspection.releaseSnapshot();
    expect(harness.inspection.view.snapshot).toBeUndefined();
  });

  test('releasing while the dialog is open keeps it, and closing twice is quiet', () => {
    const harness = createHarness(createFakeSource('x'));
    harness.inspection.closeSnapshot();
    expect(harness.events).toEqual([]);
    harness.inspection.openSnapshot();
    harness.inspection.releaseSnapshot();
    expect(harness.inspection.view.snapshot).toBeDefined();
  });

  test('reopening captures what is there now, never the earlier text', () => {
    const source = createFakeSource('first');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    harness.inspection.closeSnapshot();
    harness.inspection.releaseSnapshot();
    source.text = 'second';
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.snapshot!.snapshot.text).toBe('second');
    expect(harness.inspection.view.snapshot!.stale).toBe(false);
  });

  test('closing reports whether it was stale', () => {
    const source = createFakeSource('x');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    harness.inspection.contentChanged();
    harness.inspection.closeSnapshot();
    expect(harness.events.at(-1)).toEqual({
      kind: 'snapshot',
      action: 'close',
      bytes: 1,
      truncated: false,
      stale: true,
    });
  });
});

describe('links', () => {
  test('activate a listed address, once, through the host handler', () => {
    const harness = createHarness(createFakeSource('go https://a.example/x now'));
    const activated: string[] = [];
    harness.link.current = (url) => activated.push(url);
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.linksEnabled).toBe(true);
    harness.inspection.activateLink('https://a.example/x');
    expect(activated).toEqual(['https://a.example/x']);
    expect(harness.events.at(-1)).toEqual({ kind: 'link', action: 'activate' });
  });

  test('refuse an address the snapshot does not list, with or without a handler', () => {
    const harness = createHarness(createFakeSource('go https://a.example now'));
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.linksEnabled).toBe(false);
    harness.inspection.activateLink('https://a.example');
    expect(harness.events.at(-1)).toEqual({ kind: 'link', action: 'refuse' });
    const activated: string[] = [];
    harness.link.current = (url) => activated.push(url);
    harness.inspection.activateLink('https://evil.example');
    harness.inspection.activateLink('file:///etc/passwd');
    expect(activated).toEqual([]);
  });

  test('refuse with no snapshot at all', () => {
    const harness = createHarness(createFakeSource('https://a.example'));
    harness.link.current = () => {
      throw new Error('must not run');
    };
    harness.inspection.activateLink('https://a.example');
    expect(harness.events).toEqual([{ kind: 'link', action: 'refuse' }]);
  });

  test('a handler that throws changes nothing', () => {
    const harness = createHarness(createFakeSource('https://a.example'));
    harness.link.current = () => {
      throw new Error('host bug');
    };
    harness.inspection.openSnapshot();
    expect(() => harness.inspection.activateLink('https://a.example')).not.toThrow();
    expect(harness.inspection.view.snapshotOpen).toBe(true);
  });
});

describe('export', () => {
  test('is taken with the snapshot, so its size and truncation are known before anything is saved', () => {
    const source = createFakeSource('line one\nline two');
    source.truncated = true;
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    expect(saved).toEqual([]);
    expect(source.reads).toEqual([SNAPSHOT_BYTE_LIMIT, RETAINED_READ_CEILING]);
    expect(harness.inspection.view.snapshot!.snapshot.export).toEqual({
      text: 'line one\nline two',
      truncated: true,
      exportedBytes: 17,
      retainedBytes: 17,
    });
    expect(harness.events.filter((event) => event.kind === 'export')).toEqual([]);
  });

  test('downloads exactly what was described, however often it is asked and whatever changed since', () => {
    const source = createFakeSource('done');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    source.text = 'changed after the message';
    harness.inspection.contentChanged();
    harness.inspection.downloadExport();
    harness.inspection.downloadExport();
    expect(saved).toEqual(['done', 'done']);
    expect(harness.inspection.view.snapshotOpen).toBe(true);
    expect(harness.events.at(-1)).toEqual({
      kind: 'export',
      action: 'download',
      exportedBytes: 4,
      retainedBytes: 4,
      truncated: false,
    });
  });

  test('refresh takes a new export with the new snapshot', () => {
    const source = createFakeSource('one');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    source.text = 'one two';
    harness.inspection.refreshSnapshot();
    harness.inspection.downloadExport();
    expect(saved).toEqual(['one two']);
  });

  test('does nothing without an open snapshot', () => {
    const harness = createHarness(createFakeSource('x'));
    harness.inspection.downloadExport();
    harness.inspection.openSnapshot();
    harness.inspection.closeSnapshot();
    harness.inspection.downloadExport();
    expect(saved).toEqual([]);
  });

  test('is still available after the process exited, because it reads retained output', () => {
    const harness = createHarness(createFakeSource('finished output'));
    harness.inspection.openSnapshot();
    harness.inspection.downloadExport();
    expect(saved).toEqual(['finished output']);
  });

  test('cannot be taken when the full read finds no engine', () => {
    const source = createFakeSource('x');
    let reads = 0;
    const original = source.readProjection;
    source.readProjection = (maximumBytes) => (++reads === 2 ? undefined : original(maximumBytes));
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.snapshotOpen).toBe(false);
  });
});

describe('selecting the match in the terminal', () => {
  function searchingHarness(text: string) {
    const source = createFakeSource(text);
    const harness = createHarness(source);
    harness.inspection.openSearch();
    typed(harness, 'find');
    return { source, harness };
  }

  test('selects the active match, bounded like the search, when the reader steps', () => {
    const { source, harness } = searchingHarness('find a find');
    expect(source.selections).toEqual([]);
    harness.inspection.next();
    harness.inspection.next();
    expect(source.selections).toEqual([
      { start: 0, end: 4, text: 'find' },
      { start: 7, end: 11, text: 'find' },
    ]);
  });

  test('has nothing selected until a match is active, and drops the selection when it goes', () => {
    const { source, harness } = searchingHarness('find');
    expect(source.selectionClears).toBeGreaterThan(0);
    harness.inspection.next();
    const before = source.selectionClears;
    typed(harness, 'missing');
    expect(source.selectionClears).toBeGreaterThan(before);
  });

  test('closing the search drops the selection', () => {
    const { source, harness } = searchingHarness('find');
    harness.inspection.next();
    const before = source.selectionClears;
    harness.inspection.closeSearch();
    expect(source.selectionClears).toBe(before + 1);
  });

  test('new output keeps the selection while the match survives, and drops it when it does not', () => {
    const { source, harness } = searchingHarness('find');
    harness.inspection.next();
    const selected = source.selections.length;
    const cleared = source.selectionClears;
    source.text = 'find more';
    harness.inspection.contentChanged();
    harness.timer.flush();
    expect(source.selections).toHaveLength(selected);
    expect(source.selectionClears).toBe(cleared);
    source.text = 'gone';
    harness.inspection.contentChanged();
    harness.timer.flush();
    expect(source.selectionClears).toBe(cleared + 1);
  });

  test('without a source there is nothing to select or clear', () => {
    const { harness } = searchingHarness('find');
    harness.inspection.next();
    harness.source.current = undefined;
    expect(() => {
      harness.inspection.closeSearch();
    }).not.toThrow();
  });
});

describe('clear', () => {
  test('passes each scope to the source, then announces and reports it', () => {
    const source = createFakeSource('x');
    const harness = createHarness(source);
    harness.inspection.clear('visible');
    harness.inspection.clear('retained');
    harness.inspection.clear('reset');
    expect(source.clears).toEqual(['visible', 'retained', 'reset']);
    expect(harness.announcements).toEqual([
      'Terminal screen cleared',
      'Terminal history cleared',
      'Terminal reset',
    ]);
    expect(harness.events).toEqual([
      { kind: 'clear', scope: 'visible' },
      { kind: 'clear', scope: 'retained' },
      { kind: 'clear', scope: 'reset' },
    ]);
  });

  test('is announced only once the source has applied it, in order behind pending writes', () => {
    const source = createFakeSource('x');
    source.deferClears = true;
    const harness = createHarness(source);
    harness.inspection.clear('retained');
    expect(harness.announcements).toEqual([]);
    source.pendingDone[0]!();
    expect(harness.announcements).toEqual(['Terminal history cleared']);
  });

  test('marks an open snapshot stale and re-searches', () => {
    const source = createFakeSource('find me');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    harness.inspection.openSearch();
    typed(harness, 'find');
    source.text = '';
    harness.inspection.clear('retained');
    expect(harness.inspection.view.snapshot!.stale).toBe(true);
    expect(harness.inspection.view.search.count).toBe(0);
  });

  test('does nothing without a source', () => {
    const harness = createHarness();
    harness.inspection.clear('reset');
    expect(harness.events).toEqual([]);
  });
});

describe('observers', () => {
  test('a throwing observer changes nothing', () => {
    const harness = createHarness(createFakeSource('x'));
    harness.hook.current = () => {
      throw new Error('observer bug');
    };
    expect(() => {
      harness.inspection.openSearch();
      typed(harness, 'x');
      harness.inspection.openSnapshot();
      harness.inspection.clear('visible');
    }).not.toThrow();
    expect(harness.inspection.view.snapshotOpen).toBe(true);
  });

  test('no observer is fine', () => {
    const harness = createHarness(createFakeSource('x'));
    harness.hook.current = undefined;
    harness.inspection.openSnapshot();
    expect(harness.inspection.view.snapshotOpen).toBe(true);
  });

  test('events and announcements never contain output or the query', () => {
    const output = 'TOKEN=hunter2 https://secret.example/path password';
    const query = 'hunter2';
    const source = createFakeSource(output);
    const harness = createHarness(source);
    harness.link.current = () => {};
    harness.inspection.openSearch();
    typed(harness, query);
    harness.inspection.next();
    harness.inspection.previous();
    harness.inspection.openSnapshot();
    harness.inspection.activateLink('https://secret.example/path');
    source.text = `${output} more`;
    harness.inspection.contentChanged();
    harness.inspection.refreshSnapshot();
    harness.inspection.closeSnapshot();
    harness.inspection.downloadExport();
    harness.inspection.clear('retained');
    const recorded = JSON.stringify([harness.events, harness.announcements]);
    for (const secret of ['hunter2', 'secret.example', 'TOKEN', 'password', query]) {
      expect(recorded).not.toContain(secret);
    }
    for (const event of harness.events) {
      for (const value of Object.values(event)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });

  test('uses no console', async () => {
    const files = [
      'inspection-controller.ts',
      'search.ts',
      'export.ts',
      'snapshot.ts',
      'inspection-copy.ts',
      'inspection-panel.svelte',
    ];
    for (const file of files) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).not.toMatch(/\bconsole\./u);
    }
  });
});

describe('lifecycle', () => {
  test('subscribers hear changes until they leave', () => {
    const harness = createHarness(createFakeSource('x'));
    let heard = 0;
    const stop = harness.inspection.subscribe(() => {
      heard += 1;
    });
    harness.inspection.openSnapshot();
    stop();
    harness.inspection.closeSnapshot();
    expect(heard).toBe(1);
  });

  test('after dispose the source is no longer read and nothing is held', () => {
    const source = createFakeSource('held');
    const harness = createHarness(source);
    harness.inspection.openSnapshot();
    harness.inspection.dispose();
    source.reads.length = 0;
    harness.inspection.openSearch();
    harness.inspection.openSnapshot();
    expect(source.reads).toEqual([]);
    expect(harness.inspection.view.snapshot).toBeDefined();
  });
});
