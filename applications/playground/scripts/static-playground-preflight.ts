/**
 * Every check of the static production gate that needs HTTP and files but no browser.
 *
 * `scripts/check-static-playground.ts` runs this against its static server before it launches
 * the test runner. Any failure ends the gate without starting Chromium. The checks collect every
 * failure instead of stopping at the first, so one run names all of them.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type ExportReport, type GitRunner, runGit } from './export-report.ts';
import { assertInitialRoutePayloadBudgets, assetUrlsFromHtml } from './initial-route-payload.ts';
import { isComponentRoute } from './static-playground-cases.ts';
import {
  buildDigestOf,
  createDigestManifest,
  type DigestManifestEntry,
} from './static-playground-digest.ts';
import {
  compileRouteSource,
  headersFor,
  type StaticHostConfiguration,
} from './static-playground-server.ts';

export type PreflightOptions = {
  directory: string;
  origin: string;
  report: ExportReport;
  configuration: StaticHostConfiguration;
  allowSourceMismatch: boolean;
  /** Credential-shaped variables whose values must never appear in served bytes. */
  secretEntries: readonly (readonly [name: string, value: string])[];
  git?: GitRunner;
};

export type PreflightResult = {
  failures: string[];
  manifest: DigestManifestEntry[];
  buildDigest: string;
};

/** No request to the local static server may wait longer than this; a stuck server fails the run. */
const FETCH_MILLISECONDS = 30_000;

/**
 * Fetch `url` and read its whole body, or reject once `milliseconds` pass. Races a timer rather
 * than passing an `AbortSignal`: under the playground's test preload, happy-dom replaces the
 * global `AbortSignal`, which Bun's `fetch` then rejects outright.
 */
export async function fetchWithin(
  url: string,
  init: RequestInit,
  milliseconds: number,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`[static-playground] ${url} did not answer within ${milliseconds} ms`)),
      milliseconds,
    );
  });
  const answer = (async () => {
    const response = await fetch(url, init);
    const body = await response.arrayBuffer();
    return new Response(response.status === 204 || response.status === 304 ? null : body, {
      status: response.status,
      headers: response.headers,
    });
  })();
  try {
    return await Promise.race([answer, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

function fetchStatic(url: string, init: RequestInit): Promise<Response> {
  return fetchWithin(url, init, FETCH_MILLISECONDS);
}

/** The minimum length of a credential value the leak check looks for. */
const MINIMUM_SECRET_LENGTH = 8;

const FORBIDDEN_SERVED_PATH = /(?:^|\/)fixtures(?:\/|$)|\.test\.|\.playwright\./;

/** The route a served HTML file answers: `index.html` is `/`, `a/b/index.html` is `/a/b`. */
export function routeForHtmlFile(path: string): string | undefined {
  if (path === 'index.html') return '/';
  return path.endsWith('/index.html') ? `/${path.slice(0, -'/index.html'.length)}` : undefined;
}

function htmlPathForRoute(route: string): string {
  return route === '/' ? 'index.html' : `${route.slice(1)}/index.html`;
}

export function checkSource(
  report: ExportReport,
  allowSourceMismatch: boolean,
  git: GitRunner,
): string[] {
  const failures: string[] = [];
  if (report.nodeEnv !== 'production') {
    failures.push(`export report NODE_ENV is ${String(report.nodeEnv)}, not production`);
  }
  if (allowSourceMismatch) return failures;
  const head = git(['rev-parse', 'HEAD']);
  if (report.sourceSha === null) failures.push('export report source SHA is null');
  else if (report.sourceSha !== head) {
    failures.push(`export report source SHA ${report.sourceSha} is not HEAD ${String(head)}`);
  }
  if (report.dirty !== false) {
    failures.push(
      report.dirty === null
        ? 'export report could not tell whether its tree was clean'
        : 'export report was recorded from a dirty tree',
    );
  }
  return failures;
}

export function checkServedPaths(
  manifest: readonly DigestManifestEntry[],
  contents: ReadonlyMap<string, string>,
  secretEntries: PreflightOptions['secretEntries'],
): string[] {
  const failures: string[] = [];
  for (const { path } of manifest) {
    if (FORBIDDEN_SERVED_PATH.test(path)) failures.push(`served path ${path} is test-only`);
  }
  for (const [name, value] of secretEntries) {
    if (value.length < MINIMUM_SECRET_LENGTH) continue;
    for (const [path, text] of contents) {
      if (text.includes(value)) failures.push(`served file ${path} contains the value of ${name}`);
    }
  }
  return failures;
}

async function headingCount(html: string): Promise<number> {
  let count = 0;
  await new HTMLRewriter()
    .on('h1', {
      element() {
        count += 1;
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return count;
}

async function visibleTextLength(html: string): Promise<number> {
  let length = 0;
  let hiddenDepth = 0;
  await new HTMLRewriter()
    .on('script, style, template, head', {
      element(element) {
        hiddenDepth += 1;
        element.onEndTag(() => {
          hiddenDepth -= 1;
        });
      },
    })
    .on('body *, body', {
      text(text) {
        if (hiddenDepth === 0) length += text.text.trim().length;
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return length;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

type DocumentFacts = { title?: string; description?: string; canonical: string[] };

function documentFacts(html: string): DocumentFacts {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const description = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1]?.trim();
  return {
    ...(title ? { title: decodeEntities(title) } : {}),
    ...(description ? { description: decodeEntities(description) } : {}),
    canonical: [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"/gi)].map(
      (match) => match[1]!,
    ),
  };
}

type RouteContext = {
  origin: string;
  canonicalOrigin: string | undefined;
  titles: Map<string, string>;
  descriptions: Map<string, string>;
  assets: Set<string>;
};

/** Status, prerendered content, metadata, headings, and the inline examples payload. */
async function checkRoute(route: string, html: string, context: RouteContext): Promise<string[]> {
  const failures: string[] = [];
  const response = await fetchStatic(`${context.origin}${route}`, { redirect: 'manual' });
  await response.arrayBuffer();
  if (response.status !== 200) failures.push(`${route} answered ${response.status}, not 200`);
  if (html.includes('<div id="app"></div>') || (await visibleTextLength(html)) === 0) {
    failures.push(`${route} has no prerendered content`);
  }
  const facts = documentFacts(html);
  for (const [field, value, seen] of [
    ['title', facts.title, context.titles],
    ['description', facts.description, context.descriptions],
  ] as const) {
    if (value === undefined) failures.push(`${route} has no ${field}`);
    else if (seen.has(value)) failures.push(`${route} repeats the ${field} of ${seen.get(value)}`);
    else seen.set(value, route);
  }
  const expectedCanonical = `${context.canonicalOrigin ?? '<sitemap origin>'}${route}`;
  if (facts.canonical.length !== 1 || facts.canonical[0] !== expectedCanonical) {
    failures.push(`${route} canonical metadata is not exactly ${expectedCanonical}`);
  }
  const headings = await headingCount(html);
  if (headings !== 1) failures.push(`${route} has ${headings} h1 elements, not exactly one`);
  if (isComponentRoute(route) && !/<script>\s*window\.__CINDER_EXAMPLES__\s*=/.test(html)) {
    failures.push(`${route} lacks its inline __CINDER_EXAMPLES__ payload`);
  }
  for (const asset of assetUrlsFromHtml(html)) context.assets.add(asset);
  return failures;
}

function headerFailures(
  configuration: StaticHostConfiguration,
  pathname: string,
  response: Response,
): string[] {
  const failures: string[] = [];
  for (const [key, value] of headersFor(configuration, pathname)) {
    if (response.headers.get(key) !== value) {
      failures.push(`${pathname} header ${key} is ${String(response.headers.get(key))}`);
    }
  }
  return failures;
}

/** Each configured redirect, the unknown-path 404, and configured headers on every kind of answer. */
async function checkHosting(
  options: PreflightOptions,
  routes: readonly string[],
  manifest: readonly DigestManifestEntry[],
): Promise<string[]> {
  const failures: string[] = [];
  const sampleName = routes.find(isComponentRoute)?.split('/').at(-1) ?? 'button';
  for (const redirect of options.configuration.redirects) {
    if (redirect.source.includes('(')) continue;
    const pathname = redirect.source.replace(/:[A-Za-z_]\w*/g, sampleName);
    const match = compileRouteSource(redirect.source).exec(pathname)!;
    const expected = redirect.destination.replace(
      /:([A-Za-z_]\w*)/g,
      (_whole, name: string) => match.groups?.[name] ?? '',
    );
    const response = await fetchStatic(`${options.origin}${pathname}`, { redirect: 'manual' });
    await response.arrayBuffer();
    const location = response.headers.get('Location');
    if (response.status !== redirect.statusCode || location !== expected) {
      failures.push(
        `${pathname} answered ${response.status} to ${String(location)}, not ${redirect.statusCode} to ${expected}`,
      );
    }
    failures.push(...headerFailures(options.configuration, pathname, response));
  }
  const unknown = `/static-playground-unknown-${crypto.randomUUID()}`;
  const missing = await fetchStatic(`${options.origin}${unknown}`, { redirect: 'manual' });
  await missing.arrayBuffer();
  if (missing.status !== 404) failures.push(`unknown path answered ${missing.status}, not 404`);
  failures.push(...headerFailures(options.configuration, unknown, missing));
  const representative = [
    '/',
    routes.find(isComponentRoute),
    manifest.find((entry) => entry.path.startsWith('assets/'))?.path,
  ].filter((path) => path !== undefined);
  for (const path of representative) {
    const pathname = path.startsWith('/') ? path : `/${path}`;
    const response = await fetchStatic(`${options.origin}${pathname}`, { redirect: 'manual' });
    await response.arrayBuffer();
    failures.push(...headerFailures(options.configuration, pathname, response));
  }
  return failures;
}

async function checkAssets(origin: string, assets: ReadonlySet<string>): Promise<string[]> {
  const failures: string[] = [];
  for (const asset of [...assets].toSorted()) {
    const response = await fetchStatic(`${origin}${asset}`, { redirect: 'manual' });
    await response.arrayBuffer();
    if (response.status !== 200) {
      failures.push(`required asset ${asset} answered ${response.status}`);
    }
  }
  return failures;
}

function sitemapUrls(sitemap: string | undefined): string[] {
  return sitemap === undefined
    ? []
    : [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
}

/** Run every HTTP-level check and return the failures, the manifest, and the build digest. */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const { report, directory } = options;
  const manifest = await createDigestManifest(directory);
  const buildDigest = buildDigestOf(manifest);
  const contents = new Map<string, string>();
  for (const { path } of manifest) {
    contents.set(path, await readFile(join(directory, path), 'utf8'));
  }
  const failures = [...checkSource(report, options.allowSourceMismatch, options.git ?? runGit)];
  if (report.buildDigest !== buildDigest) {
    failures.push(`export report digest ${report.buildDigest} is not served digest ${buildDigest}`);
  }
  const sitemap = sitemapUrls(contents.get('sitemap.xml'));
  const htmlRoutes = manifest.flatMap(({ path }) => routeForHtmlFile(path) ?? []);
  if (sitemap.length !== report.routes.length) {
    failures.push(
      `sitemap lists ${sitemap.length} routes; the report lists ${report.routes.length}`,
    );
  }
  if (htmlRoutes.length !== report.routes.length) {
    failures.push(
      `${htmlRoutes.length} route HTML files are served; the report lists ${report.routes.length}`,
    );
  }
  const canonicalOrigin = sitemap[0] === undefined ? undefined : new URL(sitemap[0]).origin;
  const context: RouteContext = {
    origin: options.origin,
    canonicalOrigin,
    titles: new Map(),
    descriptions: new Map(),
    assets: new Set(),
  };
  for (const route of report.routes) {
    if (!sitemap.includes(`${canonicalOrigin}${route}`)) failures.push(`sitemap omits ${route}`);
    const html = contents.get(htmlPathForRoute(route));
    if (html === undefined) {
      failures.push(`${route} has no prerendered HTML file`);
      continue;
    }
    failures.push(...(await checkRoute(route, html, context)));
  }
  failures.push(...(await checkAssets(options.origin, context.assets)));
  try {
    await assertInitialRoutePayloadBudgets(directory, report.routes);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  failures.push(...(await checkHosting(options, report.routes, manifest)));
  failures.push(...checkServedPaths(manifest, contents, options.secretEntries));
  return { failures, manifest, buildDigest };
}
