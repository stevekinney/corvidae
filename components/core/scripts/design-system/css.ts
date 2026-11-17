/**
 * Builds the design system's `components/bundle.css`: Cinder's `all.css` with every `@import`
 * inlined exactly, the editor components' own stylesheets, and the layout the preview cards use.
 *
 * Bun's CSS bundler is deliberately not used: it lowers `light-dark()`, which breaks switching
 * themes with `data-theme`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const IMPORT = /^@import\s+'([^']+)'(?:\s+layer\(([^)]+)\))?\s*;\s*$/gm;

/**
 * Inlines a stylesheet's `@import '…'` lines, recursively, wrapping each `layer(…)` import in
 * its `@layer` block. A file imported twice is inlined once, at its first import.
 */
export function inlineImports(entry: string, seen = new Set<string>()): string {
  if (seen.has(entry)) return '';
  seen.add(entry);
  const text = readFileSync(entry, 'utf8');
  return text.replace(IMPORT, (_line, relative: string, layer: string | undefined) => {
    const body = inlineImports(resolve(dirname(entry), relative), seen);
    return layer ? `@layer ${layer} {\n${body}\n}` : body;
  });
}

/**
 * The layout of a preview card, after the playground's component page. `.ds-example` needs
 * `grid-template-columns: minmax(0, 1fr)`: an implicit `auto` column lets a component that sizes
 * itself from its container, such as ResizablePanels, grow the column without end.
 */
export const PREVIEW_LAYOUT_CSS = `
/* Preview layout for the design-system cards (from the playground's component page). */
.ds-example { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--cinder-space-2); padding: var(--cinder-space-4); border-block-end: 1px solid var(--cinder-border-muted); }
.ds-example:last-child { border-block-end: 0; }
.ds-example__title { margin: 0; font: var(--cinder-font-medium) var(--cinder-text-xs, 0.75rem) / 1.4 var(--cinder-font-sans); color: var(--cinder-text-muted); letter-spacing: 0.02em; }
.example-preview { display: block; min-width: 0; min-height: 2rem; }
.example-preview .example-preview-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--cinder-space-4); }
.example-preview .example-preview-column { display: flex; flex-direction: column; align-items: flex-start; gap: var(--cinder-space-4); }
`;

/**
 * The stylesheets in each listed component's folder, in id order and then file-name order: the
 * styles a library's components import from their scripts, which a bundled preview drops.
 */
export function componentStylesheets(componentsDirectory: string, ids: string[]): string[] {
  return ids.flatMap((id) => {
    const directory = join(componentsDirectory, id);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((file) => file.endsWith('.css'))
      .toSorted()
      .map((file) => join(directory, file));
  });
}

/**
 * Builds the bundle from a stylesheet entry and any further stylesheets, each inlined after it,
 * failing on an unresolved import or a `</style`.
 */
export function buildBundleCss(entry: string, stylesheets: string[] = []): string {
  const seen = new Set<string>();
  const css =
    inlineImports(entry, seen) +
    stylesheets.map((stylesheet) => inlineImports(stylesheet, seen)).join('') +
    PREVIEW_LAYOUT_CSS;
  if (/^\s*@import\s/m.test(css)) throw new Error('bundle.css still holds an @import');
  if (/<\/style/i.test(css)) throw new Error('bundle.css holds a </style');
  return css;
}
