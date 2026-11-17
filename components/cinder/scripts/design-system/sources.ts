/**
 * The component libraries the design system documents and bundles: Cinder, and the editor
 * package, whose editors the bundle loads only when one first mounts, so Milkdown and ProseMirror
 * stay off a canvas until it uses them.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BundleSource } from './bundle.ts';
import type { ComponentManifest, ManifestSource } from './manifest.ts';
import { cinderRoot, editorRoot } from './paths.ts';

/**
 * The directory holding component `id`'s folder: the source's components directory, or, for a
 * Cinder component the split moved into a package of its own (P-COR-101), that package's, as the
 * manifest's `source` names it.
 */
export function componentsDirectoryOf(source: ManifestSource, id: string): string {
  const entry = source.manifest.components.find((component) => component.id === id) as
    { source?: { packageRoot?: unknown; directory?: unknown } } | undefined;
  const located = entry?.source;
  if (typeof located?.packageRoot !== 'string' || typeof located.directory !== 'string') {
    return source.componentsDirectory;
  }
  return dirname(join(dirname(dirname(source.entry)), located.packageRoot, located.directory));
}

function readManifest(workspace: string): ComponentManifest {
  return JSON.parse(
    readFileSync(join(workspace, '.metadata', 'components.json'), 'utf8'),
  ) as ComponentManifest;
}

/** Reads Cinder's manifest and the editor's, Cinder first. */
export function readManifestSources(): ManifestSource[] {
  return [
    {
      manifest: readManifest(cinderRoot),
      componentsDirectory: join(cinderRoot, 'src/components'),
      entry: join(cinderRoot, 'src/index.ts'),
      lazy: false,
    },
    {
      manifest: readManifest(editorRoot),
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
