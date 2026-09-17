import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^shiki\/wasm$/,
        replacement: createRequire(import.meta.url).resolve('shiki/onig.wasm') + '?init',
      },
    ],
  },
  plugins: [svelte({ configFile: false })],
  build: { target: 'es2022', outDir: 'build' },
});
