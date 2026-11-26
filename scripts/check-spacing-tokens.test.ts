import { describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';

import {
  ALLOWLIST_PATH,
  SCANNED_DIRECTORIES,
  filterSpacingFiles,
  findOffScaleSpacing,
  trackedSpacingFiles,
} from './check-spacing-tokens';
import { allowlistRaises, judgeCounts, repositoryRoot } from './owner-rule-guard-support';

describe('spacing tokens', () => {
  test.each([
    ['a px gap', '.a { gap: 4px; }'],
    ['a negative rem margin', '.a { margin-block-start: -0.5rem; }'],
    ['a raw length equal to a scale step', '.a { padding: 0.25rem; }'],
    ['a calc with no token', '.a { margin: calc(1rem + 2px); }'],
    ['an em inset', '.a { inset-inline-start: 0.5em; }'],
    ['a row gap', '.a { row-gap: 8px; }'],
    ['a column gap', '.a { column-gap: 8px; }'],
    ['a shorthand with one off-scale part', '.a { padding: 0 6px; }'],
    ['a token with a raw fallback', '.a { gap: var(--cinder-space-3, 0.75rem); }'],
  ])('reports %s', (_name, source) => {
    expect(findOffScaleSpacing(source)).toHaveLength(1);
  });

  test.each([
    ['a token', '.a { gap: var(--cinder-space-3); }'],
    ['zero', '.a { margin: 0; }'],
    ['zero with a unit', '.a { padding: 0px; }'],
    ['one pixel', '.a { margin-top: 1px; }'],
    ['a negative one pixel', '.a { margin-top: -1px; }'],
    ['a token plus one pixel', '.a { padding: calc(var(--cinder-space-2) + 1px); }'],
    ['a percentage', '.a { inset: 50%; }'],
    ['ch', '.a { padding-inline: 2ch; }'],
    ['auto', '.a { margin-inline: auto; }'],
    ['an unrelated property', '.a { width: 4px; font-size: 1rem; scroll-margin: 4px; }'],
    ['a custom property', '.a { --gap: 4px; --cinder-space-1: 0.25rem; }'],
    ['a comment', '.a { /* gap: 4px; */ }'],
  ])('accepts %s', (_name, source) => {
    expect(findOffScaleSpacing(source)).toEqual([]);
  });

  test('scans style blocks of a Svelte file and nothing else in it', () => {
    const source =
      '<div style="margin: 4px" class="gap: 4px"></div>\n<style>\n  .a {\n    gap: 4px;\n  }\n</style>';
    expect(findOffScaleSpacing(source, 'x.svelte').map((site) => Number.parseInt(site))).toEqual([
      4,
    ]);
  });

  test('reports the line of each site', () => {
    expect(
      findOffScaleSpacing('.a {\n  gap: 4px;\n}\n.b {\n  margin: 1rem;\n}').map((site) =>
        Number.parseInt(site),
      ),
    ).toEqual([2, 5]);
  });

  test('exempts the token sources and keeps only styles', () => {
    expect(
      filterSpacingFiles([
        'components/cinder/src/tokens/sets/space.css',
        'components/cinder/src/components/button/button.css',
        'components/cinder/src/components/button/button.svelte',
        'components/cinder/src/components/button/button.ts',
      ]),
    ).toEqual([
      'components/cinder/src/components/button/button.css',
      'components/cinder/src/components/button/button.svelte',
    ]);
  });

  test('takes exactly the tracked list, so the ignored generated stylesheets are never read', () => {
    // `tokens-base.css` and `token-utilities.css` are generated, git-ignored and on disk after an
    // install, outside `tokens/`: a directory walk would return them, and would miss
    // `tracked-only.css`, which exists only in the tracked list.
    const listed = [
      'components/cinder/src/styles/foundation.css',
      'components/cinder/src/styles/tracked-only.css',
      '',
    ].join('\0');
    const files = trackedSpacingFiles(() => listed);
    expect(files).toEqual([
      'components/cinder/src/styles/foundation.css',
      'components/cinder/src/styles/tracked-only.css',
    ]);
    expect(files).not.toContain('components/cinder/src/styles/tokens-base.css');
    expect(files).not.toContain('components/cinder/src/styles/token-utilities.css');
  });
});

describe('the spacing allowlist', () => {
  test('lists only existing style files under the scanned directories, with positive counts', async () => {
    const allowlist = (await Bun.file(`${repositoryRoot}/${ALLOWLIST_PATH}`).json()) as Record<
      string,
      number
    >;
    const entries = Object.entries(allowlist);
    expect(entries.length).toBeGreaterThan(0);
    for (const [file, count] of entries) {
      expect(Number.isInteger(count) && count > 0).toBe(true);
      expect(filterSpacingFiles([file])).toEqual([file]);
      expect(SCANNED_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`))).toBe(true);
      expect(existsSync(`${repositoryRoot}/${file}`)).toBe(true);
    }
  });

  test('is checked against the tree by lint:guards, which runs this guard', async () => {
    const manifest = (await Bun.file(`${repositoryRoot}/package.json`).json()) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['lint:guards']).toContain('bun scripts/check-spacing-tokens.ts');
  });

  test('reports both a stale entry and an exceeded count when the allowlist drifts from the tree', () => {
    const found = new Map([
      ['over.css', ['1 - gap: 4px', '2 - gap: 8px']],
      ['under.css', ['1 - gap: 4px']],
    ]);
    const verdict = judgeCounts(found, { 'over.css': 1, 'under.css': 3, 'gone.css': 2 });
    expect(verdict.problems).toEqual(['over.css:2 - gap: 8px']);
    expect(verdict.stale).toEqual([
      'under.css - lists 3 but holds 1',
      'gone.css - lists 2 but holds 0',
    ]);
  });

  test('fails a file beyond its entry and one with none, and never raises an entry', () => {
    const found = new Map([
      ['a.css', ['1 - gap: 4px', '2 - gap: 8px']],
      ['b.css', ['1 - gap: 4px']],
    ]);
    expect(judgeCounts(found, { 'a.css': 1 }).problems).toEqual([
      'a.css:2 - gap: 8px',
      'b.css:1 - gap: 4px',
    ]);
    expect(allowlistRaises({ 'a.css': 2 }, { 'a.css': 1 })).toHaveLength(1);
  });
});
