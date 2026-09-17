import { plugin } from 'bun';
import { beforeAll, describe, expect, test } from 'bun:test';

import { compileSvelteComponentForBun, sveltePlugin } from './svelte-plugin.ts';

beforeAll(async () => {
  await plugin(sveltePlugin({ generate: 'client' }));
});

describe('sveltePlugin', () => {
  test('executes a real Svelte component through Bun dynamic import', async () => {
    const module = await import('./fixtures/svelte-plugin-component.svelte');
    expect(typeof module.default).toBe('function');
  });

  test('executes a real rune module through Bun dynamic import', async () => {
    const module = await import('./fixtures/svelte-plugin-counter.svelte.ts');
    const counter = new module.Counter();

    counter.increment();

    expect(counter.count).toBe(1);
  });

  test('compiles a real Svelte component for server output', async () => {
    const fixturePath = `${import.meta.dir}/fixtures/svelte-plugin-component.svelte`;
    const result = compileSvelteComponentForBun(
      await Bun.file(fixturePath).text(),
      fixturePath,
      { generate: 'server', injectCss: false },
      {},
    );

    expect(result.loader).toBe('js');
    expect(result.contents).toContain('export default');
  });
});
