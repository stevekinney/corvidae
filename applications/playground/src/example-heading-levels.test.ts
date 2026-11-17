import { describe, expect, it } from 'bun:test';

import { discoverExampleFiles } from './discover.ts';

/**
 * Examples render inside a documentation page, which owns the page's one `h1` (the component
 * name). An example that brings its own `h1` gives the exported page two, which the static
 * production gate rejects; `container/basic` did exactly that.
 */
describe('example heading levels', () => {
  it('keeps every example below the page h1', async () => {
    const offenders: string[] = [];
    for (const example of await discoverExampleFiles()) {
      const source = await Bun.file(example.filePath).text();
      if (/<h1\b/i.test(source)) offenders.push(example.relativePath);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps rendered Markdown in examples below the page h1', async () => {
    // A `# ` line in an editor's Markdown renders an h1 once the example mounts; the Review
    // Editor's `with-comments` example did. Diff viewers show Markdown as source text, so their
    // `# ` lines never render as headings.
    const sourceOnly = new Set(['diff-viewer']);
    const offenders: string[] = [];
    for (const example of await discoverExampleFiles()) {
      if (sourceOnly.has(example.component)) continue;
      const source = await Bun.file(example.filePath).text();
      // A Markdown h1 starts a line, including the first line of a template literal.
      if (/(?:^|`)# \S/m.test(source)) offenders.push(example.relativePath);
    }

    expect(offenders).toEqual([]);
  });
});
