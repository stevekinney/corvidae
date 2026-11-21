import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Research probes for Bun 1.4.4. Run with: bun test ./bun-primitives.test.ts
// These test native behavior, not a Velveteen implementation or full SSR graph.
const notFound = () => new Response("missing", { status: 404 });

test("R01: reload replaces handlers and route membership on the same listener", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/old": () => new Response("A"),
      "/version": () => new Response("A"),
    },
    fetch: notFound,
  });
  const address = server.url.href;
  const processId = process.pid;
  try {
    expect(await (await fetch(new URL("/version", address))).text()).toBe("A");
    server.reload({
      routes: {
        "/new": () => new Response("B"),
        "/version": () => new Response("B"),
      },
      fetch: () => new Response("new fallback", { status: 404 }),
    });
    expect(server.url.href).toBe(address);
    expect(process.pid).toBe(processId);
    expect(await (await fetch(new URL("/version", address))).text()).toBe("B");
    expect(await (await fetch(new URL("/new", address))).text()).toBe("B");
    const removed = await fetch(new URL("/old", address));
    expect(removed.status).toBe(404);
    expect(await removed.text()).toBe("new fallback");
  } finally {
    await server.stop(true);
  }
});

test("R02: an admitted request finishes on A while new requests use B", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      entered.resolve();
      await release.promise;
      return new Response("A");
    },
  });
  const first = fetch(server.url);
  try {
    await entered.promise;
    server.reload({ fetch: () => new Response("B") });
    expect(await (await fetch(server.url)).text()).toBe("B");
    release.resolve();
    expect(await (await first).text()).toBe("A");
    expect(await (await fetch(server.url)).text()).toBe("B");
  } finally {
    release.resolve();
    await first.catch(() => undefined);
    await server.stop(true);
  }
});

test("R03: reload alone does not refresh cached transitive module imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "velveteen-module-cache-"));
  const dependency = join(directory, "value.ts");
  const entry = join(directory, "entry.ts");
  await Bun.write(dependency, "export const value = 'A';");
  await Bun.write(
    entry,
    "import { value } from './value.ts'; export const respond = () => new Response(value);",
  );
  const entryUrl = pathToFileURL(entry).href;
  const first = await import(entryUrl);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: first.respond,
  });
  try {
    expect(await (await fetch(server.url)).text()).toBe("A");
    await Bun.write(dependency, "export const value = 'B';");
    server.reload({ fetch: (await import(entryUrl)).respond });
    expect(await (await fetch(server.url)).text()).toBe("A");
    server.reload({
      fetch: (await import(`${entryUrl}?generation=B`)).respond,
    });
    expect(await (await fetch(server.url)).text()).toBe("A");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("R04: complete bundled generations refresh dependencies and publish only after success", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "velveteen-bundle-generation-"),
  );
  const dependency = join(directory, "value.ts");
  const entry = join(directory, "entry.ts");
  await Bun.write(
    entry,
    "import { value } from './value.ts'; export const respond = () => new Response(value);",
  );
  await Bun.write(dependency, "export const value = 'A';");
  const build = (generation: string) =>
    Bun.build({
      entrypoints: [entry],
      outdir: join(directory, generation),
      target: "bun",
      throw: false,
    });
  const firstBuild = await build("generation-a");
  expect(firstBuild.success).toBe(true);
  expect(firstBuild.logs).toEqual([]);
  const first = await import(
    pathToFileURL(join(directory, "generation-a/entry.js")).href
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: first.respond,
  });
  try {
    await Bun.write(dependency, "export const value = 'B';");
    const secondBuild = await build("generation-b");
    expect(secondBuild.success).toBe(true);
    expect(secondBuild.logs).toEqual([]);
    const second = await import(
      pathToFileURL(join(directory, "generation-b/entry.js")).href
    );
    server.reload({ fetch: second.respond });
    expect(await (await fetch(server.url)).text()).toBe("B");
    expect(await first.respond().text()).toBe("A");
    await Bun.write(dependency, "export const value = ;");
    const failedBuild = await build("generation-failed");
    expect(failedBuild.success).toBe(false);
    expect(failedBuild.logs.some((log) => log.level === "error")).toBe(true);
    // Deliberately do not publish a failed build. reload() is not a build transaction.
    expect(await (await fetch(server.url)).text()).toBe("B");
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("R05: an open response stream survives handler replacement", async () => {
  const remainder = Promise.withResolvers<void>();
  const firstChunk = new TextEncoder().encode("A-start");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(firstChunk);
            await remainder.promise;
            controller.enqueue(new TextEncoder().encode("-A-end"));
            controller.close();
          },
        }),
      );
    },
  });
  try {
    const response = await fetch(server.url);
    const reader = response.body!.getReader();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toBe("A-start");
    server.reload({ fetch: () => new Response("B") });
    expect(await (await fetch(server.url)).text()).toBe("B");
    remainder.resolve();
    const final = await reader.read();
    expect(new TextDecoder().decode(final.value)).toBe("-A-end");
    expect((await reader.read()).done).toBe(true);
  } finally {
    remainder.resolve();
    await server.stop(true);
  }
});

test("R06: client abort reaches the incoming Request signal", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      entered.resolve();
      await aborted.promise;
      return new Response("released");
    },
  });
  const pending = fetch(server.url, { signal: cancellation.signal }).then(
    () => "unexpected response",
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  );
  try {
    await entered.promise;
    cancellation.abort();
    expect(await pending).toBe("AbortError");
    await aborted.promise;
  } finally {
    cancellation.abort();
    aborted.resolve();
    await server.stop(true);
  }
});

test("R07: graceful stop drains a request already in flight", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      entered.resolve();
      await release.promise;
      return new Response("completed");
    },
  });
  const pending = fetch(server.url);
  try {
    await entered.promise;
    const stopping = server.stop();
    release.resolve();
    expect(await (await pending).text()).toBe("completed");
    await stopping;
    expect(server.pendingRequests).toBe(0);
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
    await server.stop(true);
  }
});

test("R08: native routes compose parameters, forms, URLs, headers and cookies", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/users/:identifier": {
        async POST(request) {
          const form = await request.formData();
          request.cookies.set("probe", "enabled", {
            httpOnly: true,
            path: "/",
          });
          return Response.json({
            identifier: request.params.identifier,
            query: new URL(request.url).searchParams.get("query"),
            name: form.get("name"),
            incomingCookie: request.cookies.get("existing"),
          });
        },
      },
    },
    fetch: notFound,
  });
  try {
    const body = new FormData();
    body.set("name", "Ada");
    const response = await fetch(
      new URL("/users/123?query=hello%20world", server.url),
      {
        method: "POST",
        headers: new Headers({ cookie: "existing=value" }),
        body,
      },
    );
    expect(await response.json()).toEqual({
      identifier: "123",
      query: "hello world",
      name: "Ada",
      incomingCookie: "value",
    });
    expect(response.headers.get("set-cookie")).toContain("probe=enabled");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  } finally {
    await server.stop(true);
  }
});

test("R09: HTMLRewriter transforms a Response and escapes inserted text", async () => {
  const response = new HTMLRewriter()
    .on("#value", {
      element(element) {
        element.setInnerContent("x<y");
      },
    })
    .transform(new Response('<p id="value">old</p>'));
  expect(await response.text()).toBe('<p id="value">x&lt;y</p>');
  expect(Bun.escapeHTML("x<y")).toBe("x&lt;y");
});

test("R10: native CSRF tokens verify only for the bound session and secret", () => {
  const secret = crypto.randomUUID();
  const token = Bun.CSRF.generate(secret, { sessionId: "session-a" });
  expect(Bun.CSRF.verify(token, { secret, sessionId: "session-a" })).toBe(true);
  expect(Bun.CSRF.verify(token, { secret, sessionId: "session-b" })).toBe(
    false,
  );
  expect(
    Bun.CSRF.verify(token, {
      secret: crypto.randomUUID(),
      sessionId: "session-a",
    }),
  ).toBe(false);
});
