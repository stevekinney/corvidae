import { rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSveltePlugin } from '@lostgradient/velveteen/compiler';

import { BUILD_COMMIT_VARIABLE } from '../src/host/build-info.ts';

/** The directory, relative to the build root, that holds every file `index.html` loads. */
export const BUILD_ASSET_DIRECTORY = 'assets';

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

/**
 * The `Bun.build` options every browser build of the application shares: the development host
 * and the production build differ only in `development`, in minification, and in where the files
 * land.
 */
export function browserBuildOptions(options: {
  readonly entrypoints: string[];
  readonly outdir: string;
  readonly development: boolean;
  readonly sveltePlugin?: Bun.BunPlugin;
  /** What the page shows as the commit it was built from (`displayedCommit`); omitted, it shows none. */
  readonly commit?: string;
}): Bun.BuildConfig & { readonly metafile: true } {
  return {
    entrypoints: options.entrypoints,
    outdir: options.outdir,
    conditions: ['browser', 'svelte', 'unwasm'],
    define: {
      'process.env.NODE_ENV': JSON.stringify(options.development ? 'development' : 'production'),
      ...(options.commit === undefined
        ? {}
        : { [BUILD_COMMIT_VARIABLE]: JSON.stringify(options.commit) }),
    },
    format: 'esm',
    publicPath: '/',
    target: 'browser',
    plugins: [
      wasmPlugin,
      curatedShikiPlugin,
      options.sveltePlugin ??
        createSveltePlugin({
          target: 'client',
          css: 'injected',
          development: options.development,
          hmr: false,
        }),
    ],
    optimizeImports: ['@lostgradient/cinder'],
    // Development links a map beside each chunk so the browser shows the original source;
    // production ships none.
    sourcemap: options.development ? 'linked' : 'none',
    splitting: true,
    metafile: true,
    naming: {
      entry: '[name].[ext]',
      chunk: `${BUILD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
      asset: `${BUILD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
    },
  };
}

/**
 * Fail on a build that did not succeed, logged a warning, or produced no metafile. Warnings fail
 * the build because a warning from the Svelte compiler or the bundler is a defect here.
 */
export function assertCleanBuild(result: Bun.BuildOutput): Bun.BuildMetafile {
  if (!result.success) throw new AggregateError(result.logs, 'Browser compilation failed');
  const warnings = result.logs.filter((message) => message.level === 'warning');
  if (warnings.length > 0) {
    throw new AggregateError(warnings, 'Browser compilation emitted warnings');
  }
  if (result.metafile === undefined) {
    throw new Error('Browser compilation did not emit module provenance');
  }
  return result.metafile;
}

/** The `href` of every `<link rel="stylesheet">` in `html`. */
export function linkedStylesheets(html: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    if (!/\brel="stylesheet"/.test(tag)) continue;
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href !== undefined) hrefs.push(href);
  }
  return hrefs;
}

/**
 * Delete the stylesheets (and their source maps) that `index.html` does not link, and return the
 * files that remain. Bun makes one CSS bundle per JavaScript entry or dynamically imported chunk,
 * and each bundle is the whole CSS graph reachable from that chunk, so Cinder's token block and
 * every shared layer are emitted once per lazy route. Nothing loads those bundles: no chunk
 * imports them and the page links only the one the HTML entry produces, which already holds the
 * CSS of every lazily imported module, because the entry's graph reaches through dynamic imports.
 * Component `<style>` blocks are not in any of these files: the Svelte plugin injects them into
 * the JavaScript of the component that owns them.
 */
export async function pruneUnlinkedStylesheets(
  staging: string,
  files: readonly string[],
): Promise<string[]> {
  if (!files.includes('index.html')) return [...files];
  const html = await Bun.file(join(staging, 'index.html')).text();
  const linked = new Set(
    linkedStylesheets(html).map((href) => relative('/', href).split(sep).join('/')),
  );
  const unlinked = new Set(files.filter((file) => file.endsWith('.css') && !linked.has(file)));
  for (const stylesheet of unlinked) {
    await rm(join(staging, stylesheet), { force: true });
    await rm(join(staging, `${stylesheet}.map`), { force: true });
  }
  return files.filter((file) => !unlinked.has(file) && !unlinked.has(file.replace(/\.map$/, '')));
}
