import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import {
  originalPositionFor,
  sourceContentFor,
  TraceMap,
} from "@jridgewell/trace-mapping";
import type { render } from "svelte/server";
import { compileComponent, createSveltePlugin } from "./index";

test("production client and SSR builds hydrate typed rune components without a DOM", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "production-"));
  const source = `<script lang="ts">import { createCounter } from './counter.svelte.ts'; const counter = createCounter();</script><button onclick={() => counter.increment()}>Original: {counter.value}</button><style>button { color: rgb(1, 2, 3); }</style>`;
  try {
    await mkdir(join(directory, "src"));
    await Bun.write(join(directory, "src/App.svelte"), source);
    await Bun.write(
      join(directory, "src/counter.svelte.ts"),
      "export function createCounter() { let value: number = $state(0); return { get value() { return value }, increment() { value += 1 } }; }",
    );
    await Bun.write(
      join(directory, "src/main.ts"),
      "import { hydrate, mount } from 'svelte'; import App from './App.svelte'; const target = document.querySelector('#app')!; if (target.hasChildNodes()) hydrate(App, { target, recover: false }); else mount(App, { target });",
    );
    await Bun.write(
      join(directory, "src/server.ts"),
      "import { render } from 'svelte/server'; import App from './App.svelte'; export function renderPage() { return render(App); }",
    );
    const browserBuild = await Bun.build({
      entrypoints: [join(directory, "src/main.ts")],
      outdir: join(directory, "browser"),
      target: "browser",
      plugins: [createSveltePlugin()],
    });
    const serverBuild = await Bun.build({
      entrypoints: [join(directory, "src/server.ts")],
      outdir: join(directory, "server"),
      target: "bun",
      plugins: [createSveltePlugin({ target: "server" })],
    });
    expect(browserBuild.success).toBe(true);
    expect(serverBuild.success).toBe(true);
    const serverModule = await import(join(directory, "server/server.js"));
    const rendered = serverModule.renderPage() as ReturnType<typeof render>;
    expect(rendered.body).toContain("Original: 0");
    expect(typeof globalThis.document).toBe("undefined");
    const browser = await chromium.launch();
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/main.js")
          return new Response(Bun.file(join(directory, "browser/main.js")), {
            headers: { "content-type": "text/javascript" },
          });
        if (pathname.endsWith(".css"))
          return new Response(
            Bun.file(join(directory, "browser", pathname.slice(1))),
            { headers: { "content-type": "text/css" } },
          );
        return new Response(
          `<!doctype html><link rel="stylesheet" href="/main.css"><div id="app">${rendered.body}</div><script type="module" src="/main.js"></script>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type()))
          errors.push(message.text());
      });
      await page.goto(server.url.href);
      await playwrightExpect(page.getByRole("button")).toHaveText(
        "Original: 0",
      );
      await playwrightExpect(page.getByRole("button")).toHaveCSS(
        "color",
        "rgb(1, 2, 3)",
      );
      await page.getByRole("button").click();
      await playwrightExpect(page.getByRole("button")).toHaveText(
        "Original: 1",
      );
      expect(errors).toEqual([]);
      await page.close();
    } finally {
      await server.stop(true);
      await browser.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("component diagnostics preserve the source filename", () => {
  const result = compileComponent("<h1>ok</h1>", {
    filename: "proof/App.svelte",
    target: "client",
  });
  expect(result.map).toContain("App.svelte");
});

test("served production maps map component and rune browser stacks to original lines", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "maps-"));
  try {
    await mkdir(join(directory, "src"));
    const component = `<script lang="ts">\n\n\n\n\n\n\n\n\n\nfunction explode() { throw new Error("component-map-probe"); }\n</script>\n<button onclick={explode}>Map probe</button><button onclick={() => (globalThis as any).explodeRune()}>Rune probe</button>`;
    const rune = `export function explodeRune() {\n  const typed: number = 1;\n\n\n\n\n  throw new Error("rune-map-probe");\n}`;
    await Bun.write(join(directory, "src/App.svelte"), component);
    await Bun.write(join(directory, "src/rune.svelte.ts"), rune);
    await Bun.write(
      join(directory, "src/main.ts"),
      "import { mount } from 'svelte'; import App from './App.svelte'; import { explodeRune } from './rune.svelte.ts'; (globalThis as any).explodeRune = explodeRune; mount(App, { target: document.querySelector('#app')! });",
    );
    const build = await Bun.build({
      entrypoints: [join(directory, "src/main.ts")],
      outdir: join(directory, "out"),
      target: "browser",
      sourcemap: "external",
      plugins: [createSveltePlugin()],
    });
    expect(build.success).toBe(true);
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/")
          return new Response(
            `<!doctype html><div id="app"></div><script type="module" src="/main.js"></script>`,
            { headers: { "content-type": "text/html" } },
          );
        return new Response(Bun.file(join(directory, "out", path.slice(1))));
      },
    });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) =>
        errors.push(error.stack ?? error.message),
      );
      await page.goto(server.url.href);
      const mapStack = async (
        trigger: () => Promise<void>,
        message: string,
        sourceName: string,
        line: number,
      ) => {
        errors.length = 0;
        await trigger();
        await Bun.sleep(50);
        const stack = errors.find((value) => value.includes(message)) ?? "";
        const match = stack.match(/\/main\.js:(\d+):(\d+)/);
        expect(match).not.toBeNull();
        const fetchedResponse = await fetch(new URL("/main.js", server.url));
        const generated = await fetchedResponse.text();
        const sourceMapMatch = generated.match(/sourceMappingURL=([^\s]+)/);
        const mapURL = new URL(
          sourceMapMatch?.[1] ?? "/main.js.map",
          server.url,
        );
        const fetchedResponse2 = await fetch(mapURL);
        const map = await fetchedResponse2.json();
        const position = originalPositionFor(new TraceMap(map, mapURL.href), {
          line: Number(match![1]),
          column: Number(match![2]) - 1,
        });
        expect(position.source).toContain(sourceName);
        expect(position.line).toBe(line);
        const source = map.sources.find((value: string) =>
          value.includes(sourceName),
        );
        expect(source).toBeDefined();
        expect(sourceContentFor(new TraceMap(map), source)).toContain(message);
        const broken = { ...map, mappings: "" };
        expect(
          originalPositionFor(new TraceMap(broken), {
            line: Number(match![1]),
            column: Number(match![2]) - 1,
          }).source,
        ).toBeNull();
      };
      await mapStack(
        () => page.getByRole("button", { name: "Map probe" }).click(),
        "component-map-probe",
        "App.svelte",
        11,
      );
      await mapStack(
        () => page.getByRole("button", { name: "Rune probe" }).click(),
        "rune-map-probe",
        "rune.svelte.ts",
        7,
      );
    } finally {
      await browser.close();
      await server.stop(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
