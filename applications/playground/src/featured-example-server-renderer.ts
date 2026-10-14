import { join } from 'node:path';

import { PLAYGROUND_ROOT } from './playground-paths.ts';
import { getRebuildGeneration } from './rebuild-generation.ts';

export type RenderedFeaturedExample = {
  body: string;
  head: string;
};

export type FeaturedExampleRenderer = (
  componentName: string,
  scenario: string,
  mountIdPrefix: string,
) => Promise<RenderedFeaturedExample>;

const renderPromises = new Map<string, Promise<RenderedFeaturedExample>>();
let renderPromiseGeneration = -1;
let substituteRenderer: FeaturedExampleRenderer | null = null;

/**
 * Replace the fresh-process render with a deterministic renderer, or restore it with `null`.
 *
 * Each real render spawns a `bun` process that cold-compiles the example's Svelte graph, which
 * costs about a second on an idle host and several under load. Route tests that only need the
 * page to embed SOME featured example cannot pay that inside Bun's per-test budget, so they
 * substitute one here, as they already do for the shell renderer with
 * `setPreparedShellServerRenderer`. The real render is proven by
 * `featured-example-server-renderer.test.ts`. Production never sets this.
 */
export function setFeaturedExampleRenderer(renderer: FeaturedExampleRenderer | null): void {
  substituteRenderer = renderer;
}

const SVELTE_HYDRATION_MARKER = /<!--(?:\[(?:!|\?[\s\S]*?|-?\d+)?|\]|\/?\$)?-->/g;
const SELF_CLOSING_HTML_VOID_ELEMENT =
  /<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)(\s[^<>]*?)?\/>/gi;

/**
 * The example is compiled independently from the page that embeds it. Its
 * hydration markers therefore do not belong to the page's component tree and
 * can confuse the page-level hydration cursor. Keep the meaningful static HTML
 * while removing only Svelte's internal comment markers; the client mount
 * replaces this fragment atomically once its own bundle is ready.
 */
export function removeHydrationMarkers(html: string): string {
  return html.replace(SVELTE_HYDRATION_MARKER, '');
}

/** Match the HTML serialization browsers expose through Element.innerHTML. */
export function normalizeBrowserSerializedHtml(html: string): string {
  return html.replace(SELF_CLOSING_HTML_VOID_ELEMENT, '<$1$2>');
}

function isRenderedFeaturedExample(value: unknown): value is RenderedFeaturedExample {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'body') === 'string' &&
    typeof Reflect.get(value, 'head') === 'string'
  );
}

async function renderInFreshProcess(
  componentName: string,
  scenario: string,
  mountIdPrefix: string,
): Promise<RenderedFeaturedExample> {
  const workerPath = join(PLAYGROUND_ROOT, 'src', 'featured-example-server-worker.ts');
  const worker = Bun.spawn(
    [process.execPath, 'run', workerPath, componentName, scenario, mountIdPrefix],
    {
      cwd: PLAYGROUND_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      // A hang detector for a worker that never exits, never a performance bound.
      timeout: 120_000,
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    worker.exited,
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[playground] featured example render failed for ${componentName}/${scenario}: ${stderr.trim()}`,
    );
  }
  const parsed: unknown = JSON.parse(stdout);
  if (!isRenderedFeaturedExample(parsed)) {
    throw new Error('[playground] featured example worker returned malformed output');
  }
  return {
    body: normalizeBrowserSerializedHtml(removeHydrationMarkers(parsed.body)),
    head: parsed.head,
  };
}

/** Server-render a featured documentation example for the exported first paint. */
export async function renderFeaturedExample(
  componentName: string,
  scenario: string,
  mountIdPrefix: string,
): Promise<RenderedFeaturedExample> {
  if (substituteRenderer !== null) {
    return await substituteRenderer(componentName, scenario, mountIdPrefix);
  }
  const rebuildGeneration = getRebuildGeneration();
  if (renderPromiseGeneration !== rebuildGeneration) {
    renderPromises.clear();
    renderPromiseGeneration = rebuildGeneration;
  }
  const cacheKey = `${componentName}/${scenario}:${mountIdPrefix}`;
  let renderPromise = renderPromises.get(cacheKey);
  if (renderPromise === undefined) {
    const pendingRender = renderInFreshProcess(componentName, scenario, mountIdPrefix);
    renderPromise = pendingRender;
    renderPromises.set(cacheKey, pendingRender);
    void pendingRender.catch(() => {
      if (renderPromises.get(cacheKey) === pendingRender) renderPromises.delete(cacheKey);
    });
  }
  return await renderPromise;
}
