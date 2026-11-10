import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { collectStylesheets, stylesheetLinks } from './css-serving-parity-collect.ts';
import {
  compareRecords,
  compareStylesheetRecords,
  formatDifferences,
  normalizeStylesheetUrl,
  type ParityRecord,
  type StylesheetRecord,
} from './css-serving-parity-compare.ts';
import { readParityRecord, writeParityRecord } from './css-serving-parity.ts';

function record(
  files: Record<string, string>,
  entries: string[] = ['/styles/all.css'],
): StylesheetRecord {
  return { entries, files: new Map(Object.entries(files)), missing: [] };
}

const BASELINE: Record<string, string> = {
  '/styles/all.css': `@import './tokens.css';\n@import './components.css';`,
  '/styles/tokens.css': ':root { --a: 1 }',
  '/styles/components.css': `@import '../components/button/button.css';\n@import '../components/modal/modal.css';`,
  '/components/button/button.css': '@layer c { .button { color: red } }',
  '/components/modal/modal.css': '@layer c { .modal { margin: 0 } .modal__strip { top: 0 } }',
  '/playground-styles/documentation.css': '@layer p { .doc { color: red } }',
};

const compare = (after: Record<string, string>, before = BASELINE) =>
  compareStylesheetRecords('dev', record(before), record(after));

describe('css serving parity comparison', () => {
  test('passes when nothing changed', () => {
    expect(compare({ ...BASELINE })).toEqual([]);
  });

  test('fails on a changed leaf byte at the same URL, naming the rule', () => {
    const differences = compare({
      ...BASELINE,
      '/components/button/button.css': '@layer c { .button { color: blue } }',
    });
    const leaf = differences.find((difference) => difference.kind === 'leaf-bytes');
    expect(leaf?.url).toBe('/components/button/button.css');
    expect(leaf).toMatchObject({
      rules: {
        removed: ['@layer c :: .button{color:red;}'],
        added: ['@layer c :: .button{color:blue;}'],
        reordered: false,
      },
    });
  });

  test('fails on a byte change a rule-level view would call equal, such as a comment', () => {
    const differences = compare({
      ...BASELINE,
      '/components/button/button.css': '/* note */ @layer c { .button { color: red } }',
    });
    expect(differences.map(({ kind, url }) => [kind, url])).toContainEqual([
      'leaf-bytes',
      '/components/button/button.css',
    ]);
  });

  test('fails on a changed aggregator rule, wherever in its graph the rule lives', () => {
    const differences = compare({
      ...BASELINE,
      '/styles/tokens.css': ':root { --a: 2 }',
    });
    const aggregator = differences.find(
      (difference) =>
        difference.kind === 'aggregator-content' && difference.url === '/styles/all.css',
    );
    expect(aggregator).toMatchObject({
      rules: { removed: [':root{--a:1;}'], added: [':root{--a:2;}'] },
    });
  });

  test('fails on a changed aggregator that leads to a different set of leaves', () => {
    const differences = compare({
      ...BASELINE,
      '/styles/components.css': `@import '../components/button/button.css';`,
    });
    expect(differences).toContainEqual({
      mode: 'dev',
      url: '/styles/components.css',
      kind: 'aggregator-leaves',
      removedLeaves: ['/components/modal/modal.css'],
      addedLeaves: [],
    });
  });

  test('fails on a changed bundled output', () => {
    const differences = compare({
      ...BASELINE,
      '/playground-styles/documentation.css': '@layer p { .doc { color: blue } }',
    });
    expect(differences).toEqual([
      expect.objectContaining({
        kind: 'bundled-output',
        url: '/playground-styles/documentation.css',
      }),
    ]);
  });

  test('fails on a missing leaf URL, and reports an added one', () => {
    const { '/components/modal/modal.css': _modal, ...withoutModal } = BASELINE;
    expect(compare(withoutModal)).toContainEqual({
      mode: 'dev',
      url: '/components/modal/modal.css',
      kind: 'url-removed',
    });
    expect(compare({ ...BASELINE, '/components/extra/extra.css': '.x{}' })).toContainEqual({
      mode: 'dev',
      url: '/components/extra/extra.css',
      kind: 'url-added',
    });
  });

  test('passes a specifier-only rewrite of an aggregator', () => {
    expect(
      compare({
        ...BASELINE,
        '/styles/all.css': `@import "/styles/tokens.css";\n@import url(/styles/components.css);`,
        '/styles/components.css': `@import "/components/button/button.css";\n/* the modal */\n@import '/components/modal/modal.css';`,
      }),
    ).toEqual([]);
  });

  test('passes the static export prefix, which is not part of a stylesheet identity', () => {
    const digest = 'a'.repeat(64);
    const rewritten: Record<string, string> = {
      ...BASELINE,
      '/styles/all.css': `@import '/assets/${digest}/styles/tokens.css';\n@import '/assets/${digest}/styles/components.css';`,
    };
    expect(compare(rewritten)).toEqual([]);
    expect(normalizeStylesheetUrl(`/assets/${digest}/styles/all.css?x=1`)).toBe('/styles/all.css');
  });

  test('reports a reordered cascade as the same rules in a different order', () => {
    const differences = compare({
      ...BASELINE,
      '/components/modal/modal.css': '@layer c { .modal__strip { top: 0 } .modal { margin: 0 } }',
    });
    const leaf = differences.find((difference) => difference.kind === 'leaf-bytes');
    expect(leaf).toMatchObject({ rules: { removed: [], added: [], reordered: true } });
  });

  test('compares both serving modes and formats a readable report', () => {
    const before: ParityRecord = { dev: record(BASELINE), static: record(BASELINE) };
    const after: ParityRecord = {
      dev: record(BASELINE),
      static: record({
        ...BASELINE,
        '/components/button/button.css': '@layer c { .button { color: blue } }',
      }),
    };
    const differences = compareRecords(before, after);
    expect(differences.every((difference) => difference.mode === 'static')).toBe(true);
    expect(formatDifferences(differences)).toContain(
      '[static] leaf-bytes /components/button/button.css\n      - @layer c :: .button{color:red;}\n      + @layer c :: .button{color:blue;}',
    );
    expect(formatDifferences([])).toBe('');
  });
});

describe('css serving parity collection', () => {
  test('reads stylesheet links in any attribute order and ignores everything else', () => {
    expect(
      stylesheetLinks(
        [
          '<link rel="icon" href="/favicon.ico" />',
          '<link rel="stylesheet" href="/styles/all.css" />',
          `<link href='/playground-styles/documentation.css?x=1&amp;y=2' rel='stylesheet'>`,
          '<link rel="stylesheet" href="https://fonts.example/x.css" />',
          '<link rel="preload" as="style" href="/preload.css" />',
        ].join('\n'),
      ),
    ).toEqual(['/styles/all.css', '/playground-styles/documentation.css']);
  });

  test('follows imports transitively, once each, and records what is not served', async () => {
    const served = new Map(Object.entries(BASELINE));
    served.set(
      '/styles/all.css',
      `@import './tokens.css';\n@import './components.css';\n@import './gone.css';\n@import url(https://fonts.example/x.css);`,
    );
    const requested: string[] = [];
    const result = await collectStylesheets(
      ['/styles/all.css', '/playground-styles/documentation.css'],
      async (url) => {
        requested.push(url);
        return served.get(url);
      },
    );
    expect([...result.files.keys()]).toEqual([
      '/playground-styles/documentation.css',
      '/styles/all.css',
      '/styles/tokens.css',
      '/styles/components.css',
      '/components/button/button.css',
      '/components/modal/modal.css',
    ]);
    expect(result.missing).toEqual(['/styles/gone.css']);
    expect(new Set(requested).size).toBe(requested.length);
  });
});

describe('css serving parity record', () => {
  test('writes every URL and its bytes under the mode, and reads them back equal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'css-serving-parity-test-'));
    try {
      const written = { dev: record(BASELINE), static: record({ '/styles/all.css': '.a{}' }) };
      await writeParityRecord(directory, written);
      const buttonBytes = await Bun.file(
        join(directory, 'dev', 'components/button/button.css'),
      ).text();
      expect(buttonBytes).toBe(BASELINE['/components/button/button.css'] ?? '');
      const read = await readParityRecord(directory);
      expect(compareRecords(written, read as ParityRecord)).toEqual([]);
      expect(read.static?.files.get('/styles/all.css')).toBe('.a{}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
