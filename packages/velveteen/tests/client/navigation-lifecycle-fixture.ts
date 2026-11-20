import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDecoder } from "../../src/data/codec.ts";
import { dataMediaType } from "../../src/data/contract.ts";
import { buildProduction } from "../../src/build/index.ts";
import { createApplication } from "../../src/server/index.ts";

export type NavigationLifecycleRuntime = {
  readonly basePath: string;
  readonly directory: string;
  readonly server: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
};

const source = (basePath: string) => ({
  "package.json": JSON.stringify({
    name: "navigation-lifecycle",
    private: true,
    type: "module",
  }),
  "src/routes/+layout.svelte": `<script lang="ts">let { children } = $props();</script><div data-layout>layout</div>{@render children()}`,
  "src/routes/chat/[id]/+page.ts": `export const load = async ({ fetch, url, params }) => { if (url.searchParams.has('hold')) await fetch('${basePath}/__fixture_hold'); return { id: params.id }; };`,
  "src/routes/chat/[id]/+page.svelte": `<script lang="ts">import { onMount } from 'svelte';import { getNavigation } from ${JSON.stringify(join(process.cwd(), "src/client/navigation-context.ts"))};let { data } = $props();let value=$state('');let ticks=$state(0);const navigation=getNavigation();onMount(()=>{const timer=setInterval(()=>ticks++,10);const count=Number(sessionStorage.getItem('lifecycle-mounts')??0)+1;sessionStorage.setItem('lifecycle-mounts',String(count));Object.assign(window,{lifecycleNavigation:navigation});return()=>clearInterval(timer);});</script><h1 data-page>{data.id}</h1><input data-dirty bind:value={value}/><p data-ticks>{ticks}</p>`,
  "src/routes/other/[id]/+page.svelte": `<script lang="ts">let { data } = $props();</script><h1 data-other>{data.id}</h1>`,
  "src/routes/parent/+layout.svelte": `<script lang="ts">let { children } = $props();</script><div data-parent-layout>different parent</div>{@render children()}`,
  "src/routes/parent/[id]/+page.svelte": `<script lang="ts">let { data } = $props();</script><h1 data-parent-page>{data.id}</h1>`,
  "src/routes/__fixture_hold/+server.ts": `let release: (() => void) | undefined; let entered = false; export const holdState = () => ({ entered }); export const releaseHold = () => { const current = release; release = undefined; if (!current) return false; current(); return true; }; export const GET = ({ request }) => { let closed = false; return new Response(new ReadableStream({ start(controller) { entered = true; const finish = () => { if (closed) return; closed = true; controller.enqueue(new TextEncoder().encode('held')); controller.close(); }; release = finish; request.signal.addEventListener('abort', () => { if (!closed) { closed = true; controller.close(); } }, { once: true }); }, cancel() { closed = true; } })); };`,
  "src/routes/__fixture_release/+server.ts": `import { releaseHold } from '../__fixture_hold/+server.ts'; export const POST = () => Response.json({ released: releaseHold() });`,
  "src/routes/__fixture_state/+server.ts": `import { holdState } from '../__fixture_hold/+server.ts'; export const GET = () => Response.json(holdState());`,
});

async function initialPayload(
  application: Awaited<ReturnType<typeof createApplication>>,
  url: URL,
) {
  const response = await application.fetch(
    new Request(url, { headers: { accept: dataMediaType } }),
  );
  const first = (await response.text()).split("\n", 1)[0];
  const frame = JSON.parse(first) as { value: string };
  return createDecoder(frame.value).value;
}

export async function startNavigationLifecycleRuntime(
  mode: "development" | "production",
) {
  const basePath = "/lifecycle-fixture";
  const buildRoot = join(process.cwd(), ".velveteen/build");
  await mkdir(buildRoot, { recursive: true });
  const directory = await mkdtemp(join(buildRoot, "navigation-lifecycle-"));
  let disposeApplication: (() => Promise<void>) | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  try {
    for (const [file, contents] of Object.entries(source(basePath))) {
      const path = join(directory, file);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, contents);
    }
    const generation = await buildProduction({
      projectDirectory: directory,
      routesDirectory: join(directory, "src/routes"),
      outputDirectory: join(directory, "output"),
      basePath,
      mode,
    });
    const application = await createApplication({ generation });
    disposeApplication = application.dispose;
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: application.routes,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.headers.get("accept")?.includes("text/html")) {
          const payload = await initialPayload(application, url);
          const registry = generation.manifest.client.url;
          const html = `<!doctype html><html><body><a id="lifecycle-link" href="${basePath}/chat/link">link</a><p id="lifecycle-pending" hidden>Loading</p><div id="app"></div><script type="module">import {start} from ${JSON.stringify(new URL(registry, server.url).href)};const pending=document.querySelector('#lifecycle-pending');const app=await start({target:document.querySelector('#app'),initial:${JSON.stringify(payload)},ssr:false,pageKey:p=>p.params.id??p.url,beforeNavigate:({cancel})=>{pending.hidden=false;globalThis.lifecycleBeforeAttempts=(globalThis.lifecycleBeforeAttempts??0)+1;if(globalThis.lifecycleBlock){cancel();pending.hidden=true}},afterNavigate:()=>{pending.hidden=true},onError:e=>{pending.hidden=true;globalThis.lifecycleError=String(e)}});const before=(event)=>{globalThis.lifecycleBeforeUnload=true;if(globalThis.lifecycleBlock)event.preventDefault()};addEventListener('beforeunload',before);const dispose=app.dispose.bind(app);app.dispose=async()=>{removeEventListener('beforeunload',before);await dispose()};globalThis.lifecycle=app;</script></body></html>`;
          return new Response(html, {
            headers: { "content-type": "text/html" },
          });
        }
        return application.fetch(request);
      },
    });
    stopServer = () => server.stop(true);
    return {
      basePath,
      directory,
      server,
      async stop() {
        await application.dispose();
        await server.stop(true);
        await rm(directory, { recursive: true, force: true });
      },
    } satisfies NavigationLifecycleRuntime;
  } catch (cause) {
    await disposeApplication?.();
    await stopServer?.();
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}
