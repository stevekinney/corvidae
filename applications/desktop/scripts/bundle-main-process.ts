#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.dirname(import.meta.dir);

/**
 * Where the pre-bundled main process lands, relative to the project root.
 *
 * `electrobun.config.ts` points `build.bun.entrypoint` at this path when
 * `DESKTOP_PREBUNDLED_MAIN` is set, and `tests/unit/main-process-bundle.test.ts`
 * fails if the two ever disagree. It sits outside `dist/` because the renderer
 * build empties that directory.
 */
export const mainProcessBundlePath = '.main-bundle/index.js';

export const mainProcessEntrypoint = 'src/bun/index.ts';

/**
 * Left for Electrobun's own build to resolve.
 *
 * `bun` and `bun:ffi` are the runtime, and the `electrobun` specifiers are
 * aliased into `.hutch/devkit` by the build that consumes this file. Bundling
 * them here would inline a second copy of the SDK under a different path.
 */
export const mainProcessExternals = ['bun', 'bun:ffi', 'electrobun', 'electrobun/*'] as const;

/**
 * Bundles the Bun main process with Bun's own bundler.
 *
 * Electrobun 2 bundles `bun.entrypoint` with Cottontail's `Bun.build`, and on
 * this graph (COR-1389, blackboardsh/electrobun#564) that native bundler
 * segfaults intermittently: 12 of 960 runs against the real entrypoint, 0 of 960
 * once Bun had already collapsed it to a single file. The options match the
 * ones Electrobun hands `Bun.build` (`target: 'node'`, ESM), so module
 * resolution is unchanged; only the bundler that walks the module graph is.
 *
 * Throws on any build failure rather than writing a partial file.
 */
export async function bundleMainProcess({
  entrypoint = path.join(projectRoot, mainProcessEntrypoint),
  outputPath = path.join(projectRoot, mainProcessBundlePath),
}: { entrypoint?: string; outputPath?: string } = {}): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'node',
    format: 'esm',
    external: [...mainProcessExternals],
  });

  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join('\n');
    throw new Error(`Bundling ${entrypoint} failed.\n${messages}`);
  }

  // With no `outdir`, Bun returns the outputs in memory instead of writing them.
  // Asset imports reachable from the graph (stylesheets, Svelte sources) come
  // back as extra outputs. Nothing in the main process loads them, and the
  // entry point never references them, so only the entry point is written.
  const entry = result.outputs.find((output) => output.kind === 'entry-point');
  if (entry === undefined) {
    throw new Error(`Bundling ${entrypoint} produced no entry-point output.`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, entry);
  return outputPath;
}

if (import.meta.main) {
  const outputPath = await bundleMainProcess();
  console.log(`Bundled the main process to ${path.relative(projectRoot, outputPath)}.`);
}
