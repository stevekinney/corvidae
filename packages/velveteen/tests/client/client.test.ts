import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { stringify } from "devalue";
import { createSveltePlugin } from "../../src/compiler/index.ts";
import type {
  ClientApplication,
  ClientOptions,
} from "../../src/client/types.ts";

declare global {
  var client: {
    state: { page: { payload: { url: string } } };
    goto(url: string): Promise<void>;
    invalidate(value: string): Promise<void>;
    dispose(): Promise<void>;
  };
}
declare global {
  var startClient: (
    registry: unknown,
    options?: ClientOptions,
  ) => Promise<ClientApplication>;
  var registry: unknown;
  var ensureStylesheets: typeof import("../../src/client/styles.ts").ensureStylesheets;
}

const payload = (url: string, value: string) => ({
  version: 1,
  url,
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
      data: { value },
      uses: {
        params: [],
        search: [],
        url: [],
        dependencies: [new URL("/dep:count", url).href],
        parent: false,
        route: false,
      },
      skip: false,
    },
  ],
  branch: [{ node: 0, role: "page" }],
  fetched: [],
});

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let temporary: string;
let releaseSlow: (() => void) | undefined;
let requests: string[] = [];
beforeAll(async () => {
  temporary = await mkdtemp(
    join(process.cwd(), ".velveteen/build/client-test-"),
  );
  await mkdir(join(temporary, "src"), { recursive: true });
  await Bun.write(
    join(temporary, "src/Page.svelte"),
    `<script>let { data } = $props();</script><p data-value>{data.value}</p>`,
  );
  await Bun.write(
    join(temporary, "entry.ts"),
    `import { startClient } from ${JSON.stringify(join(process.cwd(), "src/client/index.ts"))}; import { ensureStylesheets } from ${JSON.stringify(join(process.cwd(), "src/client/styles.ts"))}; import Root from ${JSON.stringify(join(process.cwd(), "src/client/root.svelte"))}; import Page from './src/Page.svelte'; const manifest={version:1,nodes:[{id:'/',directory:'/',parentId:null,params:[],page:{component:'Page.svelte'}}],routes:[{id:'/',pattern:'^/(?:next|slow-a|fast)?$',params:[],node:0,leaf:0,ancestors:[0],layouts:[null],errors:[null]}]}; const registry={Root,nodes:[{page:async()=>({default:Page})}],manifest}; globalThis.registry=registry; globalThis.startClient=startClient; globalThis.ensureStylesheets=ensureStylesheets; if(!location.search.includes('manual')) globalThis.client=await startClient(registry,{initial:JSON.parse(document.querySelector('#velveteen-data').textContent)});`,
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
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/broken.css")
        return new Response("missing", { status: 404 });
      if (
        url.pathname === "/" &&
        !request.headers.get("accept")?.includes("application/x-velveteen-data")
      )
        return new Response(
          `<div id="app"></div><script id="velveteen-data" type="application/json">${JSON.stringify(payload(url.href, "initial"))}</script><script type="module" src="/bundle.js"></script>`,
          { headers: { "content-type": "text/html" } },
        );
      requests.push(
        `${url.pathname}:${request.headers.get("x-velveteen-loads") ?? "missing"}`,
      );
      if (url.pathname === "/next")
        return new Response(stream(payload(url.href, "next"), false), {
          headers: { "content-type": "application/x-velveteen-data" },
        });
      if (url.pathname === "/slow-a")
        return new Response(stream(payload(url.href, "slow"), true), {
          headers: { "content-type": "application/x-velveteen-data" },
        });
      if (url.pathname === "/fast")
        return new Response(stream(payload(url.href, "fast"), false), {
          headers: { "content-type": "application/x-velveteen-data" },
        });
      return new Response(stream(payload(url.href, "initial"), false), {
        headers: { "content-type": "application/x-velveteen-data" },
      });
    },
  });
  function stream(value: unknown, slow: boolean) {
    const encoded = stringify(value);
    let canceled = false;
    return new ReadableStream({
      start(controller) {
        const close = () => {
          if (!canceled) controller.close();
        };
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ type: "initial", value: encoded }) + "\n",
          ),
        );
        if (slow)
          new Promise<void>((resolve) => {
            releaseSlow = resolve;
          }).then(close);
        else close();
      },
      cancel() {
        canceled = true;
      },
    });
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`http://localhost:${server.port}/`);
  await page.waitForSelector("[data-value]");
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
  await rm(temporary, { recursive: true, force: true });
});

test("commits streamed navigation before settlement", async () => {
  await page.evaluate(() => {
    void globalThis.client.goto("/next");
  });
  await page.waitForFunction(() =>
    globalThis.client.state.page.payload.url.endsWith("/next"),
  );
  await page.waitForFunction(
    () => document.querySelector("[data-value]")?.textContent === "next",
  );
});

test("stale navigation cannot overwrite the newer result", async () => {
  await page.evaluate(() => {
    void globalThis.client.goto("/slow-a");
    void globalThis.client.goto("/fast");
  });
  await page.waitForFunction(
    () => document.querySelector("[data-value]")?.textContent === "fast",
  );
  releaseSlow?.();
});

test("invalidation sends only the tracked load keys", async () => {
  requests = [];
  await page.evaluate(() => globalThis.client.invalidate("/dep:count"));
  expect(requests.at(-1) ?? "").toContain("0:page");
});

test("failed stylesheets are removed so a subsequent retry can start cleanly", async () => {
  await page.evaluate(async () => {
    const controller = new AbortController();
    await globalThis
      .ensureStylesheets(["/broken.css"], controller.signal)
      .catch(() => {});
    if (document.querySelector('link[href$="/broken.css"]'))
      throw new Error("Failed stylesheet link was retained");
    await globalThis
      .ensureStylesheets(["/broken.css"], controller.signal)
      .catch(() => {});
  });
  expect(await page.locator('link[href$="/broken.css"]').count()).toBe(0);
});

test("CSR false leaves server HTML untouched and installs no client handlers", async () => {
  const noClient = await browser.newPage();
  await noClient.goto(`http://localhost:${server.port}/?manual`);
  await noClient.evaluate(() =>
    globalThis.startClient(globalThis.registry, {
      csr: false,
      initial: JSON.parse(
        document.querySelector("#velveteen-data")!.textContent!,
      ),
    }),
  );
  expect(await noClient.locator("#app").locator("*").count()).toBe(0);
  await noClient.close();
});

test("beforeNavigate cancellation restores a canceled popstate", async () => {
  const canceled = await browser.newPage();
  await canceled.goto(`http://localhost:${server.port}/?manual`);
  await canceled.evaluate(async () => {
    let block = false;
    const initial = JSON.parse(
      document.querySelector("#velveteen-data")!.textContent!,
    );
    globalThis.client = await globalThis.startClient(globalThis.registry, {
      target: document.querySelector("#app")!,
      initial,
      beforeNavigate: ({ cancel }: { cancel: () => void }) => {
        if (block) cancel();
      },
    });
    await globalThis.client.goto("/next");
    await globalThis.client.goto("/fast");
    block = true;
    await globalThis.client.goto("/next");
    history.back();
  });
  await canceled.waitForFunction(() => location.pathname === "/fast");
  expect(await canceled.locator("[data-value]").textContent()).toBe("fast");
  await canceled.close();
});

test("dispose transfers navigation ownership and removes the second handler", async () => {
  await page.evaluate(() => globalThis.client.dispose());
  await page.evaluate(async () => {
    document.querySelector("#app")!.replaceChildren();
    globalThis.client = await globalThis.startClient(globalThis.registry, {
      target: document.querySelector("#app")!,
      initial: JSON.parse(
        document.querySelector("#velveteen-data")!.textContent!,
      ),
    });
  });
  requests = [];
  await page.evaluate(() => {
    window.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    const anchor = document.createElement("a");
    anchor.href = "/next";
    anchor.textContent = "next";
    document.body.append(anchor);
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
    );
  });
  await page.waitForFunction(() =>
    globalThis.client.state.page.payload.url.endsWith("/next"),
  );
  expect(requests).toHaveLength(1);
  expect(await page.locator("[data-value]").textContent()).toBe("next");

  await page.evaluate(async () => {
    await globalThis.client.dispose();
    document.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    const anchor = document.querySelector("a[href='/next']")!;
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }),
    );
  });
  await page.evaluate(
    () => new Promise<void>((resolve) => queueMicrotask(resolve)),
  );
  expect(requests).toHaveLength(1);
  await page.evaluate(() => dispatchEvent(new PopStateEvent("popstate")));
  await page.evaluate(
    () => new Promise<void>((resolve) => queueMicrotask(resolve)),
  );
  expect(requests).toHaveLength(1);
});

test("G03: destroying an enhanced form aborts application work even when its fetch ignores cancellation", async () => {
  await page.goto(server.url.href + "?manual");
  await page.waitForFunction(() => typeof window.startClient === "function");
  const diagnostics: string[] = [];
  const onError = (error: Error) => diagnostics.push(error.message);
  page.on("pageerror", onError);
  const encoded =
    JSON.stringify({
      type: "initial",
      value: stringify(
        payload(new URL("/fast", server.url).href, "stale action"),
      ),
    }) + "\n";
  try {
    await page.evaluate(async (encoded) => {
      const initial = JSON.parse(
        document.querySelector("#velveteen-data")!.textContent!,
      );
      const pending = Promise.withResolvers<Response>();
      const errors: string[] = [];
      const app = await window.startClient(window.registry, {
        initial,
        onError: (error) => errors.push(String(error)),
        fetch: async () => {
          Reflect.set(window, "formFetchStarted", true);
          return pending.promise;
        },
      });
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/fast";
      document.body.append(form);
      const destroyed = app.enhance(form).destroy;
      Reflect.set(window, "finishDisposedForm", () => {
        destroyed();
        pending.resolve(
          new Response(encoded, {
            headers: { "content-type": "application/x-velveteen-data" },
          }),
        );
      });
      Reflect.set(window, "disposedFormErrors", errors);
      Reflect.set(window, "disposedFormApp", app);
      form.requestSubmit();
    }, encoded);
    await page.waitForFunction(
      () => Reflect.get(window, "formFetchStarted") === true,
    );
    await page.evaluate(() => Reflect.get(window, "finishDisposedForm")());
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await page.locator("[data-value]").textContent()).toBe("initial");
    expect(
      await page.evaluate(() => Reflect.get(window, "disposedFormErrors")),
    ).toEqual([]);
    expect(diagnostics).toEqual([]);
  } finally {
    page.off("pageerror", onError);
    await page.evaluate(() =>
      Reflect.get(window, "disposedFormApp")?.dispose(),
    );
  }
});
