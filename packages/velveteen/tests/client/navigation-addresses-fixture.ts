import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import { createApplication } from "../../src/server/index.ts";

export type NavigationAddressRuntime = {
  readonly mode: "development" | "production";
  readonly basePath: string;
  readonly directory: string;
  readonly server: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
};

/** Fixture-owned escaping for identifiers the browser normalizes or a static route reserves. */
export const addressIdentifierPath = (
  kind: "item" | "address",
  identifier: string,
) =>
  `/${kind === "item" ? "items" : "addresses"}/${identifier === "." || identifier === ".." || (kind === "address" && identifier === "new") ? `_${kind === "item" ? "?__fixture_item_id" : "?__fixture_address_id"}=${encodeURIComponent(identifier)}` : encodeURIComponent(identifier)}`;

const source = (mode: "development" | "production", basePath: string) => ({
  "package.json": JSON.stringify({
    name: `navigation-addresses-${mode}`,
    private: true,
    type: "module",
  }),
  "src/app.html":
    "<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>",
  "src/routes/+layout.svelte": `<script lang="ts">
  import { onMount } from "svelte";
  import { getNavigation } from ${JSON.stringify(join(process.cwd(), "src/client/navigation-context.ts"))};
  let { children } = $props();
  const navigation = getNavigation();
  let mountToken = $state('server');
  onMount(() => { mountToken = crypto.randomUUID(); Object.assign(window, { addressNavigation: navigation }); });
</script>
<nav><a href="${basePath}/addresses/new">static new</a><a href="${basePath}/addresses/alpha">dynamic alpha</a><a href="${basePath}/search?tag=one&tag=two&empty=">query</a></nav>
<div data-layout-token>{mountToken}</div>
{@render children()}`,
  "src/routes/+error.svelte": `<script lang="ts">let { status, error } = $props();</script><h1 data-error>{status}: {error.message}</h1>`,
  "src/routes/+page.svelte": "<h1 data-page>Home</h1>",
  "src/routes/addresses/new/+page.ts":
    "export const load = () => ({ kind: 'static-new' });",
  "src/routes/addresses/new/+page.svelte": "<h1 data-page>Static new</h1>",
  "src/routes/addresses/[id]/+page.ts":
    "export const load = ({ params, url }) => { const override = url.searchParams.get('__fixture_address_id'); const id = params.id === '_' && (override === '.' || override === '..' || override === 'new') ? override : params.id; return { kind: 'dynamic', id }; }",
  "src/routes/addresses/[id]/+page.svelte":
    '<h1 data-page>{data.kind}: {data.id}</h1><script lang="ts">let { data } = $props();</script>',
  "src/routes/search/+page.ts":
    "export const load = ({ url }) => ({ query: [...url.searchParams.entries()].map(([key, value]) => `${key}=${value}`).join('|'), values: url.searchParams.getAll('tag').join(','), empty: url.searchParams.get('empty') });",
  "src/routes/search/+page.svelte":
    "<script lang=\"ts\">let { data } = $props();</script><h1 data-page>Search</h1><p data-query>{data.query}</p><p data-values>{data.values}</p><p data-empty>{data.empty === '' ? 'empty' : 'missing'}</p>",
  "src/routes/items/[id]/+page.ts":
    "export const load = ({ params, url }) => { const override = url.searchParams.get('__fixture_item_id'); const id = params.id === '_' && (override === '.' || override === '..') ? override : params.id; return { id }; }",
  "src/routes/items/[id]/+page.svelte":
    '<script lang="ts">let { data } = $props();</script><h1 data-page>Item {data.id}</h1>',
  "src/routes/plugins/[plugin]/[...rest]/+page.ts": `import { error } from ${JSON.stringify(join(process.cwd(), "src/data/errors.ts"))}; export const load = ({ params }) => { if (!params.rest || params.plugin !== 'demo') error(404, 'Not Found'); return { plugin: params.plugin, rest: params.rest }; };`,
  "src/routes/plugins/[plugin]/[...rest]/+page.svelte":
    '<script lang="ts">let { data } = $props();</script><h1 data-page>Plugin {data.plugin}/{data.rest}</h1>',
  "src/routes/redirect/+page.server.ts": `import { redirect } from ${JSON.stringify(join(process.cwd(), "src/data/errors.ts"))}; export const load = () => redirect(302, '${basePath}/addresses/new?from=redirect');`,
  "src/routes/redirect/+page.svelte": "<h1 data-page>Redirect placeholder</h1>",
});

export async function startNavigationAddressRuntime(
  mode: "development" | "production",
): Promise<NavigationAddressRuntime> {
  const basePath = "/address-fixture";
  const buildRoot = join(process.cwd(), ".velveteen/build");
  await mkdir(buildRoot, { recursive: true });
  const directory = await mkdtemp(join(buildRoot, "navigation-addresses-"));
  let disposeApplication: (() => Promise<void>) | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  try {
    for (const [file, contents] of Object.entries(source(mode, basePath))) {
      const path = join(directory, file);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, contents);
    }
    await mkdir(join(directory, "static"), { recursive: true });
    const generation = await buildProduction({
      projectDirectory: directory,
      routesDirectory: join(directory, "src/routes"),
      staticDirectory: join(directory, "static"),
      outputDirectory: join(directory, "output"),
      basePath,
      mode,
    });
    const application = await createApplication({ generation });
    disposeApplication = application.dispose;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: application.routes,
      fetch: application.fetch,
    });
    stopServer = () => server.stop(true);
    return {
      mode,
      basePath,
      directory,
      server,
      async stop() {
        await application.dispose();
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await disposeApplication?.();
    await stopServer?.();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
