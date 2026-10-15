import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  compileRouteSource,
  loadStaticHostConfiguration,
  parseStaticHostConfiguration,
  startStaticServer,
  type StaticHostConfiguration,
  type StaticServer,
} from './static-playground-server.ts';

const GOOD_FIXTURE = join(import.meta.dirname, 'fixtures', 'static-playground', 'good');

describe('static host configuration', () => {
  it('reads the deployed vercel.json routing', async () => {
    const configuration = await loadStaticHostConfiguration();

    expect(configuration.cleanUrls).toBe(true);
    expect(configuration.redirects).toEqual([
      { source: '/c/:name', destination: '/page/:name', statusCode: 301 },
    ]);
    expect(configuration.headers.map((rule) => rule.source)).toEqual([
      '/assets/(.*)',
      '/((?!theme-builder/preview$).*)',
      '/theme-builder/preview',
    ]);
  });

  it('compiles parameters and groups into anchored expressions', () => {
    expect(compileRouteSource('/c/:name').exec('/c/button')?.groups).toEqual({ name: 'button' });
    expect(compileRouteSource('/c/:name').test('/c/button/extra')).toBe(false);
    expect(compileRouteSource('/assets/(.*)').test('/assets/a/b.css')).toBe(true);
    expect(compileRouteSource('/assets/(.*)').test('/page/assets/x')).toBe(false);
  });

  it('compiles a nested lookahead group as one group', () => {
    const everythingButPreview = compileRouteSource('/((?!theme-builder/preview$).*)');
    expect(everythingButPreview.test('/page/button')).toBe(true);
    expect(everythingButPreview.test('/theme-builder')).toBe(true);
    expect(everythingButPreview.test('/theme-builder/preview')).toBe(false);
  });

  it('rejects a redirect that is not a 3xx', () => {
    expect(() =>
      parseStaticHostConfiguration({
        redirects: [{ source: '/a', destination: '/b', statusCode: 200 }],
      }),
    ).toThrow('statusCode must be 3xx');
  });
});

describe('static server', () => {
  let configuration: StaticHostConfiguration;
  let server: StaticServer;

  beforeAll(async () => {
    configuration = await loadStaticHostConfiguration();
    server = startStaticServer({ directory: GOOD_FIXTURE, configuration });
  });

  afterAll(async () => {
    await server.stop();
  });

  const request = (path: string) => fetch(`${server.origin}${path}`, { redirect: 'manual' });

  it('serves the root and clean URLs with the configured headers', async () => {
    for (const path of ['/', '/page/button']) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Cache-Control')).toBeNull();
      expect(await response.text()).toContain('<h1');
    }
  });

  it('marks assets immutable', async () => {
    const response = await request('/assets/fixture/site.css');
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
  });

  it('answers the legacy alias with the configured 301 and headers', async () => {
    const response = await request('/c/button');

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/page/button');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('redirects an explicit .html path to its clean URL', async () => {
    const response = await request('/page/button/index.html');

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('/page/button');
  });

  it.each(['/missing', '/page/absent', '/%2e%2e/package.json', '/assets/fixture/site.css.missing'])(
    'answers %s with 404 and the configured headers',
    async (path) => {
      const response = await request(path);
      await response.arrayBuffer();

      expect(response.status).toBe(404);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    },
  );
});
