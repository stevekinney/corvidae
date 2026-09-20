import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import { buildOutputDirectory } from './scripts/build-output.ts';
import { shikiGrammarAssets } from './scripts/shiki-grammar-assets.ts';

export default defineConfig({
  // Let Vite load the original WebAssembly asset instead of base64 JavaScript.
  resolve: {
    alias: [
      {
        find: /^shiki\/wasm$/,
        replacement: createRequire(import.meta.url).resolve('shiki/onig.wasm') + '?init',
      },
    ],
  },
  // Bun loads server runtimes from their owning workspaces. Native drivers and
  // lazy provider SDKs then resolve beside the package that declares them, and
  // shared runtime classes retain one identity across the application.
  environments: {
    ssr: {
      build: {
        rolldownOptions: {
          external: [
            '@corvidae/armorer',
            '@corvidae/conversationalist',
            '@corvidae/operative',
            '@corvidae/weft',
          ],
        },
      },
    },
  },
  plugins: [
    shikiGrammarAssets(),
    sveltekit({
      // Keep validation builds from replacing an active browser suite's assets.
      outDir: buildOutputDirectory(),
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },

      // adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
      // If your environment is not supported, or you settled on a specific environment, switch out the adapter.
      // See https://svelte.dev/docs/kit/adapters for more information about adapters.
      adapter: adapter(),
    }),
  ],
});
