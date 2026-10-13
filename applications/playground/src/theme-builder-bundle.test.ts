/**
 * The theme builder is lazily loaded: no documentation route's bundle graph may contain
 * any of its modules. The graphs are walked the way a browser does, through every import
 * specifier, and a marker that only the builder's message protocol contains proves the
 * check is not vacuous (the builder's own graphs must contain it).
 *
 * Every graph is fetched and built at module scope, which Bun does not time, and the tests
 * assert on the captured sources (the COR-1427 pattern): a cold bundle build takes seconds
 * under host load, which timed these tests out inside Bun's 5-second budget. The featured
 * example is a stand-in for the same reason; only the page HTML around it matters here.
 */

import { describe, expect, it } from 'bun:test';

import { setFeaturedExampleRenderer } from './featured-example-server-renderer.ts';
import { handleRequest } from './playground-server.ts';
import {
  isThemeBuilderEntryName,
  resetThemeBuilderBundles,
  THEME_BUILDER_ENTRY_SOURCES,
} from './theme-builder-bundle.ts';

const ORIGIN = 'https://playground.local';
const BUNDLE_REFERENCE = /\/(?:page|shell|theme-builder)-bundle\/[A-Za-z0-9_-]+\.js/g;

/** Strings that only the builder's modules contain. */
const BUILDER_MARKERS = ['theme-preview:apply', 'theme-preview:ready', 'cinder-theme-preview'];

async function graphSource(entryPath: string): Promise<string> {
  const seen = new Set<string>();
  const queue = [entryPath];
  const sources: string[] = [];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const response = await handleRequest(new Request(`${ORIGIN}${path}`));
    if (response.status !== 200)
      throw new Error(`[bundle.test] ${path} answered ${response.status}`);
    const source = await response.text();
    sources.push(source);
    for (const reference of source.matchAll(BUNDLE_REFERENCE)) queue.push(reference[0]);
  }
  return sources.join('\n');
}

setFeaturedExampleRenderer(async (componentName, scenario) => ({
  body: `<p data-test-featured-example="${componentName}/${scenario}">Featured</p>`,
  head: '',
}));

const DOCUMENTATION_ENTRIES = [
  '/shell-bundle/shell.js',
  '/page-bundle/button.js',
  '/page-bundle/modal.js',
];
const DOCUMENTATION_PAGES = ['/', '/page/button', '/page/modal'];

const documentationGraphs = new Map<string, string>();
for (const entry of DOCUMENTATION_ENTRIES) documentationGraphs.set(entry, await graphSource(entry));

const documentationPages = new Map<string, string>();
for (const path of DOCUMENTATION_PAGES) {
  const response = await handleRequest(new Request(`${ORIGIN}${path}`));
  documentationPages.set(path, await response.text());
}

const builderGraph = await graphSource('/theme-builder-bundle/theme-builder.js');
const previewGraph = await graphSource('/theme-builder-bundle/theme-preview.js');

resetThemeBuilderBundles();
const rebuiltBuilder = await handleRequest(
  new Request(`${ORIGIN}/theme-builder-bundle/theme-builder.js`),
);
const rebuiltBuilderStatus = rebuiltBuilder.status;
const rebuiltBuilderSource = await rebuiltBuilder.text();

describe('lazy loading of the theme builder', () => {
  it('keeps every builder module out of the documentation bundle graphs', () => {
    for (const entry of DOCUMENTATION_ENTRIES) {
      const source = documentationGraphs.get(entry)!;
      expect(source.length).toBeGreaterThan(0);
      for (const marker of BUILDER_MARKERS) expect(source).not.toContain(marker);
      expect(source).not.toContain('/theme-builder-bundle/');
      expect(source).not.toMatch(/theme-workbench|theme-preview-/);
    }
  });

  it('keeps every documentation page free of builder bundle references, except the nav entry', () => {
    for (const path of DOCUMENTATION_PAGES) {
      const html = documentationPages.get(path)!;
      expect(html).not.toContain('/theme-builder-bundle/');
      // The only trace of the builder on a documentation page is the link to its route.
      expect(html).toContain('href="/theme-builder"');
    }
  });

  it('puts the message protocol in the builder bundles, so the check above is not vacuous', () => {
    for (const marker of BUILDER_MARKERS) {
      expect(builderGraph).toContain(marker);
      expect(previewGraph).toContain(marker);
    }
  });

  it('builds both entries together and shares their common code as chunks', () => {
    expect(rebuiltBuilderStatus).toBe(200);
    expect(Object.keys(THEME_BUILDER_ENTRY_SOURCES).every(isThemeBuilderEntryName)).toBe(true);
    expect(rebuiltBuilderSource.match(/\/theme-builder-bundle\/chunk-/g)?.length).toBeGreaterThan(
      0,
    );
  });
});
