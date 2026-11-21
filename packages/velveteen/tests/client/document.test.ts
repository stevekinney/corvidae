import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createSveltePlugin } from "../../src/compiler/index.ts";
import { encodePayload } from "../../src/data/codec.ts";
import { fetchKey, loadRequest } from "../../src/data/fetch.ts";

const pagePayload = {
  version: 1,
  url: "http://localhost:0/",
  basePath: "",
  stylesheets: [],
  routeId: "/",
  params: {},
  status: 200,
  error: null,
  options: { ssr: true, csr: true },
  nodes: [
    {
      key: "0:page",
      node: 0,
      role: "page",
      data: {},
      uses: {
        params: [],
        search: [],
        url: [],
        dependencies: [],
        parent: false,
        route: false,
      },
    },
  ],
  branch: [{ node: 0, role: "page" }],
  fetched: [],
};
let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let temporary: string;
let settlementFrame: unknown;
beforeAll(async () => {
  temporary = await mkdtemp(
    join(process.cwd(), ".velveteen/build/document-test-"),
  );
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const truncated = encodePayload({
    ...pagePayload,
    nodes: [
      { ...pagePayload.nodes[0], data: { pending: new Promise(() => {}) } },
    ],
  });
  const encoded = encodePayload({
    ...pagePayload,
    nodes: [
      {
        ...pagePayload.nodes[0],
        data: { first: first.promise, second: second.promise },
      },
    ],
  });
  const captureURL = "https://capture.test/";
  const prerendered = encodePayload({
    ...pagePayload,
    url: captureURL,
    prerendered: true,
    fetched: [
      {
        key: await fetchKey(loadRequest("/captured", undefined, captureURL)),
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/plain"]],
        body: new TextEncoder().encode("captured"),
      },
    ],
  });
  const reader = encoded.settlements.getReader();
  first.resolve("one");
  const firstFrame = (await reader.read()).value;
  second.resolve("two");
  settlementFrame = (await reader.read()).value;
  await mkdir(join(temporary, "build"), { recursive: true });
  await Bun.write(
    join(temporary, "page.svelte"),
    "<script>let {data}=$props();</script><p data-captured>{data.captured}</p><p data-second>{data.second}</p>{#await data.pending}<p>Pending</p>{:then value}<p>{value}</p>{:catch error}<p>{error.message}</p>{/await}",
  );
  await Bun.write(
    join(temporary, "entry.ts"),
    `import {startClient} from ${JSON.stringify(join(process.cwd(), "src/client/index.ts"))};import Root from ${JSON.stringify(join(process.cwd(), "src/client/root.svelte"))};import Page from './page.svelte';
const prerendered=new URLSearchParams(location.search).has('prerendered');const node={page:async()=>({default:Page})};if(prerendered)node.pageUniversal=async()=>({load:async({fetch})=>({captured:await (await fetch('/captured')).text()})});if(location.pathname==='/early')node.pageUniversal=async()=>({load:async({data})=>({second:await data.second})});const registry={Root,nodes:[node],manifest:{version:1,nodes:[],routes:[{id:'/',pattern:'^/$',params:[],node:0,leaf:0,ancestors:[0],layouts:[null],errors:[null]}]}};globalThis.startClient=startClient;globalThis.registry=registry;
import { readInitialDocument } from ${JSON.stringify(join(process.cwd(), "src/client/document.ts"))}; if(prerendered||['/client-truncated','/early'].includes(location.pathname)){globalThis.session=await startClient(registry,{onError:error=>globalThis.documentError=String(error)});} else if(location.pathname==='/malformed'){try{readInitialDocument()}catch(error){globalThis.documentError=String(error)}} else if(location.pathname==='/truncated'){const session=readInitialDocument(); globalThis.session=session; session.activate((error)=>globalThis.documentError=String(error));} else {const session=readInitialDocument(); globalThis.session=session; const values=session.payload.nodes[0].data; session.activate((error)=>globalThis.documentError=String(error)); globalThis.values=values; if(location.pathname!=='/early'){const script=document.createElement('script'); script.type='application/json'; script.dataset.velveteenSettlement=''; script.textContent=${JSON.stringify(JSON.stringify(settlementFrame))}; document.body.append(script);}}`,
  );
  const built = await Bun.build({
    entrypoints: [join(temporary, "entry.ts")],
    outdir: join(temporary, "build"),
    target: "browser",
    splitting: false,
    plugins: [createSveltePlugin()],
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  const bundle = await Bun.file(join(temporary, "build/entry.js")).text();
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/entry.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/captured") return new Response("network");
      const isPrerendered = url.searchParams.has("prerendered");
      const initial = isPrerendered
        ? JSON.stringify(prerendered.initial)
        : url.pathname === "/malformed"
          ? "not-json"
          : ["/truncated", "/client-truncated"].includes(url.pathname)
            ? JSON.stringify(truncated.initial)
            : JSON.stringify(encoded.initial);
      const script = `<script id="velveteen-data" type="application/json">${initial}</script>${!isPrerendered && ["/", "/early"].includes(url.pathname) ? `<script type="application/json" data-velveteen-settlement>${JSON.stringify(firstFrame)}</script>${url.pathname === "/early" ? `<script type="application/json" data-velveteen-settlement>${JSON.stringify(settlementFrame)}</script>` : ""}` : ""}<script type="module" src="/entry.js"></script>`;
      return new Response(
        `<!doctype html><body><div id="app"></div>${script}</body>`,
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.on("pageerror", (error) => console.error("document pageerror", error));
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
  await rm(temporary, { recursive: true, force: true });
});

test("reads one decoder, applies existing and streamed settlements, and disposes observers", async () => {
  await page.goto(`http://localhost:${server.port}/`);
  await page.waitForFunction(
    async () =>
      (await (
        globalThis as typeof globalThis & {
          values?: { first: Promise<string>; second: Promise<string> };
        }
      ).values?.second) === "two",
  );
  expect(
    await page.evaluate(async () => {
      const values = (
        globalThis as typeof globalThis & {
          values: { first: Promise<string>; second: Promise<string> };
        }
      ).values;
      return { first: await values.first, second: await values.second };
    }),
  ).toEqual({ first: "one", second: "two" });
  await page.evaluate(() =>
    (
      globalThis as typeof globalThis & { session: { dispose(): void } }
    ).session.dispose(),
  );
  expect(await page.locator("script[data-velveteen-settlement]").count()).toBe(
    0,
  );
});

test("reports malformed initial frames", async () => {
  const malformed = await browser.newPage();
  await malformed.goto(`http://localhost:${server.port}/malformed`);
  await malformed.waitForFunction(() =>
    String(
      (globalThis as typeof globalThis & { documentError?: string })
        .documentError,
    ).includes("Malformed Velveteen initial data"),
  );
  await malformed.close();
});

test("reports truncated pending initial data at document completion", async () => {
  const truncated = await browser.newPage();
  await truncated.goto(`http://localhost:${server.port}/truncated`);
  await truncated.waitForFunction(() =>
    String(
      (globalThis as typeof globalThis & { documentError?: string })
        .documentError,
    ).includes("Data stream was truncated"),
  );
  await truncated.close();
});

test("activates document settlements before universal loads await them", async () => {
  const early = await browser.newPage();
  await early.goto(`http://localhost:${server.port}/early`);
  await early.waitForFunction(() =>
    Boolean((globalThis as typeof globalThis & { session?: unknown }).session),
  );
  expect(await early.locator("[data-second]").textContent()).toBe("two");
  await early.close();
});

test("replays prerendered fetches after the document moves to a different origin", async () => {
  const relocated = await browser.newPage();
  const networkRequests: string[] = [];
  relocated.on("request", (request) => {
    if (new URL(request.url()).pathname === "/captured")
      networkRequests.push(request.url());
  });
  try {
    await relocated.goto(`http://localhost:${server.port}/?prerendered`);
    expect(await relocated.locator("[data-captured]").textContent()).toBe(
      "captured",
    );
    expect(networkRequests).toEqual([]);
  } finally {
    await relocated.close();
  }
});

test("truncated HTML transport terminates the client page instead of claiming successful hydration", async () => {
  const client = await browser.newPage();
  const errors: string[] = [];
  client.on("pageerror", (error) => errors.push(error.message));
  try {
    await client.goto(`http://localhost:${server.port}/client-truncated`);
    await client.waitForFunction(
      () => Reflect.get(window, "session")?.state.page.payload.status === 500,
    );
    expect(
      await client.locator("[data-velveteen-error]").textContent(),
    ).toContain("Invalid page data");
    expect(
      await client.evaluate(() => Reflect.get(window, "documentError")),
    ).toContain("Data stream was truncated");
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});
