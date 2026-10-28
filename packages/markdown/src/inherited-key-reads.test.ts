/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. A code fence's language is free text, so a fence tagged `constructor` must render as
 * plain text, not hand `Object` to the highlighter as a language.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { beforeAll, describe, expect, it } from 'bun:test';

import { initializeHighlighter } from './rendering/highlighter.js';
import { rehypeShikiSync } from './rendering/rehype-shiki-sync.js';
import { createCodeBlockTree } from './rendering/rehype-shiki-test-helpers.js';

describe('a code fence tagged with a name every object inherits', () => {
  beforeAll(async () => {
    await initializeHighlighter();
  });

  it('renders as plaintext', () => {
    for (const language of ['constructor', 'toString', '__proto__']) {
      const tree = createCodeBlockTree('const x = 1;', language);
      rehypeShikiSync()(tree);
      const pre = tree.children[0]!;
      expect(pre.properties?.['dataLanguage']).toBe('plaintext');
    }
  });
});
