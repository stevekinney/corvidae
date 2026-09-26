import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  importSvelteOnServer,
  prepareSvelteServerSource,
  renderSvelteOnServer,
} from './svelte-server.ts';

const sourcePath = resolve(import.meta.dir, '../fixtures/svelte-plugin-component.svelte');
const scratchFiles = async () => {
  const names = await readdir(resolve(import.meta.dir, '../../node_modules'));
  return names.filter((name) => name.startsWith('.svelte-ssr-')).toSorted();
};

describe('isolated Svelte server execution', () => {
  test('renders source with the real Svelte server runtime', async () => {
    const before = await scratchFiles();
    const html = await renderSvelteOnServer(sourcePath, { name: 'server' });
    expect(html).toContain('<p>Hello server</p>');
    expect(await scratchFiles()).toEqual(before);
  });

  test('evaluates server components without mounting them', async () => {
    await importSvelteOnServer(sourcePath);
  });

  test('rejects module evaluation that reads browser globals', async () => {
    const before = await scratchFiles();
    const error = await importSvelteOnServer(
      resolve(import.meta.dir, '../fixtures/svelte-server-unsafe.svelte'),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : '').toContain('document is not defined');
    expect(await scratchFiles()).toEqual(before);
  });
  test('rejects props that JSON would silently omit', async () => {
    const error = await renderSvelteOnServer(sourcePath, { name: () => 'lost' }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error instanceof Error ? error.message : '').toContain('Server props must contain data');
  });

  test('preparing a fixture preserves fresh module state for every render', async () => {
    const stateSource = resolve(import.meta.dir, '../fixtures/svelte-server-state.svelte');
    await Promise.all([
      prepareSvelteServerSource(stateSource),
      prepareSvelteServerSource(stateSource),
    ]);
    const first = await renderSvelteOnServer(stateSource);
    const second = await renderSvelteOnServer(stateSource);
    expect(first).toContain('<p>Render 1</p>');
    expect(second).toBe(first);
  });

  test('preparing under explicit conditions compiles the entry those conditions render', async () => {
    const directory = await mkdtemp(
      resolve(import.meta.dir, '../../node_modules/.svelte-prepare-'),
    );
    const source = join(directory, 'prepared.svelte');
    try {
      await Bun.write(source, '<p>prepared</p>');
      await prepareSvelteServerSource(source, { conditions: ['browser', 'svelte'] });
      await Bun.write(source, '<p>edited</p>');

      expect(
        await renderSvelteOnServer(source, {}, { conditions: ['browser', 'svelte'] }),
      ).toContain('<p>prepared</p>');
      expect(await renderSvelteOnServer(source)).toContain('<p>edited</p>');
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
