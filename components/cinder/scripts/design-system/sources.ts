/**
 * The component libraries the design system documents and bundles: Cinder, and the editor
 * package, whose editors the bundle loads only when one first mounts, so Milkdown and ProseMirror
 * stay off a canvas until it uses them.
 */

import { join } from 'node:path';

import { buildManifest } from '@lostgradient/component-tooling/scripts/generate-manifest.ts';

import type { BundleSource } from './bundle.ts';
import type { ComponentManifest, ManifestSource } from './manifest.ts';
import { cinderRoot, editorRoot } from './paths.ts';

/**
 * A package's manifest, built from its authored `<name>.meta.json` files the way its `metadata`
 * task builds `.metadata/components.json`, so the design system needs no task run first.
 */
async function readManifest(workspace: string): Promise<ComponentManifest> {
  return buildManifest(workspace);
}

/** Reads Cinder's manifest and the editor's, Cinder first. */
export async function readManifestSources(): Promise<ManifestSource[]> {
  return [
    {
      manifest: await readManifest(cinderRoot),
      componentsDirectory: join(cinderRoot, 'src/components'),
      entry: join(cinderRoot, 'src/index.ts'),
      lazy: false,
    },
    {
      manifest: await readManifest(editorRoot),
      componentsDirectory: join(editorRoot, 'src/lib/components'),
      entry: join(editorRoot, 'src/index.ts'),
      lazy: true,
    },
  ];
}

/** What the bundle exposes from each source: every component in its manifest. */
export function bundleSources(sources: ManifestSource[]): BundleSource[] {
  return sources.map((source) => ({
    entry: source.entry,
    names: source.manifest.components.map((component) => component.exportName),
    lazy: source.lazy,
  }));
}
