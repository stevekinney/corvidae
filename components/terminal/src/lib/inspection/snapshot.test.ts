import { describe, expect, test } from 'bun:test';

import { SNAPSHOT_LINK_LIMIT } from './inspection-types.ts';
import { captureSnapshot, snapshotLinks } from './snapshot.ts';

describe('snapshotLinks', () => {
  test('lists visible https addresses once each, in order', () => {
    expect(
      snapshotLinks('see https://a.example/x, then https://b.example and https://a.example/x.'),
    ).toEqual(['https://a.example/x', 'https://b.example']);
  });

  test('leaves out other schemes, paths, downloads and command links', () => {
    expect(
      snapshotLinks(
        'http://a.example file:///etc/passwd /usr/bin/env ./run.sh javascript:alert(1) vscode://x data:text/html,x mailto:a@b.c ftp://x.example',
      ),
    ).toEqual([]);
  });

  test('leaves out an address with credentials', () => {
    expect(snapshotLinks('https://user:secret@a.example')).toEqual([]);
  });

  test('is bounded', () => {
    const text = Array.from(
      { length: SNAPSHOT_LINK_LIMIT + 10 },
      (_, index) => `https://e.example/${index}`,
    ).join(' ');
    expect(snapshotLinks(text)).toHaveLength(SNAPSHOT_LINK_LIMIT);
    expect(snapshotLinks(text, 2)).toHaveLength(2);
  });
});

describe('captureSnapshot', () => {
  test('is frozen all the way down, and keeps the generation it came from', () => {
    const exported = {
      text: 'x https://a.example',
      truncated: true,
      exportedBytes: 19,
      retainedBytes: 40,
    };
    const snapshot = captureSnapshot(
      { text: 'x https://a.example', truncated: true, bytes: 19, lines: [] },
      4,
      exported,
    );
    expect(snapshot).toEqual({
      text: 'x https://a.example',
      truncated: true,
      bytes: 19,
      generation: 4,
      links: ['https://a.example'],
      export: exported,
    });
    expect(Object.isFrozen(snapshot.export)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.links)).toBe(true);
  });
});
