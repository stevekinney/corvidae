import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { afterAll, expect, test } from "bun:test";
import { expect as browserExpect, chromium } from "@playwright/test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { staticFixture } from "./fixture.ts";
import { prerender } from "../../src/prerender/index.ts";
import { buildServiceWorker } from "../../src/prerender/service-worker.ts";

const layout = `<script>import {onMount} from 'svelte';let {children}=$props();onMount(()=>{navigator.serviceWorker.register('/app/service-worker.js',{scope:'/app/',updateViaCache:'none'});});</script><main>{@render children()}</main><style>main{color:rgb(1,2,3)}</style>`;
const page = (value: string) =>
  `<script>import {onMount} from 'svelte';let count=$state(0);let hydrated=$state(false);onMount(()=>{hydrated=true;});</script><h1>${value}</h1><button data-hydrated={hydrated} onclick={()=>count++}>Count {count}</button>`;
const worker = `export function install(metadata){const name='velveteen-'+metadata.version;self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(name);await cache.addAll(metadata.files);await self.skipWaiting();})()));self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('velveteen-')&&key!==name)await caches.delete(key);await self.clients.claim();})()));self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith((async()=>{return (await caches.match(event.request,{cacheName:name,ignoreVary:true}))??fetch(event.request);})());});}`;

const fixture = await staticFixture(
  {
    "routes/+layout.svelte": layout,
    "routes/+page.svelte": page("A"),
    "routes/second/+page.svelte": page("Second A"),
  },
  "/app",
);
const portable = await mkdtemp(join(tmpdir(), "velveteen-static-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
const versions: string[] = [];
const workerSources: string[] = [];
async function disposeHost() {
  if (child) {
    child.kill();
    await child.exited;
  }
  await fixture.dispose();
  await rm(portable, { recursive: true, force: true });
}
afterAll(disposeHost);

async function prepareHost() {
  for (const [name, value] of [
    ["a", "A"],
    ["b", "B"],
  ]) {
    await fixture.write({
      "routes/+page.svelte": page(value),
      "routes/second/+page.svelte": page("Second " + value),
      "static/public.txt": "Public " + value,
      "worker.ts": worker,
    });
    const artifact = await prerender({
      generation: await fixture.build(),
      outputDirectory: fixture.outputDirectory,
    });
    const files = artifact.manifest.responses.map((response) => ({
      url: new URL(response.url).pathname,
      sha256: response.sha256,
    }));
    const compiled = await buildServiceWorker({
      outputDirectory: join(artifact.directory, "app"),
      base: "/app",
      build: value,
      files,
      prerendered: ["/app/", "/app/second"],
      install: join(fixture.root, "worker.ts"),
    });
    versions.push(compiled.metadata.version);
    workerSources.push(await Bun.file(compiled.file).text());
    await cp(artifact.directory, join(portable, name), { recursive: true });
    if (name === "b") {
      await cp(artifact.directory, join(portable, "c"), { recursive: true });
      await buildServiceWorker({
        outputDirectory: join(portable, "c/app"),
        base: "/app",
        build: "failing-install",
        files: [...files, { url: "/app/missing-install", sha256: "missing" }],
        prerendered: ["/app/", "/app/second"],
        install: join(fixture.root, "worker.ts"),
      });
    }
  }
  const host = join(fixture.root, "host.ts");
  await Bun.write(
    host,
    `import {join} from 'node:path';import {createStaticHandler} from ${JSON.stringify(resolve("src/prerender/serve.ts"))};const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(request){const current=await Bun.file('current').text();if(!['a','b','c'].includes(current))throw Error('Invalid fixture pointer');if(new URL(request.url).pathname==='/app/service-worker.js')return new Response(Bun.file(join(current,'app/service-worker.js')),{headers:{'content-type':'text/javascript','cache-control':'no-cache'}});const manifest=await Bun.file(join(current,'static-manifest.json')).json();return createStaticHandler(current,manifest)(request);}});console.log(server.port);`,
  );
  const built = await Bun.build({
    entrypoints: [host],
    outdir: portable,
    target: "bun",
    packages: "bundle",
  });
  if (!built.success || built.logs.length)
    throw new AggregateError(built.logs, "Static host build failed");
  await Bun.write(join(portable, "current"), "a");
  await fixture.dispose();
  const executable = process.execPath;
  child = spawnWithHangGuard([executable, join(portable, "host.js")], {
    cwd: portable,
    env: { PATH: resolve(executable, "..") },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!child.stdout || typeof child.stdout === "number")
    throw new Error("Missing host stdout");
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      const stderr = child.stderr;
      throw new Error(
        "Static host stopped before ready: " +
          (stderr && typeof stderr !== "number"
            ? await new Response(stderr).text()
            : ""),
      );
    }
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return `http://127.0.0.1:${Number(output.trim())}`;
}
const origin = await prepareHost().catch(async (error) => {
  await disposeHost();
  throw error;
});

test("H03: copied source-free static output hydrates offline, then activates new bytes and retires only its old cache", async () => {
  expect(versions[0]).not.toBe(versions[1]);
  for (const workerSource of workerSources)
    expect(workerSource).not.toContain(fixture.root);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const tab = await context.newPage();
    // Prerendered text is visible before the client attaches the click handler.
    const counter = tab.locator('button[data-hydrated="true"]');
    const diagnostics: string[] = [];
    const expectedDiagnostics: string[] = [];
    const failedRequests: string[] = [];
    tab.on("requestfailed", (request) => failedRequests.push(request.url()));
    tab.on("pageerror", (error) => diagnostics.push(error.message));
    tab.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        if (
          message.location().url === origin + "/app/missing" &&
          /^Failed to load resource: net::ERR_(FAILED|INTERNET_DISCONNECTED)$/.test(
            message.text(),
          )
        )
          expectedDiagnostics.push(message.text());
        else diagnostics.push(message.text());
      }
    });
    await tab.goto(origin + "/app/");
    await tab.evaluate(() => navigator.serviceWorker.ready);
    await tab.reload();
    expect(
      await tab.evaluate(() => navigator.serviceWorker.controller !== null),
    ).toBe(true);
    await browserExpect(tab.locator("h1")).toHaveText("A");
    await counter.click();
    await browserExpect(counter).toHaveText("Count 1");
    expect(
      await tab
        .locator("main")
        .evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(1, 2, 3)");
    await tab.evaluate(() => caches.open("unrelated-application"));
    await context.setOffline(true);
    for (const [url, title] of [
      ["/app/", "A"],
      ["/app/second", "Second A"],
    ]) {
      await tab.goto(origin + url);
      await browserExpect(tab.locator("h1")).toHaveText(title);
      await counter.click();
      await browserExpect(counter).toHaveText("Count 1");
    }
    expect(
      await tab.evaluate(() =>
        fetch("/app/public.txt").then((response) => response.text()),
      ),
    ).toBe("Public A");
    expect(
      await tab.evaluate(() =>
        fetch("/app/missing").then(
          () => false,
          () => true,
        ),
      ),
    ).toBe(true);
    await context.setOffline(false);
    await Bun.write(join(portable, "current"), "b");
    await tab.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw Error("No registration");
      const changed = new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => resolve(),
          { once: true },
        ),
      );
      await registration.update();
      await changed;
      const active = registration.active;
      if (!active) throw Error("No active worker");
      const stateAtControllerChange = active.state;
      if (active.state !== "activated")
        await new Promise<void>((resolve, reject) => {
          active.addEventListener("statechange", () => {
            if (active.state === "activated") resolve();
            if (active.state === "redundant")
              reject(Error("Worker became redundant"));
          });
        });
      return { stateAtControllerChange, finalState: active.state };
    });
    expect(await tab.evaluate(() => caches.keys())).toEqual(
      expect.arrayContaining([
        "unrelated-application",
        `velveteen-${versions[1]}`,
      ]),
    );
    expect(await tab.evaluate(() => caches.keys())).not.toContain(
      `velveteen-${versions[0]}`,
    );
    await context.setOffline(true);
    await tab.goto(origin + "/app/");
    await browserExpect(tab.locator("h1")).toHaveText("B");
    await counter.click();
    await browserExpect(counter).toHaveText("Count 1");
    expect(
      await tab.evaluate(() =>
        fetch("/app/public.txt").then((response) => response.text()),
      ),
    ).toBe("Public B");
    expect(diagnostics).toEqual([]);
    expect(failedRequests).toEqual([origin + "/app/missing"]);
    expect(expectedDiagnostics).toHaveLength(1);
    await Bun.write(
      resolve(".velveteen/evidence/h03-static-browser.json"),
      JSON.stringify(
        {
          versions,
          portableOutsideProject: portable.startsWith(tmpdir()),
          sourceRemoved: true,
          offlineDocuments: ["A", "Second A", "B"],
          publicAssets: ["Public A", "Public B"],
          retainedCache: "unrelated-application",
          retiredCache: versions[0],
          expectedDiagnostics,
          failedRequests,
          unexpectedDiagnostics: diagnostics,
        },
        null,
        2,
      ),
    );
    await context.setOffline(false);
    await Bun.write(join(portable, "current"), "c");
    const failedInstall = await tab.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw Error("No registration");
      const previous = registration.active;
      const rejected = new Promise<string>((resolve, reject) => {
        registration.addEventListener(
          "updatefound",
          () => {
            const worker = registration.installing;
            if (!worker) {
              reject(Error("No installing worker"));
              return;
            }
            worker.addEventListener("statechange", () => {
              if (worker.state === "redundant") resolve(worker.state);
              if (worker.state === "activated")
                reject(Error("Invalid install activated"));
            });
          },
          { once: true },
        );
      });
      await registration.update();
      return {
        state: await rejected,
        retained: registration.active === previous,
      };
    });
    expect(failedInstall).toEqual({ state: "redundant", retained: true });
    await context.close();
  } finally {
    await browser.close();
  }
});
