/**
 * The design system's page-archetype previews: one full-page card per archetype, written as
 * static HTML from Cinder's own class-level markup and styled by `bundle.css`. Each page is a
 * checked-in file under `assets/archetypes/`; the shared page layout in `archetype.css` is
 * inlined into each one so the card is a single document.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The group the archetype cards appear under in the Design System frame. */
export const ARCHETYPES_GROUP = 'Page archetypes';
/** Where a page's `<head>` takes the shared layout; every page holds it exactly once. */
export const ARCHETYPE_STYLES_MARKER = '<!-- archetype-styles -->';
/** The shared page layout, beside the pages. */
export const ARCHETYPE_STYLESHEET = 'archetype.css';

/** One archetype card as published: `components/<exportName>/preview.html`. */
export type ArchetypePreview = {
  /** The page's file name without its extension, such as `browse`. */
  id: string;
  /** The card's folder name, such as `ArchetypeBrowse`. */
  exportName: string;
  /** The finished document. */
  html: string;
};

/** The card folder for an archetype id: `browse` becomes `ArchetypeBrowse`, `focus-list` `ArchetypeFocusList`. */
export function archetypeExportName(id: string): string {
  const words = id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return `Archetype${words.join('')}`;
}

/**
 * Inlines the shared layout into a page, failing when the page lacks the marker or repeats it, has
 * no literal `<head>` for the render check to link the system stylesheets into, or does not start
 * with its `@dsCard` marker, or when the stylesheet would end its own `<style>`.
 */
export function archetypePreviewHtml(source: string, css: string): string {
  const parts = source.split(ARCHETYPE_STYLES_MARKER);
  if (parts.length !== 2) {
    throw new Error(`an archetype page holds ${ARCHETYPE_STYLES_MARKER} exactly once`);
  }
  if (!source.includes('<head>')) throw new Error('an archetype page needs a literal <head>');
  if (!source.startsWith(`<!-- @dsCard group="${ARCHETYPES_GROUP}" `)) {
    throw new Error(
      `an archetype page starts with its @dsCard marker, group "${ARCHETYPES_GROUP}"`,
    );
  }
  if (/<\/style/i.test(css)) throw new Error('the archetype stylesheet holds a </style');
  return `${parts[0]}<style>\n${css}</style>${parts[1]}`;
}

/** Reads every archetype page in `directory`, in file-name order, with the shared layout inlined. */
export function readArchetypePreviews(directory: string): ArchetypePreview[] {
  const css = readFileSync(join(directory, ARCHETYPE_STYLESHEET), 'utf8');
  return readdirSync(directory)
    .filter((file) => file.endsWith('.html'))
    .toSorted()
    .map((file) => {
      const id = file.slice(0, -'.html'.length);
      return {
        id,
        exportName: archetypeExportName(id),
        html: archetypePreviewHtml(readFileSync(join(directory, file), 'utf8'), css),
      };
    });
}
