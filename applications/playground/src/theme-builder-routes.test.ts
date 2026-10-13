/**
 * Route registration for the theme builder, and the regression routes it must not break.
 *
 * Drives `handleRequest` (the dev server's request handler, which the static export also
 * drives), so a route that answers here answers in both. This file builds bundles, so
 * `scripts/run-tests.ts` runs it in its own process.
 */

import { describe, expect, it } from 'bun:test';

import { assertThemeBuilderPages } from '../scripts/static-export.ts';
import { handleRequest } from './playground-server.ts';

const ORIGIN = 'https://playground.local';

/** The thirteen approved regression routes. */
const REGRESSION_ROUTES = [
  '/',
  '/page/button',
  '/page/input',
  '/page/select',
  '/page/checkbox',
  '/page/tabs',
  '/page/callout',
  '/page/table',
  '/page/line-chart',
  '/page/modal',
  '/page/popover',
  '/theme-builder',
  '/theme-builder/preview',
] as const;

const get = (path: string) => handleRequest(new Request(`${ORIGIN}${path}`));
async function html(path: string): Promise<string> {
  const response = await get(path);
  return response.text();
}

describe('the thirteen regression routes', () => {
  it('lists exactly thirteen routes', () => {
    expect(new Set(REGRESSION_ROUTES).size).toBe(13);
  });

  it.each([...REGRESSION_ROUTES])('%s answers 200 HTML on a direct request', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    const body = await response.text();
    expect(body.startsWith('<!DOCTYPE html>')).toBe(true);
  });
});

describe('/theme-builder', () => {
  it('has its own canonical URL and is indexable', async () => {
    const page = await html('/theme-builder');
    expect(page).toContain(`<link rel="canonical" href="${ORIGIN}/theme-builder" />`);
    expect(page.split('rel="canonical"')).toHaveLength(2);
    expect(page).not.toContain('noindex');
  });

  it('loads its own bundle and mount point, and nothing from the documentation shell', async () => {
    const page = await html('/theme-builder');
    expect(page).toContain('id="theme-builder-root"');
    expect(page).toContain('src="/theme-builder-bundle/theme-builder.js"');
    expect(page).not.toContain('/shell-bundle/');
    expect(page).not.toContain('/page-bundle/');
  });
});

describe('/theme-builder/preview', () => {
  it('is noindex and declares no canonical URL', async () => {
    const page = await html('/theme-builder/preview');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page).not.toContain('rel="canonical"');
    expect(page).toContain('id="theme-preview-root"');
    expect(page).toContain('src="/theme-builder-bundle/theme-preview.js"');
  });

  it('is rejected by the static export guard when it is indexable or canonical', async () => {
    const builder = await html('/theme-builder');
    const preview = await html('/theme-builder/preview');
    expect(() => assertThemeBuilderPages(builder, preview, ORIGIN)).not.toThrow();
    const indexable = preview.replace('noindex, nofollow', 'index');
    expect(() => assertThemeBuilderPages(builder, indexable, ORIGIN)).toThrow('must be noindex');
    const canonical = preview.replace(
      '</head>',
      `<link rel="canonical" href="${ORIGIN}/theme-builder/preview" /></head>`,
    );
    expect(() => assertThemeBuilderPages(builder, canonical, ORIGIN)).toThrow('canonical');
    expect(() => assertThemeBuilderPages(preview, preview, ORIGIN)).toThrow('canonical');
  });
});

describe('the theme builder bundles', () => {
  it.each(['theme-builder', 'theme-preview'])('serves %s as JavaScript', async (name) => {
    const response = await get(`/theme-builder-bundle/${name}.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('javascript');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('serves a hashed chunk with an immutable cache policy and 404s an unknown name', async () => {
    const entry = await html('/theme-builder-bundle/theme-builder.js');
    const chunk = /\/theme-builder-bundle\/(chunk-[A-Za-z0-9_-]+)\.js/.exec(entry);
    expect(chunk).not.toBeNull();
    const chunkResponse = await get(`/theme-builder-bundle/${chunk![1]}.js`);
    expect(chunkResponse.status).toBe(200);
    expect(chunkResponse.headers.get('Cache-Control')).toContain('immutable');
    const unknown = await get('/theme-builder-bundle/not-a-bundle.js');
    expect(unknown.status).toBe(404);
  });
});
