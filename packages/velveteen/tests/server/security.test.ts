import { expect, test } from "bun:test";
import type { Component } from "svelte";
import type { ProductionGeneration } from "../../src/build/manifest-types.ts";
import type { RootProps } from "../../src/data/contract.ts";
import type {
  ApplicationOptions,
  ServerRegistry,
} from "../../src/server/types.ts";
import { createApplication, getRequestEvent } from "../../src/server/index.ts";

const component = {} as Component<Record<string, unknown>>;
const manifest = {
  version: 1 as const,
  nodes: [
    {
      id: "/",
      directory: "",
      parentId: null,
      params: [],
      page: { component: "routes/+page.svelte" },
      layout: { component: "routes/+layout.svelte" },
    },
  ],
  routes: [
    {
      id: "/",
      pattern: "^/$",
      params: [],
      node: 0,
      leaf: 0,
      ancestors: [0],
      layouts: [0],
      errors: [null],
    },
  ],
};
const generation = (basePath = ""): ProductionGeneration => ({
  directory: "/tmp/velveteen-security-generation",
  manifest: {
    version: 1,
    basePath,
    routing: manifest,
    client: {
      file: "browser/client.js",
      url: "/client.js",
      stylesheets: [],
      nodes: {},
    },
    server: { file: "server/server.js", nodes: {} },
    routes: { "/": { stylesheets: [] } },
    assets: [],
    outputs: [],
  },
});
const registry = (
  node: ServerRegistry["nodes"][number] = {},
): ServerRegistry => ({
  manifest,
  nodes: [
    {
      layout: async () => ({ default: component }),
      page: async () => ({ default: component }),
      ...node,
    },
  ],
  Root: component as Component<RootProps>,
  render: () => ({ body: "<p>ok</p>", head: "" }),
});
const options = (
  hooks: ApplicationOptions["hooks"],
  node?: ServerRegistry["nodes"][number],
): ApplicationOptions => ({
  generation: generation(),
  registry: registry(node),
  hooks,
});

test("isolates locals and request context across overlapping awaited requests", async () => {
  const seen: string[] = [];
  const app = await createApplication(
    options({
      handle: async ({ event }) => {
        const id = event.request.headers.get("x-request")!;
        event.locals.id = id;
        await new Promise((resolve) => setTimeout(resolve, id === "a" ? 5 : 0));
        expect(getRequestEvent()).toBe(event);
        seen.push(String(event.locals.id));
        return new Response(id);
      },
    }),
  );
  await Promise.all([
    app.fetch(
      new Request("http://app.test/", { headers: { "x-request": "a" } }),
    ),
    app.fetch(
      new Request("http://app.test/", { headers: { "x-request": "b" } }),
    ),
  ]);
  expect(seen.sort()).toEqual(["a", "b"]);
});

test("runs init once and rejects request context outside a request", async () => {
  let initialized = 0;
  const app = await createApplication(
    options({
      init: () => {
        initialized++;
      },
      handle: async () => new Response("ok"),
    }),
  );
  await app.fetch(new Request("http://app.test/"));
  await app.fetch(new Request("http://app.test/"));
  expect(initialized).toBe(1);
  expect(() => getRequestEvent()).toThrow("outside a request");
});

test("applies secure cookie defaults and propagates multiple Set-Cookie values", async () => {
  const app = await createApplication(
    options({
      handle: async ({ event }) => {
        event.cookies.set("session", "yes", { path: "/account" });
        event.cookies.set("theme", "dark", { path: "/" });
        event.cookies.delete("old", { path: "/" });
        return new Response("ok");
      },
    }),
  );
  const response = await app.fetch(new Request("https://app.test/"));
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(3);
  expect(cookies.join("\n")).toContain("session=yes");
  expect(cookies.join("\n")).toContain("Path=/account");
  expect(cookies.join("\n")).toContain("HttpOnly");
  expect(cookies.join("\n")).toContain("Secure");
  expect(cookies.join("\n")).toContain("old=;");
  expect(cookies.join("\n")).toContain("Max-Age=0");
});

test("preserves internal method, body, headers and credential boundaries", async () => {
  const observations: Array<{
    url: string;
    method: string;
    body: string;
    cookie: string | null;
    authorization: string | null;
  }> = [];
  const app = await createApplication(
    options({
      handleFetch: async ({ request }) => {
        observations.push({
          url: request.url,
          method: request.method,
          body: await request.text(),
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
        });
        return new Response("captured");
      },
      handle: async ({ event }) => {
        await event.fetch("http://app.test/echo", {
          method: "POST",
          headers: { "x-test": "yes" },
          body: "bytes",
        });
        await event.fetch("http://app.test/omit", {
          method: "POST",
          credentials: "omit",
          body: "no-cookie",
        });
        await event.fetch("https://external.test/remote", {
          headers: { authorization: "explicit" },
        });
        return new Response("ok");
      },
    }),
  );
  await app.fetch(
    new Request("http://app.test/", {
      headers: { cookie: "ambient=1", authorization: "ambient-token" },
    }),
  );
  expect(observations[0]).toMatchObject({
    method: "POST",
    body: "bytes",
    cookie: "ambient=1",
    authorization: "ambient-token",
  });
  expect(observations[1]).toMatchObject({
    method: "POST",
    body: "no-cookie",
    cookie: null,
  });
  expect(observations[2]).toMatchObject({
    url: "https://external.test/remote",
    authorization: "explicit",
    cookie: null,
  });
});

test("aborts waiting loads and response bodies, and disposal rejects new work", async () => {
  let waitingSignal: AbortSignal | undefined;
  const app = await createApplication(
    options({
      handle: async ({ event }) => {
        waitingSignal = event.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
          }),
        );
      },
    }),
  );
  const response = await app.fetch(new Request("http://app.test/"));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("consumer canceled");
  expect(waitingSignal?.aborted).toBe(true);
  await app.dispose();
  expect((await app.fetch(new Request("http://app.test/"))).status).toBe(503);
});

test("malformed route encoding is 400 while application URI errors remain 500", async () => {
  const app = await createApplication(
    options(undefined, {
      pageServer: async () => ({
        load() {
          throw new URIError("application failure");
        },
      }),
    }),
  );
  try {
    const malformed = await app.fetch(new Request("http://app.test/%E0"));
    expect(malformed.status).toBe(400);
    await malformed.text();
    const applicationFailure = await app.fetch(new Request("http://app.test/"));
    expect(applicationFailure.status).toBe(500);
    await applicationFailure.text();
  } finally {
    await app.dispose();
  }
});
