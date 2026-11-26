import { describe, expect, test } from "bun:test";
import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, fetchAssetSource, sequence } from "./index.ts";
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

const textOf = async (promise: Promise<Response>) => {
  const response = await promise;
  return response.text();
};

describe("server application", () => {
  test("uses host assets and a supplied registry without a generation directory", async () => {
    const supplied = generation();
    supplied.directory = join(tmpdir(), "velveteen-missing-generation");
    supplied.manifest.assets = [
      {
        file: "browser/app.js",
        target: "browser",
        bytes: 0,
        sha256: "0".repeat(64),
        url: "/_assets/app.js",
        contentType: "text/javascript",
        immutable: true,
      },
    ];
    const requests: string[] = [];
    const app = await createApplication({
      generation: supplied,
      registry: registry([]) as never,
      assets: fetchAssetSource({
        fetch(request) {
          requests.push(request.url);
          return new Response("host asset");
        },
      }),
    });
    try {
      const page = await app.fetch(new Request("https://example.test/"));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('"root":"ready"');
      const asset = await app.fetch(
        new Request("https://example.test/_assets/app.js"),
      );
      expect(await asset.text()).toBe("host asset");
      expect(requests).toEqual(["https://example.test/_assets/app.js"]);
    } finally {
      await app.dispose();
    }
  });

  test("admits only declared cookie-free originless machine forms to their own mount", async () => {
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      mounts: {
        "/api": {
          rootPaths: () => ["/oauth/token"],
          machineFormPaths: () => ["/oauth/token", "/api/embedded"],
          start: () => () => new Response("issuer"),
        },
        "/other": () => () => new Response("other"),
      },
    });
    const form = (
      path: string,
      headers: Record<string, string> = {},
      method = "POST",
    ) => {
      const request = new Request(`https://example.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: "a=b",
      });
      return app.fetch(
        method === "PUT" ? new Request(request, { method: "PUT" }) : request,
      );
    };
    try {
      expect(
        await form("/oauth/token").then((response) => response.text()),
      ).toBe("issuer");
      expect(
        await form("/api/embedded").then((response) => response.text()),
      ).toBe("issuer");
      const deniedHeaders: Record<string, string>[] = [
        { origin: "null" },
        { origin: "https://foreign.test" },
        { cookie: "session=x" },
        { "content-type": "text/plain" },
        { "content-type": "multipart/form-data" },
      ];
      for (const headers of deniedHeaders)
        expect(
          await form("/oauth/token", headers).then(
            (response) => response.status,
          ),
        ).toBe(403);
      expect(
        await form("/oauth/token", {}, "PUT").then(
          (response) => response.status,
        ),
      ).toBe(403);
      expect(
        await form("/oauth/token/extra").then((response) => response.status),
      ).toBe(403);
      expect(await form("/other").then((response) => response.status)).toBe(
        403,
      );
      expect(
        await form("/oauth/token", { origin: "https://example.test" }).then(
          (response) => response.text(),
        ),
      ).toBe("issuer");
    } finally {
      await app.dispose();
    }
    const failure = await throwingRejectionOf(
      createApplication({
        generation: generation(),
        registry: registry([]) as never,
        mounts: {
          "/api": {
            rootPaths: () => [],
            machineFormPaths: () => ["/other/token"],
            start: () => () => new Response(),
          },
          "/other": () => () => new Response(),
        },
      }),
    );
    expect(failure).toThrow("not owned by mount");
  });
  test("machine declarations belong to their application and cannot be redirected by hooks", async () => {
    const options = {
      generation: generation(),
      registry: registry([]) as never,
      mounts: {
        "/api": {
          rootPaths: () => ["/oauth/token"],
          machineFormPaths: () => ["/oauth/token"],
          start: () => () => new Response("issuer"),
        },
      },
      hooks: {
        handle: ({
          event,
          resolve,
        }: {
          event: import("./types.ts").RequestEvent;
          resolve: (
            event: import("./types.ts").RequestEvent,
          ) => Promise<Response>;
        }) =>
          resolve({
            ...event,
            request: new Request("https://example.test/other", event.request),
          }),
      },
    };
    const form = () =>
      new Request("https://example.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=b",
      });
    const original = await createApplication(options);
    expect(
      await original.fetch(form()).then((response) => response.status),
    ).toBe(403);
    await original.dispose();
    const replacement = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      mounts: {
        "/api": {
          rootPaths: () => ["/oauth/token"],
          start: () => () => new Response("replacement"),
        },
      },
    });
    try {
      expect(
        await replacement.fetch(form()).then((response) => response.status),
      ).toBe(403);
      expect(
        await original.fetch(form()).then((response) => response.status),
      ).toBe(503);
    } finally {
      await replacement.dispose();
    }
  });
  test("captures grouped service factories before startup awaits", async () => {
    const release = Promise.withResolvers<void>();
    const second = {
      rootPaths: () => [],
      start: () => () => new Response("original"),
    };
    const pending = createApplication({
      generation: generation(),
      registry: registry([]) as never,
      mounts: {
        "/first": async () => {
          await release.promise;
          return () => new Response();
        },
        "/second": second,
      },
    });
    second.start = () => () => new Response("changed");
    release.resolve();
    const app = await pending;
    try {
      expect(
        await textOf(app.fetch(new Request("https://example.test/second"))),
      ).toBe("original");
    } finally {
      await app.dispose();
    }
  });
  test("shares one service between an application mount and exact root routes", async () => {
    let starts = 0;
    let closes = 0;
    const app = await createApplication({
      generation: generation("/app"),
      registry: registry([]) as never,
      mounts: {
        "/api": {
          rootPaths: (base) => [`/.well-known/resource${base}/api/mcp`],
          start: () => {
            starts++;
            return {
              fetch: (request) => new Response(new URL(request.url).pathname),
              close: () => {
                closes++;
              },
            };
          },
        },
      },
    });
    try {
      expect(
        await textOf(
          app.fetch(new Request("https://example.test/app/api/mcp")),
        ),
      ).toBe("/mcp");
      expect(
        await textOf(
          app.fetch(
            new Request(
              "https://example.test/.well-known/resource/app/api/mcp",
            ),
          ),
        ),
      ).toBe("/.well-known/resource/app/api/mcp");
      expect(
        await app
          .fetch(new Request("https://example.test/.well-known/other"))
          .then((result) => result.status),
      ).toBe(404);
      expect(starts).toBe(1);
    } finally {
      await app.dispose();
    }
    expect(closes).toBe(1);
  });
  test("matches canonical mount segments without decoding the request remainder", async () => {
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      mounts: {
        "/café space": () => (request) =>
          new Response(new URL(request.url).pathname),
        "/encoded%20name": () => (request) =>
          new Response(new URL(request.url).pathname),
      },
    });
    try {
      expect(
        await textOf(
          app.fetch(
            new Request("http://example.test/caf%c3%a9%20space/item%2Fid"),
          ),
        ),
      ).toBe("/item%2Fid");
      expect(
        await textOf(
          app.fetch(new Request("http://example.test/encoded name/%252F")),
        ),
      ).toBe("/%252F");
      const adjacent = await app.fetch(
        new Request("http://example.test/caf%C3%A9%20spaces/item"),
      );
      expect(adjacent.status).toBe(404);
      await adjacent.text();
      const encodedSeparator = await app.fetch(
        new Request("http://example.test/caf%C3%A9%20space%2Fhidden"),
      );
      expect(encodedSeparator.status).toBe(404);
      await encodedSeparator.text();
    } finally {
      await app.dispose();
    }
    let starts = 0;
    const factory = () => {
      starts++;
      return () => new Response();
    };
    for (const mounts of [
      { "/café": factory, "/caf%C3%A9": factory },
      { "/api": factory, "/%61pi": factory },
      { "/%5Fremote": factory },
      { "/api%2Fprivate": factory },
      { "/api%5cprivate": factory },
    ] as Array<Record<string, typeof factory>>) {
      expect(
        await throwingRejectionOf(
          createApplication({
            generation: generation(),
            registry: registry([]) as never,
            mounts,
          }),
        ),
      ).toThrow();
    }
    expect(starts).toBe(0);
    const unicodeRegistry = registry([]);
    unicodeRegistry.manifest = {
      ...unicodeRegistry.manifest,
      routes: [
        ...unicodeRegistry.manifest.routes,
        { ...unicodeRegistry.manifest.routes[0], id: "/café/item" },
      ],
    };
    expect(
      await throwingRejectionOf(
        createApplication({
          generation: generation(),
          registry: unicodeRegistry as never,
          mounts: { "/caf%C3%A9": factory },
        }),
      ),
    ).toThrow("conflicts with route");
    expect(starts).toBe(0);
  });
  test("leaves websocket upgrades to the listener", async () => {
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      mounts: { "/api": () => () => new Response("http") },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (
          request.headers.get("upgrade") === "websocket" &&
          server.upgrade(request)
        )
          return;
        return app.fetch(request);
      },
      websocket: {
        open(socket) {
          socket.send("upgraded");
        },
        message() {},
      },
    });
    try {
      const received = Promise.withResolvers<string>();
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api`);
      socket.addEventListener("message", (event) =>
        received.resolve(String(event.data)),
      );
      socket.addEventListener("error", () =>
        received.reject(new Error("websocket failed")),
      );
      expect(await received.promise).toBe("upgraded");
      socket.close();
    } finally {
      await server.stop(true);
      await app.dispose();
    }
  });
  test("host stream release policy applies to external and internal mounts", async () => {
    let authorized = true;
    const resume = Promise.withResolvers<void>();
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      hooks: {
        handle: async ({ event, resolve }) => {
          if (event.url.pathname === "/internal")
            return event.fetch("/api/stream");
          const response = await resolve();
          if (event.url.pathname !== "/api/stream") return response;
          const reader = response.body!.getReader();
          return new Response(
            new ReadableStream(
              {
                async pull(output) {
                  const chunk = await reader.read();
                  if (!authorized) {
                    await reader.cancel();
                    output.close();
                    return;
                  }
                  if (chunk.done) output.close();
                  else output.enqueue(chunk.value);
                },
                cancel: () => reader.cancel(),
              },
              { highWaterMark: 0 },
            ),
          );
        },
      },
      mounts: {
        "/api": () => () =>
          new Response(
            new ReadableStream(
              {
                start(output) {
                  output.enqueue(new TextEncoder().encode("first"));
                },
                async pull(output) {
                  await resume.promise;
                  output.enqueue(new TextEncoder().encode("private"));
                  output.close();
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      },
    });
    try {
      const readers = await Promise.all(
        ["/api/stream", "/internal"].map(async (path) => {
          const response = await app.fetch(
            new Request(`http://example.test${path}`),
          );
          return response.body!.getReader();
        }),
      );
      for (const reader of readers) {
        const chunk = await reader.read();
        expect(new TextDecoder().decode(chunk.value)).toBe("first");
      }
      authorized = false;
      resume.resolve();
      for (const reader of readers) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(true);
      }
    } finally {
      resume.resolve();
      await app.dispose();
    }
  });
  test("applies admission to external and internal mounted requests and forwards cancellation", async () => {
    const observed: string[] = [];
    let mountedSignal: AbortSignal | undefined;
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      hooks: {
        handle: async ({ event, resolve }) => {
          if (event.url.pathname === "/internal")
            return event.fetch("/api/item?value=1", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "body",
            });
          if (event.request.headers.get("authorization") !== "allow")
            return new Response("denied", { status: 403 });
          return resolve();
        },
      },
      mounts: {
        "/api": () => async (request) => {
          mountedSignal = request.signal;
          observed.push(
            `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} ${await request.text()}`,
          );
          return new Response("result", {
            status: 404,
            headers: { "x-service": "yes" },
          });
        },
      },
    });
    try {
      const external = await app.fetch(
        new Request("http://example.test/api/item?value=1", {
          method: "POST",
          headers: {
            authorization: "allow",
            "content-type": "application/json",
          },
          body: "body",
        }),
      );
      const internal = await app.fetch(
        new Request("http://example.test/internal", {
          headers: { authorization: "allow" },
        }),
      );
      expect([
        external.status,
        internal.status,
        external.headers.get("x-service"),
        await external.text(),
        await internal.text(),
      ]).toEqual([404, 404, "yes", "result", "result"]);
      expect(observed).toEqual([
        "POST /item?value=1 body",
        "POST /item?value=1 body",
      ]);
      const denied = await app.fetch(
        new Request("http://example.test/internal"),
      );
      expect(denied.status).toBe(403);
      const deniedExternal = await app.fetch(
        new Request("http://example.test/api/item?value=1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "body",
        }),
      );
      expect(deniedExternal.status).toBe(403);
      expect(observed).toHaveLength(2);
      const abort = new AbortController();
      const response = await app.fetch(
        new Request("http://example.test/api/abort", {
          headers: { authorization: "allow" },
          signal: abort.signal,
        }),
      );
      abort.abort();
      expect(mountedSignal?.aborted).toBe(true);
      await response.body?.cancel();
    } finally {
      await app.dispose();
    }
  });
  test("mount startup failure closes previously started services", async () => {
    let closes = 0;
    expect(
      await throwingRejectionOf(
        createApplication({
          generation: generation(),
          registry: registry([]) as never,
          mounts: {
            "/first": () => ({
              fetch: () => new Response(),
              close: () => {
                closes++;
              },
            }),
            "/second": () => {
              throw new Error("startup");
            },
          },
        }),
      ),
    ).toThrow("startup");
    expect(closes).toBe(1);
  });

  test("rejects overlapping and protected mounts before startup", async () => {
    let starts = 0;
    const factory = () => {
      starts++;
      return () => new Response();
    };
    const cases: Array<Record<string, typeof factory>> = [
      { "/api": factory, "/api/nested": factory },
      { "/_remote": factory },
      { "/_assets": factory },
    ];
    for (const mounts of cases) {
      expect(
        await throwingRejectionOf(
          createApplication({
            generation: generation(),
            registry: registry([]) as never,
            mounts,
          }),
        ),
      ).toThrow();
    }
    expect(starts).toBe(0);
  });

  test("rejects page, endpoint, and asset collisions before startup", async () => {
    let starts = 0;
    const mounts = {
      "/api": () => {
        starts++;
        return () => new Response();
      },
    };
    for (const route of [
      { id: "/api/item" },
      { id: "/api/endpoint", endpoint: true as const },
      { id: "/[...path]" },
    ]) {
      const conflictingRegistry = registry([]);
      conflictingRegistry.manifest = {
        ...conflictingRegistry.manifest,
        routes: [
          ...conflictingRegistry.manifest.routes,
          { ...conflictingRegistry.manifest.routes[0], ...route },
        ],
      };
      expect(
        await throwingRejectionOf(
          createApplication({
            generation: generation(),
            registry: conflictingRegistry as never,
            mounts,
          }),
        ),
      ).toThrow("conflicts with route");
    }
    const directory = await mkdtemp(join(tmpdir(), "velveteen-mount-"));
    try {
      await mkdir(join(directory, "static/api"), { recursive: true });
      const bytes = new TextEncoder().encode("asset");
      await Bun.write(join(directory, "static/api/logo.svg"), bytes);
      const assetGeneration = generation();
      assetGeneration.directory = directory;
      assetGeneration.manifest.assets = [
        {
          file: "static/api/logo.svg",
          target: "static",
          url: "/api/logo.svg",
          bytes: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          contentType: "image/svg+xml",
          immutable: false,
        },
      ];
      expect(
        await throwingRejectionOf(
          createApplication({
            generation: assetGeneration,
            registry: registry([]) as never,
            mounts,
          }),
        ),
      ).toThrow("conflicts with asset");
      await mkdir(join(directory, "static/café"), { recursive: true });
      await Bun.write(join(directory, "static/café/logo.svg"), bytes);
      assetGeneration.manifest.assets = [
        {
          ...assetGeneration.manifest.assets[0],
          file: "static/café/logo.svg",
          url: "/caf%C3%A9/logo.svg",
        },
      ];
      expect(
        await throwingRejectionOf(
          createApplication({
            generation: assetGeneration,
            registry: registry([]) as never,
            mounts: { "/caf%c3%a9": mounts["/api"] },
          }),
        ),
      ).toThrow("conflicts with asset");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(starts).toBe(0);
  });

  test("retains a service through generation replacement and closes once", async () => {
    let starts = 0,
      closes = 0;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      mounts: {
        "/api": () => {
          starts++;
          return {
            fetch: async (request) => {
              if (new URL(request.url).pathname === "/held") {
                entered.resolve();
                await resume.promise;
              }
              return new Response(String(starts));
            },
            close: () => {
              closes++;
            },
          };
        },
      },
    });
    const invalid = generation();
    const badRegistry = registry([]);
    badRegistry.manifest = {
      ...badRegistry.manifest,
      routes: [
        ...badRegistry.manifest.routes,
        { ...badRegistry.manifest.routes[0], id: "/api/item" },
      ],
    };
    expect(
      await throwingRejectionOf(
        app.replaceGeneration(invalid, badRegistry as never),
      ),
    ).toThrow("conflicts with route");
    expect(
      await textOf(app.fetch(new Request("http://example.test/api"))),
    ).toBe("1");
    const held = app.fetch(new Request("http://example.test/api/held"));
    await entered.promise;
    const next = await app.replaceGeneration(
      generation(),
      registry([]) as never,
    );
    resume.resolve();
    expect(await textOf(held)).toBe("1");
    await app.retire();
    await app.dispose();
    expect(
      await textOf(next.fetch(new Request("http://example.test/api"))),
    ).toBe("1");
    await next.dispose();
    await next.dispose();
    expect([starts, closes]).toEqual([1, 1]);
  });
  test("retired requests cannot invoke mounts after owner shutdown", async () => {
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let calls = 0;
    const app = await createApplication({
      generation: generation(),
      registry: registry([]) as never,
      hooks: {
        handle: async ({ event, resolve }) => {
          if (event.url.pathname === "/held") {
            ready.resolve();
            await resume.promise;
            return event.fetch("/api");
          }
          return resolve();
        },
      },
      mounts: {
        "/api": () => () => {
          calls++;
          return new Response("mounted");
        },
      },
    });
    const held = app.fetch(new Request("http://example.test/held"));
    await ready.promise;
    const next = await app.replaceGeneration(
      generation(),
      registry([]) as never,
    );
    const retiring = app.retire();
    await next.dispose();
    resume.resolve();
    const response = await held;
    expect(response.status).toBe(503);
    await response.text();
    await retiring;
    expect(calls).toBe(0);
  });
  test("starts mounted services once and dispatches relative requests", async () => {
    let starts = 0;
    let asyncStarts = 0;
    const app = await createApplication({
      generation: generation("/app"),
      registry: registry([]) as never,
      mounts: {
        "/api": () => {
          starts++;
          return (request: Request) =>
            new Response(new URL(request.url).pathname);
        },
        "/async": async () => {
          asyncStarts++;
          return { fetch: () => new Response(String(asyncStarts)) };
        },
      },
    });
    try {
      expect(
        await textOf(
          app.fetch(new Request("http://example.test/app/api/a%2Fb")),
        ),
      ).toBe("/a%2Fb");
      expect(
        await textOf(
          app.fetch(new Request("http://example.test/app/api/second")),
        ),
      ).toBe("/second");
      expect(starts).toBe(1);
      const adjacent = await app.fetch(
        new Request("http://example.test/app/apix"),
      );
      expect(adjacent.status).toBe(404);
      await adjacent.text();
      expect(
        await textOf(app.fetch(new Request("http://example.test/app/async"))),
      ).toBe("1");
      expect(
        await textOf(app.fetch(new Request("http://example.test/app/async"))),
      ).toBe("1");
      expect(asyncStarts).toBe(1);
    } finally {
      await app.dispose();
    }
  });
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
