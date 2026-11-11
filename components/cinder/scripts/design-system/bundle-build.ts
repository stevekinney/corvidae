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
    },
    plugins: [sveltePlugin({ generate: 'client', injectCss: true })],
    loader: { '.css': 'css' },
    throw: false,
  });
  if (!result.success) return new Error(result.logs.map(String).join(' | ').slice(0, 400));
  const output = result.outputs.find((artifact) => artifact.path.endsWith('.js'));
  if (!output) return new Error('the bundle produced no script');
  return output.text();
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
