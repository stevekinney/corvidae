import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { actionFixtures } from "./runtime-actions-fixture.ts";
import { optionalRestFixtures } from "./runtime-optional-rest.ts";
import { writeShallowFixtures } from "./runtime-shallow.ts";
import { addSnapshotFixtures } from "./runtime-snapshots-fixture.ts";
import { routeAnnouncementFixtures } from "./runtime-route-announcements.ts";
import { routeEscapeFixtures } from "./runtime-route-escapes.ts";
import { remoteFixtures } from "./runtime-remotes.ts";
import {
  customTransportFixtures,
  transportSnapshotFixtures,
} from "./runtime-custom-transport.ts";
export type RuntimeBoundary = "candidate" | "reference";
export async function writeRuntimeFixture(
  directory: string,
  boundary: RuntimeBoundary,
) {
  const root = resolve(import.meta.dir, "../..");
  const errors =
    boundary === "reference"
      ? "@sveltejs/kit"
      : join(root, "src/data/errors.ts");
  const navigation =
    boundary === "reference"
      ? `import * as navigation from '$app/navigation';`
      : `import {getNavigation} from ${JSON.stringify(join(root, "src/client/navigation-context.ts"))}; const navigation=getNavigation();`;
  const errorState =
    boundary === "reference"
      ? `import {page} from '$app/state'; const error=$derived(page.error); const status=$derived(page.status);`
      : `let {error,status}=$props();`;
  const paramType = boundary === "reference" ? "" : ":string";
  const typedMatcherDefinitions = `const lowercase=(param${paramType})=>/^[a-z]+$/.test(param)?param:undefined;const uppercase=(param${paramType})=>/^[A-Z]+$/.test(param)?param:undefined;const numeric=(param${paramType})=>/^\\d+$/.test(param)?Number(param):undefined;const boolean=(param${paramType})=>param==='true'?true:param==='false'?false:undefined;const bigint=(param${paramType})=>/^\\d+$/.test(param)?BigInt(param):undefined;const echo=(param${paramType})=>param;const positiveInteger=(param${paramType})=>/^\\d+$/.test(param)?param:undefined;const section=(param${paramType})=>/^\\d+$/.test(param)?Number(param):undefined;const docPath=(param${paramType})=>param;const nonEmpty=(param${paramType})=>param.length>0?param:undefined;`;
  const typedMatchers =
    boundary === "reference"
      ? `${typedMatcherDefinitions}import {defineParams} from '@sveltejs/kit/params';export const params=defineParams({lowercase,uppercase,numeric,boolean,bigint,echo,'positive-integer':positiveInteger,section,docPath,nonEmpty});`
      : `${typedMatcherDefinitions}export const params={lowercase,uppercase,numeric,boolean,bigint,echo,'positive-integer':positiveInteger,section,docPath,nonEmpty};`;
  const files: Record<string, string> = {
    ...remoteFixtures(root, boundary),
    ...routeEscapeFixtures(boundary),
    ...customTransportFixtures(boundary),
    ...transportSnapshotFixtures(boundary),
    ...routeAnnouncementFixtures(boundary),
    ...actionFixtures(root, boundary),
    ...optionalRestFixtures(boundary),
    "src/routes/options/+layout.ts": "export const trailingSlash='always';",
    "src/routes/options/+page.svelte": "<h1>Trailing slash inherited</h1>",
    "src/routes/options/never/+page.ts": "export const trailingSlash='never';",
    "src/routes/options/never/+page.svelte":
      "<h1>Trailing slash overridden</h1>",
    "src/routes/options/ignore/+page.ts":
      "export const trailingSlash='ignore';",
    "src/routes/options/ignore/+page.svelte": "<h1>Trailing slash ignored</h1>",
    "src/routes/layout-k/+layout.server.ts":
      "import {counts} from '../../lib/state.server.ts'; export const load=()=>({kParent:'k-layout', kRuns:++counts.layout});",
    "src/routes/layout-k/+layout.ts": "export const trailingSlash='always';",
    "src/routes/layout-k/+layout.svelte":
      '<script lang="ts">let {data,children}=$props();</script><section data-k-layout><p data-k-parent>{data.kParent}</p>{@render children()}</section>',
    "src/routes/layout-k/(named)/+layout.server.ts":
      "export const load=()=>({namedParent:'named-layout'});",
    "src/routes/layout-k/(named)/+layout.svelte":
      '<script lang="ts">let {data,children}=$props();</script><section data-named-layout><p data-named-parent>{data.namedParent}</p>{@render children()}</section>',
    "src/routes/layout-k/(named)/branch/+layout.server.ts":
      "import {counts} from '../../../../lib/state.server.ts'; export const load=()=>({skippedLoad:++counts.skipped});",
    "src/routes/layout-k/(named)/branch/+layout.ts":
      "export const trailingSlash='never';",
    "src/routes/layout-k/(named)/branch/+layout.svelte":
      '<script lang="ts">let {data,children}=$props();</script><section data-skipped-layout><p>{data.skippedLoad}</p>{@render children()}</section>',
    "src/routes/layout-k/(named)/branch/reset/+page.server.ts":
      "export const load=async({parent})=>({resetParent:(await parent()).rootLabel});",
    "src/routes/layout-k/(named)/branch/reset/+page@.svelte":
      '<script lang="ts">let {data}=$props();</script><h1>Layout reset</h1><h2 data-k-root>{data.resetParent}</h2>',
    "src/routes/layout-k/(named)/branch/reset/+layout.server.ts":
      "import {counts} from '../../../../../lib/state.server.ts'; export const load=()=>({local:++counts.skipped});",
    "src/routes/layout-k/(named)/branch/reset/+layout.svelte":
      '<script lang="ts">let {children}=$props();</script><section data-k-local>{@render children()}</section>',
    "src/routes/layout-k/(named)/branch/named-reset/+page.server.ts":
      "export const load=async({parent})=>({namedResetParent:(await parent()).namedParent});",
    "src/routes/layout-k/(named)/branch/named-reset/+page@(named).svelte":
      '<script lang="ts">let {data}=$props();</script><h1>Named reset</h1><h2 data-k-named>{data.namedResetParent}</h2>',
    "src/routes/layout-k/(named)/branch/error/+page.server.ts": `import {error} from ${JSON.stringify(errors)}; export const load=()=>error(418,'K child failure');`,
    "src/routes/layout-k/(named)/branch/error/+page@.svelte":
      "<h1>unreachable</h1>",
    "src/routes/layout-k/(named)/branch/+error.svelte":
      "<h1 data-k-branch-error>Branch error</h1>",
    "src/routes/layout-k/(named)/ordinary/+page.svelte":
      "<h1>Ordinary inheritance</h1><p data-k-ordinary>k-layout/named-layout</p>",
    "src/routes/layout-k/(named)/branch/options/+page.ts":
      "export const load=async({parent})=>({resetParent:(await parent()).root});",
    "src/routes/layout-k/(named)/branch/options/+layout@layout-k.svelte":
      '<script lang="ts">let {children}=$props();</script><section data-k-rebound>{@render children()}</section>',
    "src/routes/layout-k/(named)/branch/options/+page.svelte":
      "<h1>Reset options</h1>",
    "package.json": JSON.stringify({
      name: `runtime-${boundary}`,
      private: true,
      type: "module",
    }),
    "src/app.html":
      '<!doctype html><html><head><meta charset="utf-8">%sveltekit.head%</head><body><div style="display:contents">%sveltekit.body%</div></body></html>',
    "src/lib/state.server.ts": `export const counts={layout:0,skipped:0,page:0,fetch:0}; export const deferred= new Map<string,ReturnType<typeof Promise.withResolvers<string>>>();`,
    [boundary === "reference" ? "src/params.js" : "src/params.ts"]:
      typedMatchers,
    "src/routes/+layout.server.ts": `import {counts} from '../lib/state.server.ts'; export const load=()=>({root:++counts.layout,rootLabel:'Hello'});`,
    "src/routes/+layout.svelte": `<script lang="ts">import {onMount} from 'svelte'; ${navigation} let {data,children}=$props(); let count=$state(0); onMount(()=>{Object.assign(window,{runtime:navigation});});</script><svelte:head><title>Runtime proof</title></svelte:head><header><button onclick={()=>count++}>Layout {count}</button><span data-root>{data.root}</span><a href="/runtime/items/one">One</a><a href="/runtime/items/two">Two</a><a href="/runtime/layout-k/branch/reset/">K reset</a><a href="/runtime/layout-k/branch/named-reset/">K named reset</a></header>{@render children()}<style>:global(body){margin:0} header{background:rgb(20,40,60);color:white} :global(main){min-height:1800px}</style>`,
    "src/routes/+error.svelte": `<script lang="ts">${errorState}</script><h1 data-error>{status}: {error.message}</h1>`,
    "src/routes/items/+layout.server.ts": `export const load=async({parent})=>({nested:'server-layout',parentRoot:(await parent()).root});`,
    "src/routes/items/+layout.ts": `export const load=async({data,parent})=>({...data,shared:'universal-layout',inherited:(await parent()).root});`,
    "src/routes/items/+layout.svelte": `<script lang="ts">let {data,children}=$props();let count=$state(0);</script><section data-nested><button onclick={()=>count++}>Nested {count}</button><p>{data.nested}/{data.shared}/{data.inherited}</p>{@render children()}</section>`,
    "src/routes/items/+error.svelte": `<script lang="ts">${errorState}</script><h1 data-nested-error>{status}: {error.message}</h1>`,
    "src/routes/items/[id]/+page.server.ts": `import {counts,deferred} from '../../../lib/state.server.ts'; import {error,redirect} from ${JSON.stringify(errors)}; export const load=async({params,url,depends})=>{depends('app:item');const armed=[...deferred.keys()].find(key=>key.startsWith('next:'));if(armed){const work=deferred.get(armed)!;deferred.delete(armed);deferred.set(armed.slice(5),work);await work.promise;}if(params.id==='redirect')redirect(303,'/runtime/items/two');if(params.id==='error')error(418,'Teapot');if(params.id==='private')throw new Error('PRIVATE_RUNTIME_SENTINEL');return {id:params.id,pageRuns:++counts.page,query:url.searchParams.get('q')??''};};`,
    "src/routes/items/[id]/+page.ts": `export const load=async({data,parent,fetch})=>({...data,parent:(await parent()).shared,fetched:(await (await fetch('/runtime/endpoint')).json()).value});`,
    "src/routes/items/[id]/+page.svelte": `<script lang="ts">let {data}=$props();</script><svelte:head><title>Item {data.id}</title></svelte:head><main><h1>Item {data.id}</h1><p data-page>{data.parent}/{data.fetched}/{data.query}</p><span data-page-runs>{data.pageRuns}</span><a href="/runtime/items/three" data-velveteen-preload-data="hover" data-sveltekit-preload-data="hover">Three</a><div style="height:1200px"></div><h2 id="target">Target</h2></main><style>h1{color:rgb(120,30,60)}</style>`,
    "src/routes/items/render/+page.svelte": `<script>function fail(){throw new Error('PRIVATE_RENDER_SENTINEL');}</script><p>{fail()}</p>`,
    "src/routes/endpoint/+server.ts": `import {counts} from '../../lib/state.server.ts';export const GET=()=>{counts.fetch++;return Response.json({value:'fetched'});};export const POST=async({request})=>new Response(await request.text(),{headers:{'x-method':'POST'}});`,
    "src/routes/counts/+server.ts": `import {counts} from '../../lib/state.server.ts';export const GET=()=>Response.json(counts);`,
    "src/routes/spa/+page.ts": `export const ssr=false;export const load=()=>({message:'Mounted SPA'});`,
    "src/routes/spa/+page.svelte": `<script>let {data}=$props();</script><h1>{data.message}</h1>`,
    "src/routes/static/+page.ts": `export const csr=false;export const load=()=>({message:'No client'});`,
    "src/routes/static/+page.svelte": `<script>let {data}=$props();</script><h1>{data.message}</h1>`,
    "src/routes/typed-matchers/+page.svelte": `<h1>Typed matchers</h1><nav><a href="/runtime/typed-matchers/a">lowercase</a><a href="/runtime/typed-matchers/B">uppercase</a><a href="/runtime/typed-matchers/number/0">number</a><a href="/runtime/typed-matchers/boolean/false">boolean</a><a href="/runtime/typed-matchers/bigint/9007199254740993">bigint</a><a href="/runtime/typed-matchers/echo/a%2Fb">encoded</a><a href="/runtime/typed-matchers/everything-else">fallback</a></nav>`,
    "src/routes/typed-matchers/static/+page.svelte":
      "<h1>static precedence</h1>",
    ...Object.fromEntries(
      [
        ["lowercase", "lowercase", ""],
        ["uppercase", "uppercase", ""],
        ["numeric", "number", "number"],
        ["boolean", "boolean", "boolean"],
        ["bigint", "bigint", "bigint"],
        ["echo", "echo", "echo"],
        ["positive-integer", "positive-integer", "hyphen"],
      ].flatMap(([matcher, kind, prefix]) => {
        const directory = prefix ? `${prefix}/` : "";
        const stateImport = prefix ? "../../../../lib" : "../../../lib";
        return [
          [
            `src/routes/typed-matchers/${directory}[value=${matcher}]/+page.server.ts`,
            `import {counts} from '${stateImport}/state.server.ts'; export const load=({params})=>{const typed={...params};return {kind:'${kind}',value:typed.value,type:typeof typed.value,runs:++counts.page};};`,
          ],
          [
            `src/routes/typed-matchers/${directory}[value=${matcher}]/+page.svelte`,
            '<script lang="ts">let {data}=$props();</script><h1>{data.kind}: {String(data.value)} ({data.type})</h1><p data-runs>{data.runs}</p>',
          ],
          [
            `src/routes/typed-matchers/${directory}[value=${matcher}]/+page.ts`,
            "export const load=({data,params})=>({...data,value:params.value,type:typeof params.value});",
          ],
        ];
      }),
    ),
    "src/routes/typed-matchers/[value]/+page.server.ts":
      "import {counts} from '../../../lib/state.server.ts'; export const load=({params})=>{const typed={...params};return {kind:'fallback',value:typed.value,type:typeof typed.value,runs:++counts.page};};",
    "src/routes/typed-matchers/[value]/+page.svelte":
      '<script lang="ts">let {data}=$props();</script><h1>{data.kind}: {data.value} ({data.type})</h1><p data-runs>{data.runs}</p>',
    "src/routes/deferred/+page.server.ts": `import {deferred} from '../../lib/state.server.ts';export const load=({url})=>{const key=url.searchParams.get('key')??'default';const work=Promise.withResolvers<string>();deferred.set(key,work);return {later:work.promise};};`,
    "src/routes/deferred/+page.svelte": `<script>let {data}=$props();</script>{#await data.later}<p data-pending>Pending</p>{:then value}<h1>{value}</h1>{:catch error}<h1 data-rejected>{error.message}</h1>{/await}`,
    "src/routes/arm/+server.ts": `import {deferred} from '../../lib/state.server.ts';export const POST=({url})=>{deferred.set('next:'+url.searchParams.get('key'),Promise.withResolvers<string>());return new Response('armed');};`,
    "src/routes/pending/+server.ts": `import {deferred} from '../../lib/state.server.ts';export const GET=()=>Response.json([...deferred.keys()]);`,
    "src/routes/release/+server.ts": `import {deferred} from '../../lib/state.server.ts';export const POST=({url})=>{const key=url.searchParams.get('key')??'default';const work=deferred.get(key);if(!work)return new Response('Missing',{status:404});if(url.searchParams.has('reject'))work.reject(new Error('PRIVATE_DEFERRED_SENTINEL'));else work.resolve('Deferred complete');deferred.delete(key);return new Response('ok');};`,
    "static/proof.txt": "Static proof",
  };
  writeShallowFixtures(
    (path, contents) => {
      files[path] = contents;
    },
    navigation,
    boundary,
  );
  addSnapshotFixtures(boundary, (path, contents) => {
    files[path] = contents;
  });
  if (boundary === "reference")
    files["vite.config.ts"] =
      `import {sveltekit} from '@sveltejs/kit/vite';import adapter from '@sveltejs/adapter-node';import{defineConfig}from'vite';export default defineConfig({plugins:[sveltekit({adapter:adapter(),paths:{base:'/runtime'},experimental:{remoteFunctions:true},compilerOptions:{experimental:{async:true}}})]});`;
  for (const stale of [
    boundary === "reference" ? "src/params.ts" : "src/params.js",
    "src/routes/layout-k/(named)/branch/reset/+page@.server.ts",
    "src/routes/layout-k/(named)/branch/error/+page@.server.ts",
    "src/routes/layout-k/(named)/branch/options/+page@.ts",
    "src/routes/layout-k/(named)/branch/options/+page@.svelte",
    "src/routes/layout-k/(named)/branch/options/+page@layout-k.svelte",
    "src/routes/layout-k/(named)/branch/reset/+page.svelte",
    "src/routes/layout-k/(named)/branch/reset/+page@.svelte",
  ])
    await rm(join(directory, stale), { force: true });
  if (
    boundary === "candidate" &&
    process.env.VELVETEEN_LAYOUT_K_CORRUPT === "1"
  ) {
    const resetPage =
      files["src/routes/layout-k/(named)/branch/reset/+page@.svelte"];
    delete files["src/routes/layout-k/(named)/branch/reset/+page@.svelte"];
    files["src/routes/layout-k/(named)/branch/reset/+page.svelte"] = resetPage;
  }
  await rm(join(directory, "src/routes/typed-matchers"), {
    recursive: true,
    force: true,
  });
  await rm(join(directory, "src/routes/docs"), {
    recursive: true,
    force: true,
  });
  await rm(join(directory, "src/routes/docs-reject"), {
    recursive: true,
    force: true,
  });
  if (boundary === "reference")
    await rm(join(directory, ".svelte-kit"), { recursive: true, force: true });
  if (boundary === "candidate" && process.env.VELVETEEN_RUNTIME_CORRUPT === "1")
    files["src/routes/endpoint/+server.ts"] = files[
      "src/routes/endpoint/+server.ts"
    ].replace("value:'fetched'", "value:'wrong'");
  if (
    boundary === "candidate" &&
    process.env.VELVETEEN_TYPED_MATCHER_CORRUPT === "1"
  )
    files["src/params.ts"] = files["src/params.ts"].replace(
      "Number(param)",
      "Number(param) + 1",
    );
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, text);
  }
  return directory;
}
