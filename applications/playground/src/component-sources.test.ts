/**
 * Unit tests for `component-sources.ts`: the Editor CSS-sidecar resolution, the
 * package-root import path every component source reports, and the check that
 * every documented Chat and Editor component has a manifest entry.
 *
 * Regression coverage for a hardcoded `componentName === 'review-editor'`
 * check this file used to have: the real `EDITOR_COMPONENT_SOURCE` cases pin
 * today's component tree, and the temporary-directory cases prove the lookup
 * generalizes beyond the sidecars the real tree currently ships.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHAT_COMPONENT_NAMES,
  CHAT_COMPONENT_SOURCE,
  CINDER_COMPONENT_SOURCE,
  EDITOR_COMPONENT_NAMES,
  EDITOR_COMPONENT_SOURCE,
  componentExportNameFor,
  documentationComponentStylesheetUrl,
  documentationExampleStylesheetUrls,
  resetComponentExportNames,
  resolveEditorStylesheetUrl,
  type ComponentSource,
} from './component-sources.ts';
import { discoverComponents } from './discover.ts';

describe('EDITOR_COMPONENT_SOURCE.componentStylesheetUrl', () => {
  it.each(['diff-review', 'diff-review-comments', 'review-editor'])(
    'resolves %s, which ships a CSS sidecar, against the real component tree',
    (componentName) => {
      expect(EDITOR_COMPONENT_SOURCE.componentStylesheetUrl(componentName)).toBe(
        `/package-components/editor/${componentName}/${componentName}.css`,
      );
    },
  );

  it.each(['markdown-editor', 'diff-viewer'])(
    'returns null for %s, which has no CSS sidecar',
    (componentName) => {
      expect(EDITOR_COMPONENT_SOURCE.componentStylesheetUrl(componentName)).toBeNull();
    },
  );
});

describe('package-root import paths', () => {
  it.each([
    ['Cinder', CINDER_COMPONENT_SOURCE, ['button', 'modal', 'data-table']],
    ['Chat', CHAT_COMPONENT_SOURCE, CHAT_COMPONENT_NAMES],
    ['Editor', EDITOR_COMPONENT_SOURCE, EDITOR_COMPONENT_NAMES],
  ] as const)(
    'returns the %s package root for each of its components',
    (_label, source, componentNames) => {
      for (const componentName of componentNames) {
        expect(source.importPath(componentName)).toBe(source.packageName);
      }
    },
  );

  it('fails closed for a Chat component with no public import path', () => {
    expect(() => CHAT_COMPONENT_SOURCE.importPath('not-exported')).toThrow(
      '[playground] not-exported was discovered in @lostgradient/chat but has no public import path',
    );
  });

  it('fails closed for an Editor component with no public import path', () => {
    expect(() => EDITOR_COMPONENT_SOURCE.importPath('not-exported')).toThrow(
      '[playground] not-exported was discovered in @lostgradient/editor but has no public import path',
    );
  });

  it('returns the package root for every discovered Cinder component', async () => {
    for (const componentName of await discoverComponents()) {
      expect(CINDER_COMPONENT_SOURCE.importPath(componentName)).toBe('@lostgradient/cinder');
    }
  });
});

describe('component manifest completeness', () => {
  async function manifestIds(source: ComponentSource): Promise<Set<string>> {
    const manifest = (await Bun.file(source.manifestPath).json()) as {
      components: { id: string }[];
    };
    return new Set(manifest.components.map((component) => component.id));
  }

  it('lists every documented Chat component in the Chat components.json', async () => {
    const ids = await manifestIds(CHAT_COMPONENT_SOURCE);
    expect(CHAT_COMPONENT_NAMES.filter((name) => !ids.has(name))).toEqual([]);
  });

  it('lists every documented Editor component in the Editor components.json', async () => {
    const ids = await manifestIds(EDITOR_COMPONENT_SOURCE);
    expect(EDITOR_COMPONENT_NAMES.filter((name) => !ids.has(name))).toEqual([]);
  });

  it('reads the export name a package root exposes a component under', () => {
    expect(componentExportNameFor(CINDER_COMPONENT_SOURCE, 'button')).toBe('Button');
    expect(componentExportNameFor(CHAT_COMPONENT_SOURCE, 'chat-composer-popover')).toBe(
      'ChatComposerPopover',
    );
    expect(componentExportNameFor(EDITOR_COMPONENT_SOURCE, 'diff-review-comments')).toBe(
      'DiffReviewComments',
    );
  });

  it('fails closed when a component has no export name in its manifest', () => {
    expect(() => componentExportNameFor(EDITOR_COMPONENT_SOURCE, 'not-in-the-manifest')).toThrow(
      `[playground] not-in-the-manifest has no exportName in ${EDITOR_COMPONENT_SOURCE.manifestPath}`,
    );
  });
});

describe('the manifest export-name cache', () => {
  function manifestWith(exportName: string): string {
    return JSON.stringify({ components: [{ id: 'alpha', exportName }] });
  }

  it('keeps what it read until it is reset, then reads a changed manifest again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'component-export-name-cache-'));
    try {
      const manifestPath = join(directory, 'components.json');
      writeFileSync(manifestPath, manifestWith('Alpha'));
      const source: ComponentSource = {
        ...EDITOR_COMPONENT_SOURCE,
        id: 'export-name-cache-fixture',
        manifestPath,
      };

      expect(componentExportNameFor(source, 'alpha')).toBe('Alpha');
      writeFileSync(manifestPath, manifestWith('Beta'));
      expect(componentExportNameFor(source, 'alpha')).toBe('Alpha');

      resetComponentExportNames();

      expect(componentExportNameFor(source, 'alpha')).toBe('Beta');
    } finally {
      resetComponentExportNames();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('resolveEditorStylesheetUrl', () => {
  it('resolves a sidecar exactly when the component directory ships one', () => {
    const componentsRoot = mkdtempSync(join(tmpdir(), 'editor-stylesheet-sidecars-'));
    try {
      for (const name of ['review-editor', 'diagram-editor', 'markdown-editor']) {
        mkdirSync(join(componentsRoot, name));
      }
      writeFileSync(join(componentsRoot, 'review-editor', 'review-editor.css'), '');
      writeFileSync(join(componentsRoot, 'diagram-editor', 'diagram-editor.css'), '');

      expect(resolveEditorStylesheetUrl(componentsRoot, 'review-editor')).toBe(
        '/package-components/editor/review-editor/review-editor.css',
      );
      expect(resolveEditorStylesheetUrl(componentsRoot, 'diagram-editor')).toBe(
        '/package-components/editor/diagram-editor/diagram-editor.css',
      );
      expect(resolveEditorStylesheetUrl(componentsRoot, 'markdown-editor')).toBeNull();
      expect(resolveEditorStylesheetUrl(componentsRoot, 'absent-editor')).toBeNull();
    } finally {
      rmSync(componentsRoot, { recursive: true, force: true });
    }
  });
});

describe('stylesheets an implementation imports beyond its own sidecar', () => {
  // `markdown-editor.svelte` imports `./prosemirror.css`, the ProseMirror baseline (`white-space`
  // and list rules). It is not `<name>/<name>.css`, so the sidecar lookup cannot see it, and the
  // page bundle drops CSS that JavaScript imports, so the page rendered without it.
  const prosemirrorStylesheet = '/package-components/editor/markdown-editor/prosemirror.css';

  it('links the ProseMirror baseline on the markdown-editor page', () => {
    expect(
      documentationExampleStylesheetUrls(EDITOR_COMPONENT_SOURCE, 'markdown-editor', []),
    ).toContain(prosemirrorStylesheet);
  });

  it('links it where an editor embeds MarkdownEditor, as the review editor does', () => {
    expect(
      documentationExampleStylesheetUrls(EDITOR_COMPONENT_SOURCE, 'review-editor', []),
    ).toContain(prosemirrorStylesheet);
  });

  it('does not link it for an editor that never reaches MarkdownEditor', () => {
    expect(
      documentationExampleStylesheetUrls(EDITOR_COMPONENT_SOURCE, 'diff-viewer', []),
    ).not.toContain(prosemirrorStylesheet);
  });

  it('links the sidecar of a component the documented one composes internally', () => {
    // `diff-review.svelte` renders `DiffReviewComments`, but its examples import only `DiffReview`,
    // so the example-derived set never named the comments component and its sidecar never loaded.
    expect(
      documentationExampleStylesheetUrls(EDITOR_COMPONENT_SOURCE, 'diff-review', []),
    ).toContain('/package-components/editor/diff-review-comments/diff-review-comments.css');
    expect(
      documentationExampleStylesheetUrls(EDITOR_COMPONENT_SOURCE, 'diff-viewer', []),
    ).not.toContain('/package-components/editor/diff-review-comments/diff-review-comments.css');
  });

  it('links the sidecar of a sibling component reached through a relative import', () => {
    const componentsRoot = mkdtempSync(join(tmpdir(), 'implementation-sidecars-'));
    try {
      mkdirSync(join(componentsRoot, 'host'));
      mkdirSync(join(componentsRoot, 'guest'));
      mkdirSync(join(componentsRoot, 'stranger'));
      writeFileSync(
        join(componentsRoot, 'host', 'host.svelte'),
        `<script lang="ts">\n  import Guest from '../guest/guest.svelte';\n</script>\n`,
      );
      writeFileSync(join(componentsRoot, 'guest', 'guest.svelte'), '<p>guest</p>\n');
      for (const path of ['host/host.css', 'guest/guest.css', 'stranger/stranger.css']) {
        writeFileSync(join(componentsRoot, path), '');
      }
      const source = {
        ...EDITOR_COMPONENT_SOURCE,
        componentsRoot,
        componentNames: null,
        componentStylesheetUrl: (name: string) => resolveEditorStylesheetUrl(componentsRoot, name),
      };

      expect(documentationExampleStylesheetUrls(source, 'host', [])).toEqual([
        '/package-components/editor/host/host.css',
        '/package-components/editor/guest/guest.css',
      ]);
    } finally {
      rmSync(componentsRoot, { recursive: true, force: true });
    }
  });

  it('follows relative imports to a non-sidecar stylesheet and ignores everything else', () => {
    const componentsRoot = mkdtempSync(join(tmpdir(), 'implementation-stylesheets-'));
    try {
      mkdirSync(join(componentsRoot, 'widget'));
      mkdirSync(join(componentsRoot, 'engine'));
      writeFileSync(
        join(componentsRoot, 'widget', 'widget.svelte'),
        `<script lang="ts">\n  import Engine from '../engine/engine.svelte';\n  import './widget.css';\n</script>\n`,
      );
      writeFileSync(
        join(componentsRoot, 'engine', 'engine.svelte'),
        `<script lang="ts">\n  import './base.css';\n  import 'package-style.css';\n</script>\n`,
      );
      for (const path of ['widget/widget.css', 'engine/base.css']) {
        writeFileSync(join(componentsRoot, path), '');
      }
      const source = { ...EDITOR_COMPONENT_SOURCE, componentsRoot, componentNames: null };

      // The widget's own sidecar is the sidecar lookup's job; a bare package specifier is not a
      // file the route can serve. Only the imported sibling stylesheet is added here.
      expect(documentationExampleStylesheetUrls(source, 'widget', [])).toEqual([
        '/package-components/editor/engine/base.css',
      ]);
    } finally {
      rmSync(componentsRoot, { recursive: true, force: true });
    }
  });
});

describe('documentationComponentStylesheetUrl', () => {
  it('does not add a second stylesheet for documentation primitives', () => {
    expect(documentationComponentStylesheetUrl(CINDER_COMPONENT_SOURCE, 'button')).toBeNull();
  });

  it('loads only the documented Cinder component outside the shared stylesheet', () => {
    expect(documentationComponentStylesheetUrl(CINDER_COMPONENT_SOURCE, 'dropdown')).toBe(
      '/components/dropdown/dropdown.css',
    );
  });

  it('does not link a headless Cinder component to a nonexistent stylesheet', () => {
    expect(
      documentationComponentStylesheetUrl(CINDER_COMPONENT_SOURCE, 'click-away-listener'),
    ).toBeNull();
  });
});

describe('documentationExampleStylesheetUrls', () => {
  it('adds styles for Cinder components composed by the documented component examples', () => {
    expect(
      documentationExampleStylesheetUrls(CINDER_COMPONENT_SOURCE, 'checkbox-group', [
        'basic',
        'disabled-fieldset',
      ]),
    ).toEqual([
      '/components/checkbox/checkbox.css',
      '/components/checkbox-group/checkbox-group.css',
      '/components/form-field/form-field.css',
    ]);
  });

  it('collects root-barrel imports and recursively follows local implementation modules', () => {
    expect(
      documentationExampleStylesheetUrls(CINDER_COMPONENT_SOURCE, 'autocomplete', [
        'inside-form-field',
      ]),
    ).toContain('/components/form-field/form-field.css');
    expect(
      documentationExampleStylesheetUrls(CINDER_COMPONENT_SOURCE, 'json-schema-editor', []),
    ).toEqual(
      expect.arrayContaining(['/components/tabs/tabs.css', '/components/textarea/textarea.css']),
    );
  });

  it('collects Cinder styles from extracted-package implementation modules', () => {
    expect(documentationExampleStylesheetUrls(EDITOR_COMPONENT_SOURCE, 'diff-viewer', [])).toEqual(
      expect.arrayContaining([
        '/components/segmented-control/segmented-control.css',
        '/components/spinner/spinner.css',
        '/components/surface/surface.css',
      ]),
    );
  });

  it('follows TypeScript barrels to their local Svelte implementations', () => {
    expect(
      documentationExampleStylesheetUrls(EDITOR_COMPONENT_SOURCE, 'markdown-editor', []),
    ).toEqual(
      expect.arrayContaining([
        '/components/dropdown/dropdown.css',
        '/components/toolbar/toolbar.css',
      ]),
    );
  });

  it('recursively follows Cinder components imported by examples', () => {
    expect(
      documentationExampleStylesheetUrls(CINDER_COMPONENT_SOURCE, 'card', ['danger-zone-toggle']),
    ).toEqual(
      expect.arrayContaining([
        '/components/confirm-dialog/confirm-dialog.css',
        '/components/modal/modal.css',
      ]),
    );
  });

  it('loads extracted-package component sidecars imported by examples, not helper-only imports', () => {
    expect(
      documentationExampleStylesheetUrls(CHAT_COMPONENT_SOURCE, 'chat-composer-popover', [
        'slash-commands',
      ]),
    ).toEqual(expect.arrayContaining(['/package-components/chat/chat/chat.css']));
    expect(
      documentationExampleStylesheetUrls(CHAT_COMPONENT_SOURCE, 'chat-conversation-header', [
        'basic',
      ]),
    ).not.toContain('/package-components/chat/chat/chat.css');
  });
});
