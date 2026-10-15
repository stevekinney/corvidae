import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

/**
 * Examples render inside a documentation page, which owns the page's one `h1` (the component
 * name). An example that brings its own `h1` gives the exported page two, which the static
 * production gate rejects; `container/basic` did exactly that.
 */
describe('example heading levels', () => {
  it('keeps every example below the page h1', async () => {
    const examplesRoot = join(import.meta.dirname, 'examples');
    const offenders: string[] = [];
    for await (const path of new Bun.Glob('**/*.example.svelte').scan({ cwd: examplesRoot })) {
      const source = await Bun.file(join(examplesRoot, path)).text();
      if (/<h1\b/i.test(source)) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps rendered Markdown in examples below the page h1', async () => {
    // A `# ` line in an editor's Markdown renders an h1 once the example mounts; the Review
    // Editor's `with-comments` example did. Diff viewers show Markdown as source text, so their
    // `# ` lines never render as headings.
    const examplesRoot = join(import.meta.dirname, 'examples');
    const sourceOnly = new Set(['diff-viewer']);
    const offenders: string[] = [];
    for await (const path of new Bun.Glob('**/*.example.svelte').scan({ cwd: examplesRoot })) {
      if (sourceOnly.has(path.split('/')[0]!)) continue;
      const source = await Bun.file(join(examplesRoot, path)).text();
      // A Markdown h1 starts a line, including the first line of a template literal.
      if (/(?:^|`)# \S/m.test(source)) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });
});
