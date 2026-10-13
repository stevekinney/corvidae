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
});
