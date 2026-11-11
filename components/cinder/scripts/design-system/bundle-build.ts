/**
 * Builds browser scripts for the design system: each preview's script, and the shared
 * `components/bundle.js`.
 */

import { sveltePlugin } from '@lostgradient/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bundleEntrySource, type BundleSource, finishBundle } from './bundle.ts';

/** The module the bundle's entry imports its runtime from. */
export const BUNDLE_RUNTIME = join(import.meta.dir, 'bundle-runtime.svelte.ts');

/**
 * Bundles an entry module into one minified IIFE for the browser, with Svelte compiled for the
 * client and each component's styles injected, returning the script or the reason it failed.
 * A stylesheet the modules import is bundled separately and dropped; `bundle.css` carries it.
 */
export async function bundleBrowserScript(entry: string): Promise<string | Error> {
  const result = await Bun.build({
    entrypoints: [entry],
    format: 'iife',
    target: 'browser',
    minify: true,
    conditions: ['browser', 'svelte'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.DEV': 'false',
      'import.meta.env.SSR': 'false',
      // A classic script cannot say `import.meta` at all: it is a syntax error that stops the
      // whole bundle. The one use is a module worker's address, which no base resolves here, so
      // the caller's own fallback (render on the main thread) runs.
      'import.meta.url': '"about:blank"',
    },
    // Compiled for production whatever NODE_ENV the build runs under: a development compile
    // embeds a base64 source map, with the component's whole source, in every injected stylesheet,
    // which multiplied the editors' captured styles past the static rendition cap.
    plugins: [sveltePlugin({ generate: 'client', injectCss: true, development: false })],
    loader: { '.css': 'css' },
    throw: false,
  });
  if (!result.success) return new Error(result.logs.map(String).join(' | ').slice(0, 400));
  const output = result.outputs.find((artifact) => artifact.path.endsWith('.js'));
  if (!output) return new Error('the bundle produced no script');
  const script = await output.text();
  if (script.includes('import.meta')) {
    return new Error('the bundle still says import.meta, which a classic script cannot parse');
  }
  if (script.includes('sourceMappingURL=data:')) {
    return new Error('the bundle embeds a source map, which a published script must not carry');
  }
  return script;
}

/**
 * Builds `components/bundle.js` from its sources, writing the entry module into
 * `entryDirectory`, and returns the finished script.
 */
export async function buildComponentBundle(
  sources: BundleSource[],
  entryDirectory: string,
): Promise<string> {
  mkdirSync(entryDirectory, { recursive: true });
  const entry = join(entryDirectory, 'bundle-entry.ts');
  writeFileSync(entry, bundleEntrySource(BUNDLE_RUNTIME, sources));
  const code = await bundleBrowserScript(entry);
  if (code instanceof Error) throw new Error(`bundle.js: ${code.message}`);
  return finishBundle(
    code,
    sources.flatMap((source) => source.names),
  );
}
