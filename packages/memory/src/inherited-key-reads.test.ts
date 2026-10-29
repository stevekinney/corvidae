/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. An HTML entity such as `&constructor;` is not a named entity, so it stays as written
 * rather than becoming the source of `Object`.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';

import { chunkHtml } from './html-chunking';

describe('an HTML entity named after a name every object inherits', () => {
  test('is left as written', async () => {
    const chunks = await chunkHtml('<p>Tom &constructor; Jerry &amp; Spike</p>');
    const text = chunks.map((chunk) => chunk.text).join('\n');
    expect(text).toContain('&constructor;');
    expect(text).toContain('Jerry & Spike');
    expect(text).not.toContain('native code');
  });
});
