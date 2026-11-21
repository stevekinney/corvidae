import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import { createApplication } from "../../src/server/index.ts";
import type { RemoteDefinitions } from "../../src/remote/server.ts";

test("G02: real browser typed client calls an authenticated host and invalidates actual page data without importing private handlers", async () => {
  const parent = resolve(".velveteen/remotes");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "browser-"));
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const browser = await chromium.launch();
  try {
    const routes = join(root, "routes");
    await mkdir(routes);
    await Bun.write(
      join(root, "remotes.server.ts"),
      `import {defineRemote} from ${JSON.stringify(resolve("src/remote/server.ts"))};const secret='PRIVATE_REMOTE_IMPLEMENTATION_SENTINEL';export const remotes={add:defineRemote({kind:'command',validate:(value:unknown)=>{if(typeof value!=='number')throw new Error(secret);return value;},handle:(value,event)=>{const count=Number(event.cookies.get('count')??0)+value;event.cookies.set('count',String(count),{path:'/'});return {count};}})};`,
    );
    await Bun.write(
      join(routes, "+page.server.ts"),
      "export const load=({cookies})=>({count:Number(cookies.get('count')??0)});",
    );
    const component = `<script lang="ts">import type {remotes} from '../remotes.server.ts';import {createRemoteClient} from ${JSON.stringify(resolve("src/remote/client.ts"))};import {getNavigation} from ${JSON.stringify(resolve("src/client/navigation-context.ts"))};let {data}=$props();let result=$state('Ready');const navigation=getNavigation();async function add(){const client=createRemoteClient<typeof remotes>({baseURL:location.origin+'/base/',invalidate:()=>navigation.invalidateAll()});const value=await client.call('add',2);result='Remote '+value.count;}</script><h1>Count {data.count}</h1><button onclick={add}>Add</button><p>{result}</p>`;
    await Bun.write(join(routes, "+page.svelte"), component);
    const generation = await buildProduction({
      projectDirectory: root,
      routesDirectory: routes,
      outputDirectory: join(root, "output"),
      basePath: "/base",
    });
    for (const asset of generation.manifest.assets.filter(
      (asset) => asset.target === "browser",
    ))
      expect(
        await Bun.file(join(generation.directory, asset.file)).text(),
      ).not.toContain("PRIVATE_REMOTE_IMPLEMENTATION_SENTINEL");
    const { remotes } = (await import(join(root, "remotes.server.ts"))) as {
      remotes: RemoteDefinitions;
    };
    let hooks = 0;
    app = await createApplication({
      generation,
      remotes,
      hooks: {
        handle: ({ event, resolve }) => {
          hooks++;
          if (
            event.url.pathname.includes("/_remote/") &&
            !event.cookies.get("authorized")
          )
            return new Response("Unauthorized", { status: 401 });
          event.cookies.set("authorized", "yes", { path: "/" });
          return resolve();
        },
      },
    });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const page = await browser.newPage();
    const diagnostics: string[] = [];
    page.on("pageerror", (error) => diagnostics.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.push(message.text());
    });
    await page.goto(new URL("/base/", server.url).href);
    await browserExpect(page.locator("h1")).toHaveText("Count 0");
    await page.evaluate(() =>
      Object.assign(window, { remoteDocument: "same" }),
    );
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await browserExpect(page.locator("h1")).toHaveText("Count 2");
    await browserExpect(page.locator("p")).toHaveText("Remote 2");
    expect(
      await page.evaluate(() => Reflect.get(window, "remoteDocument")),
    ).toBe("same");
    expect(hooks).toBe(3);
    expect(diagnostics).toEqual([]);
  } finally {
    await browser.close();
    await server?.stop(true);
    await app?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
