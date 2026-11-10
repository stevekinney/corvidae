import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assetsRoot } from './paths.ts';
import {
  BATCH_BYTE_LIMIT,
  BATCH_FILE_LIMIT,
  codeList,
  designSystemIndex,
  fillBrandBook,
  INDEX_PATH,
  planPublishBatches,
  sentenceNumber,
} from './publish.ts';

describe('brand book', () => {
  test('spells counts and lists names', () => {
    expect(sentenceNumber(30)).toBe('Thirty');
    expect(sentenceNumber(7)).toBe('Seven');
    expect(sentenceNumber(42)).toBe('Forty-two');
    expect(sentenceNumber(130)).toBe('130');
    expect(codeList(['A'])).toBe('`A`');
    expect(codeList(['A', 'B', 'C'])).toBe('`A`, `B` and `C`');
  });

  test('fills the checked-in template completely', () => {
    const template = readFileSync(join(assetsRoot, 'brand-book.md'), 'utf8');
    const filled = fillBrandBook(template, {
      staticComponents: ['ApprovalCard', 'SchemaForm'],
      componentsWithoutCard: 30,
    });
    expect(filled).toContain('**Static renditions.** `ApprovalCard` and `SchemaForm` bundle');
    expect(filled).toContain('**Parts of compound components.** Thirty sub-components');
    expect(filled).not.toContain('{{');
    expect(() =>
      fillBrandBook('{{unknown}}', { staticComponents: [], componentsWithoutCard: 0 }),
    ).toThrow('unknown placeholder');
  });
});

describe('designSystemIndex', () => {
  test('points at the brand book and records the source commit', () => {
    const index = designSystemIndex({
      sha: 'abc',
      author: 'A',
      note: 'N',
      at: '2026-11-09T00:00:00Z',
    });
    expect(index['editing']).toBe('code');
    expect(index['namespace']).toBeNull();
    expect(index['docs']).toEqual({ readme: 'project/README.md', sections: [] });
    expect(index['lastChange']).toEqual({
      by: 'A',
      at: '2026-11-09T00:00:00Z',
      via: 'Claude Code · stevekinney/corvidae@abc',
      note: 'N',
    });
  });
});

describe('planPublishBatches', () => {
  test('caps each publish by files and bytes and sends the index alone, last', () => {
    const files = [
      { path: INDEX_PATH, bytes: 500 },
      ...Array.from({ length: BATCH_FILE_LIMIT + 5 }, (_, index) => ({
        path: `project/components/C${String(index).padStart(3, '0')}/README.md`,
        bytes: 10,
      })),
      { path: 'project/components/bundle.css', bytes: BATCH_BYTE_LIMIT },
    ];
    const batches = planPublishBatches(files);
    expect(batches.at(-1)).toEqual([INDEX_PATH]);
    expect(batches.every((batch) => batch.length <= BATCH_FILE_LIMIT)).toBe(true);
    expect(batches.flat().toSorted()).toEqual(files.map((file) => file.path).toSorted());
    const sizes = new Map(files.map((file) => [file.path, file.bytes]));
    for (const batch of batches) {
      const bytes = batch.reduce((total, path) => total + (sizes.get(path) ?? 0), 0);
      expect(bytes).toBeLessThanOrEqual(BATCH_BYTE_LIMIT);
    }
    expect(() => planPublishBatches([{ path: 'project/README.md', bytes: 1 }])).toThrow(INDEX_PATH);
  });
});
