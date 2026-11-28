import { fileURLToPath } from 'node:url';

/**
 * Bun's `unwasm` condition exposes WebAssembly modules (Shiki's Oniguruma engine) as imports.
 * Bun emits each binary as an asset, and the module's default export instantiates it from that
 * asset's URL, which is the shape consumers of the condition expect.
 */
export const wasmPlugin: Bun.BunPlugin = {
  name: 'browser-wasm',
  setup(builder) {
    builder.onLoad({ filter: /\.wasm$/, namespace: 'file' }, ({ path }) => ({
      loader: 'js',
      contents: `import url from ${JSON.stringify(`wasm-asset:${path}`)};
export default (imports) => WebAssembly.instantiateStreaming(fetch(url), imports);`,
    }));
    builder.onResolve({ filter: /^wasm-asset:/ }, ({ path }) => ({
      // Keep the binary and its JavaScript module distinct in Bun's module graph.
      path: `${path.slice('wasm-asset:'.length)}.binary.wasm`,
      namespace: 'wasm-asset',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'wasm-asset' }, async ({ path }) => ({
      contents: await Bun.file(path.slice(0, -'.binary.wasm'.length)).bytes(),
      loader: 'file',
    }));
  },
};

/** The module the complete Shiki registries are resolved to (`src/lib/curated-shiki-registries.ts`). */
export const CURATED_SHIKI_REGISTRIES = fileURLToPath(
  new URL('../src/lib/curated-shiki-registries.ts', import.meta.url),
);

/**
 * Cinder exports a highlighter over Shiki's complete language and theme registries
 * (`fullShikiHighlighter`), whose lookup tables (`shiki/langs` and `shiki/themes`) make a bundler
 * emit every grammar and theme Shiki ships. `@lostgradient/chat` publishes that highlighter for
 * every code block in a transcript, so the registries are reachable and Chat does use them: it
 * highlights each tool call's JSON arguments and result with it. Both specifiers are therefore
 * resolved to a module that holds curated tables (`src/lib/curated-shiki-registries.ts`): the
 * grammars and themes the application already ships, and nothing else. Tables that were empty
 * would keep the bundle small and break the highlighter, which renders every block as plain text
 * with a console warning.
 */
export const curatedShikiPlugin: Bun.BunPlugin = {
  name: 'curated-shiki',
  setup(builder) {
    builder.onResolve({ filter: /^shiki\/(?:langs|themes)$/ }, () => ({
      path: CURATED_SHIKI_REGISTRIES,
    }));
  },
};
