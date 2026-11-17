import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assetsRoot } from './paths.ts';

// COR-2445 AC11 (COR-2306 AC4): the brand book's Icons and imagery section names the curated icon
// vocabulary: every noun of the product vocabulary and the glyph that draws it, as
// `components/icons/index.ts` declares them. The section once listed only the glyphs exported when
// it was written.
const brandBook = readFileSync(join(assetsRoot, 'brand-book.md'), 'utf8');
const section = brandBook.slice(
  brandBook.indexOf('## Icons and imagery'),
  brandBook.indexOf('## Using it'),
);
const icons = readFileSync(new URL('../../src/components/icons/index.ts', import.meta.url), 'utf8');

/** Each `noun` (`Export`) pair of the vocabulary comment in the icon module. */
function vocabulary(): [string, string][] {
  const comment = /The product vocabulary:[\s\S]*?\*\//.exec(icons)?.[0] ?? '';
  return [...comment.replace(/\n\s*\*\s*/g, ' ').matchAll(/`(\w+)` \(`(\w+)`\)/g)].map((match) => [
    match[1] ?? '',
    match[2] ?? '',
  ]);
}

describe('brand book icons', () => {
  test('the vocabulary the test reads is the 27 nouns of the icon module', () => {
    expect(vocabulary().length).toBe(27);
  });

  test('names every noun of the curated vocabulary with its glyph', () => {
    for (const [noun, glyph] of vocabulary()) {
      expect(section, `${noun} (${glyph})`).toContain(`\`${noun}\` (\`${glyph}\`)`);
    }
  });

  test('no longer says the vocabulary is still to come', () => {
    expect(section).not.toMatch(/until it lands|being filed/);
  });
});
