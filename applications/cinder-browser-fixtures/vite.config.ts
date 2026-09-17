import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

import { shikiGrammarAssets } from '../../scripts/shiki-grammar-assets.ts';
import { fixtureHostPlugin } from './src/server.ts';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^shiki\/wasm$/,
        replacement: createRequire(import.meta.url).resolve('shiki/onig.wasm') + '?init',
      },
    ],
  },
  plugins: [shikiGrammarAssets(), svelte(), fixtureHostPlugin()],
  build: { outDir: 'build' },
});
