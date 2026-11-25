import { expect, it } from 'bun:test';
import { compile } from 'svelte/compiler';

it('compiles the shared control for both hosts', async () => {
  const source = await Bun.file(new URL('./ReviewApprovalButtons.svelte', import.meta.url)).text();
  for (const generate of ['client', 'server'] as const) {
    expect(() =>
      compile(source, { filename: 'ReviewApprovalButtons.svelte', generate }),
    ).not.toThrow();
  }
});
