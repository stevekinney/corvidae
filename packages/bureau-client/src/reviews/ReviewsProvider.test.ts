import { expect, it } from 'bun:test';
import { compile } from 'svelte/compiler';

it('compiles the Reviews provider on both targets', async () => {
  const source = await Bun.file(new URL('./ReviewsProvider.svelte', import.meta.url)).text();
  for (const generate of ['client', 'server'] as const) {
    expect(() => compile(source, { filename: 'ReviewsProvider.svelte', generate })).not.toThrow();
  }
});
