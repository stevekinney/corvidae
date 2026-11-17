import { describe, expect, test } from 'bun:test';

import {
  categoryLabel,
  type ComponentManifest,
  type ManifestComponent,
  type ManifestSource,
  mergeManifests,
} from './manifest.ts';
import { bundleSources, readManifestSources } from './sources.ts';

function component(id: string, exportName: string, category = 'domain'): ManifestComponent {
  return {
    id,
    exportName,
    import: '@lostgradient/cinder',
    category,
    status: 'stable',
    purpose: `${exportName} purpose`,
  };
}

function source(
  manifest: ComponentManifest,
  componentsDirectory: string,
  lazy = false,
): ManifestSource {
  return { manifest, componentsDirectory, entry: `${componentsDirectory}/index.ts`, lazy };
}

const cinder = source(
  {
    package: { tokenNamespaces: ['button'] },
    categories: { action: { label: 'Actions' }, domain: { label: 'Domain' } },
    components: [component('button', 'Button', 'action'), component('card', 'Card')],
  },
  '/cinder/src/components',
);
const editor = source(
  {
    package: { tokenNamespaces: ['editor'] },
    categories: { domain: { label: 'Editor domain' }, editing: { label: 'Editing' } },
    components: [component('markdown-editor', 'MarkdownEditor', 'editing')],
  },
  '/editor/src/lib/components',
  true,
);

describe('mergeManifests', () => {
  test('lists every source’s components in order and records each one’s source', () => {
    const { manifest, sources } = mergeManifests([cinder, editor]);
    expect(manifest.components.map((entry) => entry.exportName)).toEqual([
      'Button',
      'Card',
      'MarkdownEditor',
    ]);
    expect(manifest.package).toBe(cinder.manifest.package);
    expect(sources.get('card')).toBe(cinder);
    expect(sources.get('markdown-editor')).toBe(editor);
  });

  test('keeps the first label of a shared category and adds new ones', () => {
    const { manifest } = mergeManifests([cinder, editor]);
    expect(categoryLabel(manifest, 'domain')).toBe('Domain');
    expect(categoryLabel(manifest, 'editing')).toBe('Editing');
  });

  test('refuses a component id or export name two sources share, and no sources', () => {
    const sameId = source(
      { ...editor.manifest, components: [component('card', 'EditorCard')] },
      '/editor',
    );
    expect(() => mergeManifests([cinder, sameId])).toThrow('two manifests define component card');
    const sameExport = source(
      { ...editor.manifest, components: [component('editor-card', 'Card')] },
      '/editor',
    );
    expect(() => mergeManifests([cinder, sameExport])).toThrow('two manifests export Card');
    expect(() => mergeManifests([])).toThrow('no component manifests');
  });
});

describe('the design system’s sources', () => {
  test('read Cinder eagerly, then the editor package lazily', () => {
    const [cinderSource, editorSource, ...rest] = readManifestSources();
    expect(rest).toEqual([]);
    expect(cinderSource?.lazy).toBe(false);
    expect(cinderSource?.entry).toEndWith('components/cinder/src/index.ts');
    expect(editorSource?.lazy).toBe(true);
    expect(editorSource?.entry).toEndWith('components/editor/src/index.ts');
    expect(editorSource?.componentsDirectory).toEndWith('components/editor/src/lib/components');
  });

  test('merge without a clash and bundle the editors behind the lazy source', () => {
    const sources = readManifestSources();
    const { manifest } = mergeManifests(sources);
    const names = manifest.components.map((entry) => entry.exportName);
    for (const name of [
      'Button',
      'Card',
      'Modal',
      'MarkdownEditor',
      'ReviewEditor',
      'DiffViewer',
    ]) {
      expect(names).toContain(name);
    }
    for (const entry of manifest.components) {
      expect(() => categoryLabel(manifest, entry.category)).not.toThrow();
    }
    const lazy = bundleSources(sources).find((entry) => entry.lazy);
    expect(lazy?.names).toEqual(
      expect.arrayContaining(['MarkdownEditor', 'ReviewEditor', 'DiffViewer']),
    );
    expect(lazy?.names).not.toContain('Button');
  });
});
