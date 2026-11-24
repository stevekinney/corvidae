import { expect, it } from 'bun:test';
import { compileModule } from 'svelte/compiler';

it('compiles the reactive read module with the installed Svelte compiler', async () => {
  const source = await Bun.file(new URL('./read.svelte.ts', import.meta.url)).text();
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  expect(() =>
    compileModule(javascript, { filename: 'read.svelte.js', generate: 'client' }),
  ).not.toThrow();
  expect(() =>
    compileModule(javascript, { filename: 'read.svelte.js', generate: 'server' }),
  ).not.toThrow();
});
