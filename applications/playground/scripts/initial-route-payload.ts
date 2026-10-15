/**
 * The first-navigation payload of an exported route, and the production budgets it must stay
 * inside. The static export enforces the budgets when it writes `build/`, and the static
 * production gate enforces them again over the bytes it serves, so both read them from here
 * without loading the export's build pipeline.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ORIGIN = 'https://playground.local';

export type InitialRoutePayload = {
  transferBytes: number;
  decodedBytes: number;
  urls: readonly string[];
};

type InitialRoutePayloadBudget = {
  route: string;
  transferBytes: number;
  decodedBytes: number;
};

// These are production budgets for the first navigation. A route's deferred
// scenario and Playground imports are intentionally excluded: they are not
// requested until the reader opens an interactive surface.
export const INITIAL_ROUTE_PAYLOAD_BUDGETS: readonly InitialRoutePayloadBudget[] = [
  { route: '/', transferBytes: 175_000, decodedBytes: 800_000 },
  { route: '/page/button', transferBytes: 200_000, decodedBytes: 900_000 },
  { route: '/page/chat', transferBytes: 700_000, decodedBytes: 3_250_000 },
];

/**
 * Elements whose `href`/`src` names a subresource the browser must fetch for the
 * page to render correctly, and which therefore has to exist as a static file.
 *
 * `<a>` is deliberately absent. An anchor is navigation, not a subresource, and
 * since the documentation pages became server-rendered their markup contains
 * example content with illustrative links — `SideNavigation.Item
 * href="/projects/atlas"` in `examples/side-navigation/basic.example.svelte`, for
 * instance. Those routes do not exist, and because `render()` throws on any
 * non-2xx response, crawling them failed the whole export with
 * `/projects/atlas → HTTP 404`.
 *
 * Every real route is enumerated explicitly by `runStaticExport` (`/page/<name>`
 * for all components and family children, the API and example-source routes), so scraping anchors added no coverage — only the risk of treating
 * demo content as a build requirement.
 */
const ASSET_ELEMENTS = ['link', 'script', 'img', 'iframe', 'source'] as const;

/**
 * Source for a regex matching an asset-bearing start tag, capturing its
 * root-relative `href`/`src`. Attribute order varies (`<link rel="stylesheet"
 * href="…">` vs `<link href="…" rel="…">`), so the URL is captured from anywhere
 * inside the tag.
 *
 * Held as a string and compiled per call: a shared `/g` regex carries `lastIndex`
 * between invocations, so a second call would silently resume mid-document.
 */
const ASSET_REFERENCE_SOURCE = `<(?:${ASSET_ELEMENTS.join('|')})\\b[^>]*?\\b(?:href|src)="(/[^"]*)"`;

/**
 * Pull every same-origin subresource URL the given HTML references — `<script
 * src>` bundles, `<link href>` stylesheets, and `<img>`/`<iframe>`/`<source>`
 * media — as root-relative paths. Navigation links are ignored; see
 * {@link ASSET_ELEMENTS}.
 */
export function assetUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  const assetReference = new RegExp(ASSET_REFERENCE_SOURCE, 'gi');
  let match: RegExpExecArray | null;
  while ((match = assetReference.exec(html)) !== null) {
    const url = match[1]!;
    // Only crawlable GET routes — skip the SSE stream, which has no static form.
    if (url === '/events') continue;
    // Queries configure browser behavior but do not identify a second static
    // file. Materialize `/page/button?preview=1` at the already-exported
    // `/page/button` path instead of creating a literal `?preview=1` directory.
    urls.add(new URL(url, ORIGIN).pathname);
  }
  return [...urls];
}

/** Static ESM imports are requested during initial evaluation; `import(...)` is not. */
function staticJavaScriptImportUrls(javascript: string): string[] {
  const urls = new Set<string>();
  const imports = /(?:^|\n)\s*import\s*(?:[\s\S]*?\s+from\s+)?["'](\/[^"']+\.js)["'];?/g;
  let match: RegExpExecArray | null;
  while ((match = imports.exec(javascript)) !== null) urls.add(match[1]!);
  return [...urls];
}

function stylesheetAssetUrls(stylesheet: string): string[] {
  const urls = new Set<string>();
  const imports = /@import\s+(?:url\(\s*)?["']?(\/[^"'\s)]+)["']?/g;
  const references = /url\(\s*["']?(\/[^"'\s)]+)["']?\s*\)/g;
  for (const expression of [imports, references]) {
    let match: RegExpExecArray | null;
    while ((match = expression.exec(stylesheet)) !== null) urls.add(match[1]!);
  }
  return [...urls];
}

/** The exported HTML file for a canonical route: `/` is `index.html`, every other route a directory index. */
function exportedHtmlPath(route: string, outputDirectory: string): string {
  const clean = route.replace(/^\/+/, '');
  return clean === ''
    ? join(outputDirectory, 'index.html')
    : join(outputDirectory, clean, 'index.html');
}

/**
 * Sum the files a production browser requests to render a route before any
 * reader-triggered dynamic import. Every asset is gzipped independently, which
 * matches HTTP content encoding rather than pretending one archive compresses
 * across request boundaries.
 */
export async function initialRoutePayload(
  route: string,
  outputDirectory: string,
): Promise<InitialRoutePayload> {
  const queue = [{ url: route, filePath: exportedHtmlPath(route, outputDirectory), kind: 'html' }];
  const visited = new Set<string>();
  let transferBytes = 0;
  let decodedBytes = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.url)) continue;
    visited.add(current.url);

    const contents = new Uint8Array(await readFile(current.filePath));
    transferBytes += Bun.gzipSync(contents).byteLength;
    decodedBytes += contents.byteLength;

    const text = new TextDecoder().decode(contents);
    const dependencies =
      current.kind === 'html'
        ? assetUrlsFromHtml(text)
        : current.kind === 'javascript'
          ? staticJavaScriptImportUrls(text)
          : stylesheetAssetUrls(text);
    for (const url of dependencies) {
      if (!url.startsWith('/')) continue;
      const extension = url.split('?')[0]!.split('.').pop()?.toLowerCase();
      queue.push({
        url,
        filePath: join(outputDirectory, url.slice(1)),
        kind: extension === 'js' || extension === 'mjs' ? 'javascript' : 'stylesheet',
      });
    }
  }

  return { transferBytes, decodedBytes, urls: [...visited].toSorted() };
}

export async function assertInitialRoutePayloadBudgets(
  outputDirectory: string,
  exportedRoutes: readonly string[],
): Promise<void> {
  for (const budget of INITIAL_ROUTE_PAYLOAD_BUDGETS) {
    if (!exportedRoutes.includes(budget.route)) continue;
    const payload = await initialRoutePayload(budget.route, outputDirectory);
    if (
      payload.transferBytes > budget.transferBytes ||
      payload.decodedBytes > budget.decodedBytes
    ) {
      throw new Error(
        `[static-export] ${budget.route} initial payload exceeds budget: ` +
          `${payload.transferBytes}/${budget.transferBytes} transfer bytes, ` +
          `${payload.decodedBytes}/${budget.decodedBytes} decoded bytes. ` +
          `Assets: ${payload.urls.join(', ')}`,
      );
    }
  }
}
