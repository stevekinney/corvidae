/**
 * The two HTML documents the theme builder serves.
 *
 * `/theme-builder` is an indexable page with its own canonical URL: an empty mount point
 * plus the workbench bundle. `/theme-builder/preview` is the trusted fixture document the
 * workbench embeds: noindex, no canonical URL, and never in the sitemap.
 */

import {
  absoluteDocumentationUrl,
  documentationMetadataTags,
  escapeHtml,
  FAVICON_HREF,
  normalizedBaseUrl,
  PRE_PAINT_THEME_SCRIPT,
  type DocumentationPageMetadata,
} from './render-shell.ts';

export const THEME_BUILDER_PATH = '/theme-builder';
export const THEME_PREVIEW_PATH = '/theme-builder/preview';

export const THEME_BUILDER_METADATA: DocumentationPageMetadata = {
  canonicalPath: THEME_BUILDER_PATH,
  title: 'Theme builder — Cinder',
  description:
    'Build a Cinder theme: browse every design token, edit it, and preview the result across light, dark, and reduced-motion contexts.',
};

export const THEME_PREVIEW_TITLE = 'Theme preview — Cinder';

export function themeBuilderCanonicalUrl(baseUrl: string): string {
  return absoluteDocumentationUrl(normalizedBaseUrl(baseUrl), THEME_BUILDER_PATH);
}

const BASE_STYLES = `
      *, *::before, *::after { box-sizing: border-box; }
      html { color-scheme: light dark; }
      html, body { margin: 0; padding: 0; min-height: 100%; }
      body {
        background-color: var(--cinder-surface-canvas);
        color: var(--cinder-text-default);
        font-family: var(--cinder-font-sans);
        font-size: var(--cinder-text-base);
        line-height: var(--cinder-leading-normal);
      }`;

export function renderThemeBuilderPage(options: { baseUrl?: string } = {}): string {
  const metadata = THEME_BUILDER_METADATA;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(metadata.title)}</title>
    ${documentationMetadataTags(metadata, options.baseUrl)}
    <link rel="icon" href="${FAVICON_HREF}" />
    <link rel="stylesheet" href="/styles/all.css" />
    <script>${PRE_PAINT_THEME_SCRIPT}</script>
    <style>${BASE_STYLES}
    </style>
  </head>
  <body>
    <div id="theme-builder-root"></div>
    <noscript>The theme builder needs JavaScript.</noscript>
    <script type="module" src="/theme-builder-bundle/theme-builder.js"></script>
  </body>
</html>`;
}

export function renderThemePreviewPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(THEME_PREVIEW_TITLE)}</title>
    <link rel="icon" href="${FAVICON_HREF}" />
    <link rel="stylesheet" href="/styles/all.css" />
    <script>${PRE_PAINT_THEME_SCRIPT}</script>
    <style>${BASE_STYLES}
      body { padding: 16px; }
    </style>
  </head>
  <body>
    <div id="theme-preview-root"></div>
    <script type="module" src="/theme-builder-bundle/theme-preview.js"></script>
  </body>
</html>`;
}
