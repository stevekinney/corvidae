import { expect, it } from 'bun:test';
import { compile } from 'svelte/compiler';

it('compiles the Reviews scope on both targets', async () => {
  const source = await Bun.file(new URL('./ReviewsScope.svelte', import.meta.url)).text();
  for (const generate of ['client', 'server'] as const) {
    expect(() => compile(source, { filename: 'ReviewsScope.svelte', generate })).not.toThrow();
  }
});
