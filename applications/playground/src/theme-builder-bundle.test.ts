/**
 * The theme builder is lazily loaded: no documentation route's bundle graph may contain
 * any of its modules. The graphs are walked the way a browser does, through every import
 * specifier, and a marker that only the builder's message protocol contains proves the
 * check is not vacuous (the builder's own graphs must contain it).
 */

import { describe, expect, it } from 'bun:test';

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
    expect(response.status).toBe(200);
    const source = await response.text();
    sources.push(source);
    for (const reference of source.matchAll(BUNDLE_REFERENCE)) queue.push(reference[0]);
  }
  return sources.join('\n');
}

describe('lazy loading of the theme builder', () => {
  it('keeps every builder module out of the documentation bundle graphs', async () => {
    for (const entry of [
      '/shell-bundle/shell.js',
      '/page-bundle/button.js',
      '/page-bundle/modal.js',
    ]) {
      const source = await graphSource(entry);
      expect(source.length).toBeGreaterThan(0);
      for (const marker of BUILDER_MARKERS) expect(source).not.toContain(marker);
      expect(source).not.toContain('/theme-builder-bundle/');
      expect(source).not.toMatch(/theme-workbench|theme-preview-/);
    }
  });

  it('keeps every documentation page free of builder bundle references, except the nav entry', async () => {
    for (const path of ['/', '/page/button', '/page/modal']) {
      const response = await handleRequest(new Request(`${ORIGIN}${path}`));
      const html = await response.text();
      expect(html).not.toContain('/theme-builder-bundle/');
      // The only trace of the builder on a documentation page is the link to its route.
      expect(html).toContain('href="/theme-builder"');
    }
  });

  it('puts the message protocol in the builder bundles, so the check above is not vacuous', async () => {
    const builder = await graphSource('/theme-builder-bundle/theme-builder.js');
    const preview = await graphSource('/theme-builder-bundle/theme-preview.js');
    for (const marker of BUILDER_MARKERS) {
      expect(builder).toContain(marker);
      expect(preview).toContain(marker);
    }
  });

  it('builds both entries together and shares their common code as chunks', async () => {
    resetThemeBuilderBundles();
    const builder = await handleRequest(
      new Request(`${ORIGIN}/theme-builder-bundle/theme-builder.js`),
    );
    expect(builder.status).toBe(200);
    expect(Object.keys(THEME_BUILDER_ENTRY_SOURCES).every(isThemeBuilderEntryName)).toBe(true);
    const builderSource = await builder.text();
    expect(builderSource.match(/\/theme-builder-bundle\/chunk-/g)?.length).toBeGreaterThan(0);
  });
});
