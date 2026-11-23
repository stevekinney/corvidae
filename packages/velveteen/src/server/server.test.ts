import { describe, expect, test } from "bun:test";
import { createApplication, sequence } from "./index.ts";
import type { ProductionGeneration } from "../build/manifest-types.ts";

const generation = (basePath = ""): ProductionGeneration => ({
  directory: "/tmp/velveteen-test-generation",
  manifest: {
    version: 1,
    basePath,
    routing: {
      version: 1,
      nodes: [
        {
          id: "/",
          directory: "",
          parentId: null,
          params: [],
          page: { component: "page.svelte" },
          layout: { component: "layout.svelte" },
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
    },
    client: {
      file: "browser/client.js",
      url: "/client.js",
      stylesheets: [],
      nodes: {},
    },
    server: { file: "server/server.js", nodes: {} },
    routes: {},
    assets: [],
    outputs: [],
  },
});

const registry = (seen: string[]) => ({
  manifest: generation().manifest.routing,
  nodes: [
    {
      layout: async () => ({ default: {} }),
      page: async () => ({ default: {} }),
      layoutServer: async () => ({ load: async () => ({ root: "ready" }) }),
      layoutUniversal: async () => ({
        load: async () => ({ universal: true }),
      }),
      pageServer: async () => ({
        load: async ({
          parent,
        }: {
          parent: () => Promise<Record<string, unknown>>;
        }) => {
          const value = await parent();
          seen.push(typeof value.root === "string" ? value.root : "");
          return { child: "ok" };
        },
      }),
    },
  ],
  Root: {},
  render: (_component: unknown, input: { props: unknown }) => ({
    body: JSON.stringify(input.props),
    head: "",
  }),
});

describe("server application", () => {
  test("waits for parent server loads before child parent()", async () => {
    const seen: string[] = [];
    const app = await createApplication({
      generation: generation(),
      registry: registry(seen) as never,
    });
    const response = await app.fetch(new Request("http://example.test/"));
    expect(response.status).toBe(200);
    expect(seen).toEqual(["ready"]);
  });

  test("strips base path before route matching", async () => {
    const app = await createApplication({
      generation: generation("/app"),
      registry: registry([]) as never,
    });
    const fetchedResponse = await app.fetch(
      new Request("http://example.test/app/"),
    );
    expect(fetchedResponse.status).toBe(200);
    const fetchedResponse2 = await app.fetch(
      new Request("http://example.test/"),
    );
    expect(fetchedResponse2.status).toBe(404);
  });

  test("does not abort a data response before its stream is consumed", async () => {
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
    });
    const response = await app.fetch(
      new Request("http://example.test/", {
        headers: { accept: "application/x-velveteen-data" },
      }),
    );
    const resolvedValue = await response.text();
    expect(resolvedValue.length).toBeGreaterThan(0);
  });

  test("keeps the empty sequence compatible with handle", async () => {
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      hooks: { handle: sequence() },
    });
    try {
      const fetchedResponse3 = await app.fetch(
        new Request("http://example.test/"),
      );
      expect(fetchedResponse3.status).toBe(200);
    } finally {
      await app.dispose();
    }
  });

  test("turns synchronous middleware failures into request failures", async () => {
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      hooks: {
        handle: sequence(() => {
          throw new Error("PRIVATE_MIDDLEWARE");
        }),
      },
    });
    try {
      const response = await app.fetch(new Request("http://example.test/"));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("PRIVATE_MIDDLEWARE");
    } finally {
      await app.dispose();
    }
  });

  test("dispatches endpoint methods alongside page routes", async () => {
    const endpointGeneration = generation();
    (
      endpointGeneration.manifest.routing.nodes[0] as Record<string, unknown>
    ).endpoint = "+server.ts";
    (
      endpointGeneration.manifest.routing.routes[0] as Record<string, unknown>
    ).endpoint = true;
    const endpointRegistry = {
      ...registry([]),
      manifest: endpointGeneration.manifest.routing,
      nodes: [
        {
          endpoint: async () => ({ GET: () => new Response("endpoint") }),
        },
      ],
    };
    const app = await createApplication({
      generation: endpointGeneration,
      registry: endpointRegistry as never,
    });
    const fetchedResponse4 = await app.fetch(
      new Request("http://example.test/", {
        headers: { accept: "application/json" },
      }),
    );
    expect(fetchedResponse4.status).toBe(200);
    const fetchedResponse5 = await app.fetch(
      new Request("http://example.test/", {
        headers: { accept: "application/json" },
      }),
    );
    expect(await fetchedResponse5.text()).toBe("endpoint");
    const fetchedResponse6 = await app.fetch(
      new Request("http://example.test/", {
        method: "POST",
        headers: { accept: "application/json" },
      }),
    );
    expect(fetchedResponse6.status).toBe(405);
  });

  test("does not forward cookies to external internal-fetch targets", async () => {
    let cookie: string | null = "unexpected";
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      hooks: {
        handleFetch: async ({ request }) => {
          cookie = request.headers.get("cookie");
          return new Response("external");
        },
        handle: async ({ event }) => {
          await event.fetch("https://external.test/resource");
          return new Response("ok");
        },
      },
    });
    await app.fetch(
      new Request("http://example.test/", { headers: { cookie: "secret=1" } }),
    );
    expect(cookie).toBeNull();
  });
});

test("E02: a throwing error hook still returns a sanitized response", async () => {
  const app = await createApplication({
    generation: generation(),
    registry: registry([]) as never,
    hooks: {
      handle: () => {
        throw Error("PRIVATE_HANDLE");
      },
      handleError: () => {
        throw Error("PRIVATE_HOOK");
      },
    },
  });
  try {
    const response = await app.fetch(
      new Request("http://example.test/", {
        headers: { accept: "application/json" },
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "Internal Error" });
  } finally {
    await app.dispose();
  }
});

test("E02: cross-origin form requests fail before application hooks run", async () => {
  let calls = 0;
  const app = await createApplication({
    generation: generation(),
    registry: registry([]) as never,
    hooks: {
      handle: () => {
        calls++;
        return new Response("ok");
      },
    },
  });
  try {
    const response = await app.fetch(
      new Request("http://example.test/", {
        method: "POST",
        body: "unsafe",
        headers: { origin: "https://other.test", "content-type": "text/plain" },
      }),
    );
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  } finally {
    await app.dispose();
  }
});

test("E02: handle receives matched route metadata before resolve", async () => {
  const seen: { id: string | null } = { id: null };
  const app = await createApplication({
    generation: generation(),
    registry: registry([]) as never,
    hooks: {
      handle: async ({ event, resolve }) => {
        seen.id = event.route.id;
        return resolve();
      },
    },
  });
  try {
    const response = await app.fetch(new Request("http://example.test/"));
    await response.text();
    expect(seen.id).toBe("/");
  } finally {
    await app.dispose();
  }
});
