/**
 * A server-rendered page for a no-JavaScript browser check (COR-2770). The fixture host mounts every
 * fixture on the client, so with JavaScript off its pages are empty. A first-paint check instead
 * renders a small Svelte component with the real server runtime (`renderSvelteOnServer`) and serves
 * that HTML inside the fixture host's own built page: the same stylesheet links, the same `#app`
 * target and the same body padding, with every script removed. What the browser paints is then
 * exactly what server HTML and Cinder's CSS decide, before any hydration.
 *
 * A spec renders once in `test.beforeAll` (a render spawns Bun processes), then serves the page with
 * `openServerRenderedPage` in each test under `test.use({ javaScriptEnabled: false })`.
 */

import { renderSvelteOnServer } from '@lostgradient/testing';
import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import type { Page } from '@playwright/test';

/** The two themes the fixture host draws; a page without script cannot read the stored one. */
export type ServerRenderedTheme = 'light' | 'dark';

const EMPTY_TARGET = '<div id="app"></div>';
const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/giu;
const MODULE_PRELOAD = /<link\b[^>]*\brel="modulepreload"[^>]*>/giu;
const STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*>/iu;

/**
 * Builds a document from the fixture host's built page (`hostPage`, the HTML its `/` serves): every
 * script and module preload is removed, `body` fills the empty `#app` target, and the root element
 * carries the theme the host would apply from storage. Throws when the page has no stylesheet link
 * or no empty target, so a changed host page fails loudly instead of yielding an unstyled check.
 */
export function serverRenderedDocument(
  hostPage: string,
  body: string,
  theme: ServerRenderedTheme = 'light',
): string {
  const withoutScripts = hostPage.replaceAll(SCRIPT, '').replaceAll(MODULE_PRELOAD, '');
  if (!STYLESHEET.test(withoutScripts)) {
    throw new Error('The fixture host page links no stylesheet; build the fixtures first.');
  }
  if (withoutScripts.split(EMPTY_TARGET).length !== 2) {
    throw new Error(`The fixture host page must hold exactly one empty ${EMPTY_TARGET}.`);
  }
  const themed = withoutScripts.replace(
    /<html\b([^>]*)>/u,
    (_match, attributes: string) =>
      `<html${attributes} data-theme="${theme}" data-cinder-theme="${theme}" style="color-scheme: ${theme}">`,
  );
  // A function replacement, so `$&` or `$1` in the server HTML is never read as a pattern.
  return themed.replace(EMPTY_TARGET, () => `<div id="app">${body}</div>`);
}

/** Server HTML for one component, ready to serve in either theme. */
export type ServerRenderedPage = {
  /** The component's server-rendered body, as `renderSvelteOnServer` returns it. */
  body: string;
  /** The whole document in `theme`. */
  document: (theme?: ServerRenderedTheme) => string;
};

/**
 * Renders `sourcePath` on the server and fetches the fixture host's built page from the running
 * fixture server. `props` must be plain data; define snippets and callbacks in the component.
 */
export async function renderServerPage(
  sourcePath: string,
  props: Record<string, unknown> = {},
): Promise<ServerRenderedPage> {
  const [body, hostPage] = await Promise.all([
    renderSvelteOnServer(sourcePath, props),
    fetch(new URL('/', FIXTURE_ORIGIN)).then(async (response) => {
      if (!response.ok) throw new Error(`The fixture host answered ${response.status} for /.`);
      return response.text();
    }),
  ]);
  return { body, document: (theme = 'light') => serverRenderedDocument(hostPage, body, theme) };
}

/**
 * Serves `rendered` at `path` on the fixture origin, so its stylesheet links resolve against the
 * fixture server, and opens it. The route answers only this page's own address.
 */
export async function openServerRenderedPage(
  page: Page,
  rendered: ServerRenderedPage,
  options: { path: string; theme?: ServerRenderedTheme },
): Promise<void> {
  const url = new URL(options.path, FIXTURE_ORIGIN).href;
  const document = rendered.document(options.theme);
  await page.route(url, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: document }),
  );
  await page.goto(url, { waitUntil: 'load' });
}
