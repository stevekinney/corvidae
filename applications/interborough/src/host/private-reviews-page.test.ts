import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

test('the private Reviews document compiles for server and browser', async () => {
  const source = await Bun.file(
    new URL('../private-routes/reviews/+page.svelte', import.meta.url),
  ).text();
  for (const generate of ['server', 'client'] as const) {
    expect(() => compile(source, { filename: '+page.svelte', generate })).not.toThrow();
  }
});
