import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  setFeaturedExampleRenderer,
  type FeaturedExampleRenderer,
} from './featured-example-server-renderer.ts';
import { PORT, handleRequest } from './playground-server.ts';
import { loadPageServerRenderer, setPreparedShellServerRenderer } from './ssr-renderer.ts';

/*
 * Slow lane (COR-1499). Requesting an extracted Chat page and then its package-owned stylesheet
 * cold-compiles the Chat package's CSS through the page build: 20 to 37 seconds at host load 110
 * to 165, against Bun's 5-second default. It moved out of `playground-server.test.ts` so it runs
 * serially in `test:slow` with its own untimed, module-scope warmup, and its assertions are
 * unchanged. The stand-in renderers below mirror that file's: a page only has to embed what the
 * renderer returns, and the real featured-example render is asserted in
 * `featured-example-server-renderer.test.ts`.
 */
const testShellServerRenderer: NonNullable<
  Parameters<typeof setPreparedShellServerRenderer>[0]
> = ({ components, readmeHtml }) => ({
  body: `<div id="shell-root"><div class="dx-shell">
      <nav class="dx-nav" aria-label="Components">
        <input id="sidebar-filter" type="search" />
        ${components.map((name) => `<a href="/page/${name}">${name}</a>`).join('')}
      </nav>
      <main class="dx-content dx-content--landing">${readmeHtml}</main>
    </div></div>`,
  head: '<style>.dx-shell { display: contents; }</style>',
});

const testFeaturedExampleRenderer: FeaturedExampleRenderer = async (componentName, scenario) => ({
  body: `<p data-test-featured-example="${componentName}/${scenario}">Featured ${componentName}/${scenario}</p>`,
  head: '',
});

// Compile the page server renderer and analyze the manifests here, at module scope, which Bun does
// not time, so the test body pays only for the Chat stylesheet request it asserts on.
await loadPageServerRenderer();
const manifestWarmup = await handleRequest(new Request(`http://localhost:${PORT}/api/manifest`));
if (!manifestWarmup.ok) {
  throw new Error(`[server.slow.test] manifest warmup returned ${manifestWarmup.status}`);
}

beforeEach(() => {
  setPreparedShellServerRenderer(testShellServerRenderer);
  setFeaturedExampleRenderer(testFeaturedExampleRenderer);
});

afterEach(() => {
  setPreparedShellServerRenderer(null);
});

function req(path: string, options?: RequestInit): Request {
  return new Request(`http://localhost:${PORT}${path}`, options);
}

describe('/page/:name for extracted Chat pages', () => {
  it('loads package-owned component CSS for extracted Chat pages', async () => {
    const response = await handleRequest(req('/page/chat'));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/package-components/chat/chat/chat.css"');

    const stylesheet = await handleRequest(req('/package-components/chat/chat/chat.css'));
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('Content-Type')).toBe('text/css');
    expect(await stylesheet.text()).toContain('.cinder-chat');
  });
});
