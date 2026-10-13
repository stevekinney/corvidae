/**
 * Route registration for the theme builder, and the regression routes it must not break.
 *
 * Drives `handleRequest` (the dev server's request handler, which the static export also
 * drives), so a route that answers here answers in both. This file builds bundles, so
 * `scripts/run-tests.ts` runs it in its own process.
 *
 * Every request is answered at module scope, which Bun does not time, and the tests assert on
 * the captured responses (the COR-1427 pattern). A cold `/page/:name` request compiles page and
 * bundle graphs that take seconds under host load; paid inside a test's 5-second budget, that
 * compile timed these tests out whenever other work loaded the host. The featured example is a
 * stand-in for the same reason: its real fresh-process render is asserted in
 * `featured-example-server-renderer.test.ts`, and a route here only has to answer with HTML.
 */

import { describe, expect, it } from 'bun:test';

import { assertThemeBuilderPages } from '../scripts/static-export.ts';
import { setFeaturedExampleRenderer } from './featured-example-server-renderer.ts';
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

type CapturedResponse = {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  body: string;
};

setFeaturedExampleRenderer(async (componentName, scenario) => ({
  body: `<p data-test-featured-example="${componentName}/${scenario}">Featured</p>`,
  head: '',
}));

async function capture(path: string): Promise<CapturedResponse> {
  const response = await handleRequest(new Request(`${ORIGIN}${path}`));
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type'),
    cacheControl: response.headers.get('Cache-Control'),
    body: await response.text(),
  };
}

const captured = new Map<string, CapturedResponse>();
for (const path of [
  ...REGRESSION_ROUTES,
  '/theme-builder-bundle/theme-builder.js',
  '/theme-builder-bundle/theme-preview.js',
  '/theme-builder-bundle/not-a-bundle.js',
]) {
  captured.set(path, await capture(path));
}
const builderChunk = /\/theme-builder-bundle\/(chunk-[A-Za-z0-9_-]+)\.js/.exec(
  captured.get('/theme-builder-bundle/theme-builder.js')!.body,
);
if (builderChunk !== null) {
  const chunkPath = `/theme-builder-bundle/${builderChunk[1]}.js`;
  captured.set(chunkPath, await capture(chunkPath));
}

function get(path: string): CapturedResponse {
  const response = captured.get(path);
  if (response === undefined) throw new Error(`[routes.test] ${path} was not captured`);
  return response;
}
const html = (path: string): string => get(path).body;

describe('the thirteen regression routes', () => {
  it('lists exactly thirteen routes', () => {
    expect(new Set(REGRESSION_ROUTES).size).toBe(13);
  });

  it.each([...REGRESSION_ROUTES])('%s answers 200 HTML on a direct request', (path) => {
    const response = get(path);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    expect(response.body.startsWith('<!DOCTYPE html>')).toBe(true);
  });
});

describe('/theme-builder', () => {
  it('has its own canonical URL and is indexable', () => {
    const page = html('/theme-builder');
    expect(page).toContain(`<link rel="canonical" href="${ORIGIN}/theme-builder" />`);
    expect(page.split('rel="canonical"')).toHaveLength(2);
    expect(page).not.toContain('noindex');
  });

  it('loads its own bundle and mount point, and nothing from the documentation shell', () => {
    const page = html('/theme-builder');
    expect(page).toContain('id="theme-builder-root"');
    expect(page).toContain('src="/theme-builder-bundle/theme-builder.js"');
    expect(page).not.toContain('/shell-bundle/');
    expect(page).not.toContain('/page-bundle/');
  });
});

describe('/theme-builder/preview', () => {
  it('is noindex and declares no canonical URL', () => {
    const page = html('/theme-builder/preview');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(page).not.toContain('rel="canonical"');
    expect(page).toContain('id="theme-preview-root"');
    expect(page).toContain('src="/theme-builder-bundle/theme-preview.js"');
  });

  it('is rejected by the static export guard when it is indexable or canonical', () => {
    const builder = html('/theme-builder');
    const preview = html('/theme-builder/preview');
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
  it.each(['theme-builder', 'theme-preview'])('serves %s as JavaScript', (name) => {
    const response = get(`/theme-builder-bundle/${name}.js`);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('javascript');
    expect(response.cacheControl).toBe('no-store');
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('serves a hashed chunk with an immutable cache policy and 404s an unknown name', () => {
    expect(builderChunk).not.toBeNull();
    const chunkResponse = get(`/theme-builder-bundle/${builderChunk![1]}.js`);
    expect(chunkResponse.status).toBe(200);
    expect(chunkResponse.cacheControl).toContain('immutable');
    expect(get('/theme-builder-bundle/not-a-bundle.js').status).toBe(404);
  });
});
