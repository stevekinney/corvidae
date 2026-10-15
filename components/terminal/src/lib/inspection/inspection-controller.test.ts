import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { textSaver } from './export.ts';
import { createFakeSource, createHarness } from './inspection-test-support.ts';
import { SEARCH_TEXT_BYTE_LIMIT, SNAPSHOT_BYTE_LIMIT } from './inspection-types.ts';

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
    expect(source.reads).toEqual([SEARCH_TEXT_BYTE_LIMIT]);
    harness.inspection.setQuery('alpha');
    expect(harness.inspection.view.search.count).toBe(2);
    expect(harness.inspection.view.query).toBe('alpha');
    expect(harness.events).toEqual([
      { kind: 'search', matches: 2, capped: false, truncated: false },
    ]);
  });

  test('next and previous wrap once and report the match count, not the match', () => {
    const harness = createHarness(createFakeSource('a a'));
    harness.inspection.openSearch();
    harness.inspection.setQuery('a');
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
    harness.inspection.setQuery('find');
    source.reads.length = 0;
    source.text = 'find find';
    harness.inspection.contentChanged();
    harness.inspection.contentChanged();
    harness.inspection.contentChanged();
    expect(source.reads).toEqual([]);
    expect(harness.scheduler.pending).toBe(1);
    harness.scheduler.flush();
    expect(source.reads).toHaveLength(1);
    expect(harness.inspection.view.search.count).toBe(2);
  });

  test('stepping reads the output as it is now when a re-search is still waiting', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    harness.inspection.setQuery('find');
    source.text = 'find find find';
    harness.inspection.contentChanged();
    harness.inspection.next();
    expect(harness.inspection.view.search.count).toBe(3);
    expect(harness.scheduler.pending).toBe(0);
  });

  test('a re-search that fires after the search closed or the controller was disposed does nothing', () => {
    const source = createFakeSource('find');
    const closed = createHarness(source);
    closed.inspection.openSearch();
    closed.inspection.contentChanged();
    closed.inspection.closeSearch();
    expect(closed.scheduler.pending).toBe(0);
    const disposed = createHarness(createFakeSource('find'));
    disposed.inspection.openSearch();
    disposed.inspection.contentChanged();
    disposed.inspection.dispose();
    expect(disposed.scheduler.pending).toBe(0);
  });

  test('a re-search that was scheduled and then closed in place does nothing when it runs', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    harness.inspection.contentChanged();
    // The frame callback escapes cancellation, as a callback already queued can.
    harness.inspection.closeSearch();
    source.reads.length = 0;
    harness.scheduler.flush();
    expect(source.reads).toEqual([]);
  });

  test('evicted or cleared output is unavailable to a search', () => {
    const source = createFakeSource('keep drop');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    harness.inspection.setQuery('drop');
    expect(harness.inspection.view.search.count).toBe(1);
    source.text = 'keep';
    harness.inspection.contentChanged();
    harness.scheduler.flush();
    expect(harness.inspection.view.search.count).toBe(0);
    expect(harness.inspection.view.search.status).toBe('no-matches');
  });

  test('a replaced or vanished source makes the search unavailable', () => {
    const source = createFakeSource('find');
    const harness = createHarness(source);
    harness.inspection.openSearch();
    harness.inspection.setQuery('find');
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
    harness.inspection.setQuery('find');
    source.gone = true;
    harness.inspection.contentChanged();
    harness.scheduler.flush();
    expect(harness.inspection.view.search.status).toBe('unavailable');
  });

  test('closing the search keeps the query for next time and stops work', () => {
    const harness = createHarness(createFakeSource('a'));
    harness.inspection.openSearch();
    harness.inspection.setQuery('a');
    harness.inspection.closeSearch();
    expect(harness.inspection.view.searchOpen).toBe(false);
    harness.inspection.sourceChanged();
    expect(harness.inspection.view.query).toBe('a');
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
    expect(source.reads).toEqual([SNAPSHOT_BYTE_LIMIT]);
    const shown = harness.inspection.view.snapshot!;
    expect(shown.snapshot.text).toBe('hello');
    expect(shown).toMatchObject({ stale: false, replaced: false, refreshable: true });
    expect(harness.announcements).toEqual(['Terminal snapshot ready']);
    expect(harness.events).toEqual([
      { kind: 'snapshot', action: 'open', bytes: 5, truncated: false, stale: false },
    ]);
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

  test('refresh does nothing when there is no snapshot, no source, or the engine vanished', () => {
    const source = createFakeSource('x');
    const harness = createHarness(source);
    harness.inspection.refreshSnapshot();
    expect(harness.events).toEqual([]);
    harness.inspection.openSnapshot();
    source.gone = true;
    harness.events.length = 0;
    harness.inspection.refreshSnapshot();
    expect(harness.events).toEqual([]);
    harness.source.current = undefined;
    harness.inspection.refreshSnapshot();
    expect(harness.events).toEqual([]);
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
  test('prepares a result and announces truncation before anything is saved', () => {
    const source = createFakeSource('line one\nline two');
    source.truncated = true;
    const harness = createHarness(source);
    harness.inspection.prepareExport();
    expect(saved).toEqual([]);
    expect(harness.announcements).toEqual(['Terminal snapshot truncated']);
    expect(harness.inspection.view.exportOpen).toBe(true);
    expect(harness.inspection.view.export!.result).toEqual({
      text: 'line one\nline two',
      truncated: true,
      exportedBytes: 17,
      retainedBytes: 17,
    });
    expect(harness.events).toEqual([
      { kind: 'export', action: 'prepare', exportedBytes: 17, retainedBytes: 17, truncated: true },
    ]);
  });

  test('downloads exactly what was prepared, once', () => {
    const source = createFakeSource('done');
    const harness = createHarness(source);
    harness.inspection.prepareExport();
    expect(harness.announcements).toEqual(['Terminal snapshot ready']);
    source.text = 'changed after the message';
    harness.inspection.downloadExport();
    harness.inspection.downloadExport();
    expect(saved).toEqual(['done']);
    expect(harness.inspection.view.exportOpen).toBe(false);
    expect(harness.events.at(-1)).toEqual({
      kind: 'export',
      action: 'download',
      exportedBytes: 4,
      retainedBytes: 4,
      truncated: false,
    });
  });

  test('cancelling never saves, and releases the text once the dialog is gone', () => {
    const harness = createHarness(createFakeSource('keep'));
    harness.inspection.prepareExport();
    harness.inspection.cancelExport();
    harness.inspection.cancelExport();
    expect(saved).toEqual([]);
    expect(
      harness.events.map((event) => (event.kind === 'export' ? event.action : event.kind)),
    ).toEqual(['prepare', 'cancel']);
    expect(harness.inspection.view.export).toBeDefined();
    harness.inspection.releaseExport();
    expect(harness.inspection.view.export).toBeUndefined();
  });

  test('downloading with nothing prepared, and releasing an open dialog, do nothing', () => {
    const harness = createHarness(createFakeSource('x'));
    harness.inspection.downloadExport();
    harness.inspection.cancelExport();
    expect(saved).toEqual([]);
    harness.inspection.prepareExport();
    harness.inspection.releaseExport();
    expect(harness.inspection.view.export).toBeDefined();
  });

  test('cannot be prepared without an engine', () => {
    const none = createHarness();
    none.inspection.prepareExport();
    expect(none.inspection.view.exportOpen).toBe(false);
    const source = createFakeSource('x');
    source.gone = true;
    const gone = createHarness(source);
    gone.inspection.prepareExport();
    expect(gone.inspection.view.exportOpen).toBe(false);
  });

  test('is still available after the process exited, because it reads retained output', () => {
    const harness = createHarness(createFakeSource('finished output'));
    harness.inspection.prepareExport();
    harness.inspection.downloadExport();
    expect(saved).toEqual(['finished output']);
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
    harness.inspection.setQuery('find');
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
      harness.inspection.setQuery('x');
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
    harness.inspection.setQuery(query);
    harness.inspection.next();
    harness.inspection.previous();
    harness.inspection.openSnapshot();
    harness.inspection.activateLink('https://secret.example/path');
    source.text = `${output} more`;
    harness.inspection.contentChanged();
    harness.inspection.refreshSnapshot();
    harness.inspection.closeSnapshot();
    harness.inspection.prepareExport();
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
