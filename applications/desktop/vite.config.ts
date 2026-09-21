import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import { electrobunViteAliases } from './.hutch/devkit/api/config/electrobun-vite.ts';

/**
 * `.hutch/devkit` is projected by `electrobun prepare`, not committed, so this
 * configuration only resolves after that step has run. Every task that reads it
 * declares `prepare` as a dependency in `turbo.json` for exactly that reason.
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: electrobunViteAliases(resolve(import.meta.dirname, '.hutch/devkit')),
  },
  root: 'src/views/main',
  build: {
    outDir: '../../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
