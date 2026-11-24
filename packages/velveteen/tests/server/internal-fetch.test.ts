import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import type { Fetch } from "../../src/data/contract.ts";
import { createEvent } from "../../src/server/request.ts";
import { createApplication } from "../../src/server/index.ts";
import type { ApplicationOptions } from "../../src/server/types.ts";

const options: ApplicationOptions = {
  generation: {
    directory: "/tmp/velveteen-internal-fetch",
    manifest: {
      version: 1,
      basePath: "",
      routing: { version: 1, nodes: [], routes: [] },
      client: {
        file: "client.js",
        url: "/client.js",
        stylesheets: [],
        nodes: {},
      },
      server: { file: "server.js", nodes: {} },
      routes: {},
      assets: [],
      outputs: [],
    },
  },
};

function eventFor(
  dispatch: (request: Request) => Response | Promise<Response>,
  request = new Request("http://app.test/start", {
    headers: { cookie: "ambient=1", authorization: "ambient-token" },
  }),
) {
  const fetchDispatch: Fetch = async (input, init) =>
    dispatch(input instanceof Request ? input : new Request(input, init));
  return createEvent(
    request,
    new URL(request.url),
    new AbortController().signal,
    fetchDispatch,
    options,
  ).event;
}

test("follows relative internal redirects and applies native method rules", async () => {
  const seen: Array<{ path: string; method: string; body: string }> = [];
  const event = eventFor(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, method: request.method, body: await request.text() });
    if (path === "/start")
      return new Response(null, {
        status: 302,
        headers: { location: "/target" },
      });
    return new Response("ok");
  });

  const response = await event.fetch("/start", {
    method: "POST",
    body: "payload",
  });
  expect(await response.text()).toBe("ok");
  expect(seen).toEqual([
    { path: "/start", method: "POST", body: "payload" },
    { path: "/target", method: "GET", body: "" },
  ]);
});

test("303 changes POST to GET while 307 preserves method and bytes", async () => {
  const seen: Array<{ path: string; method: string; body: string }> = [];
  const event = eventFor(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, method: request.method, body: await request.text() });
    if (path === "/see-other")
      return new Response(null, { status: 303, headers: { location: "/get" } });
    if (path === "/temporary")
      return new Response(null, { status: 307, headers: { location: "/put" } });
    return new Response("ok");
  });

  await event.fetch("/see-other", { method: "POST", body: "first" });
  await event.fetch("/temporary", { method: "PUT", body: "second" });
  expect(seen).toEqual([
    { path: "/see-other", method: "POST", body: "first" },
    { path: "/get", method: "GET", body: "" },
    { path: "/temporary", method: "PUT", body: "second" },
    { path: "/put", method: "PUT", body: "second" },
  ]);
});

test("supports manual and error redirect policies and rejects redirect loops", async () => {
  const dispatch = async () =>
    new Response(null, { status: 302, headers: { location: "/next" } });
  const manual = eventFor(dispatch);
  const manualResponse = await manual.fetch("/start", { redirect: "manual" });
  expect(manualResponse.status).toBe(302);
  expect(
    await throwingRejectionOf(
      eventFor(dispatch).fetch("/start", { redirect: "error" }),
    ),
  ).toThrow("Redirect encountered");

  const loop = eventFor(
    async (request) =>
      new Response(null, {
        status: 302,
        headers: { location: new URL(request.url).pathname },
      }),
  );
  expect(await throwingRejectionOf(loop.fetch("/loop"))).toThrow(
    "Maximum redirect count exceeded",
  );
});

test("strips ambient credentials on cross-origin redirects", async () => {
  const observed: { cookie: string | null; authorization: string | null } = {
    cookie: null,
    authorization: null,
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      observed.cookie = request.headers.get("cookie");
      observed.authorization = request.headers.get("authorization");
      return new Response("external");
    },
  });
  try {
    const event = eventFor(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${server.port}/external` },
        }),
    );
    const response = await event.fetch("/start");
    expect(await response.text()).toBe("external");
    expect(observed).toEqual({ cookie: null, authorization: null });
  } finally {
    server.stop(true);
  }
});

test("scopes cookies learned from internal responses by path", async () => {
  const seen: Array<{ path: string; cookie: string | null }> = [];
  const event = eventFor(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, cookie: request.headers.get("cookie") });
    if (path === "/set")
      return new Response("set", {
        headers: { "set-cookie": "private=1; Path=/private" },
      });
    return new Response("ok");
  }, new Request("http://app.test/set"));
  await event.fetch("/set");
  await event.fetch("/public");
  await event.fetch("/private/child");
  expect(seen).toEqual([
    { path: "/set", cookie: null },
    { path: "/public", cookie: null },
    { path: "/private/child", cookie: "private=1" },
  ]);
});

test("preserves same-name cookies across path and domain scopes", async () => {
  const seen: Array<{ path: string; cookie: string | null }> = [];
  const event = eventFor(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, cookie: request.headers.get("cookie") });
    if (path === "/set") {
      const headers = new Headers();
      headers.append("set-cookie", "session=private; Path=/private");
      headers.append("set-cookie", "session=domain; Domain=app.test; Path=/");
      return new Response("set", { headers });
    }
    if (path === "/replace")
      return new Response("replace", {
        headers: { "set-cookie": "session=private-new; Path=/private" },
      });
    return new Response("ok");
  });
  await event.fetch("/set");
  await event.fetch("/private/child");
  await event.fetch("/public");
  await event.fetch("/replace");
  await event.fetch("/private/child");
  expect(seen).toEqual([
    { path: "/set", cookie: "ambient=1" },
    {
      path: "/private/child",
      cookie: "session=private; session=domain; ambient=1",
    },
    { path: "/public", cookie: "session=domain; ambient=1" },
    { path: "/replace", cookie: "session=domain; ambient=1" },
    {
      path: "/private/child",
      cookie: "session=private-new; session=domain; ambient=1",
    },
  ]);
});

test("composes distinct cookie scopes and replaces only an exact scope", () => {
  const context = createEvent(
    new Request("http://app.test/"),
    new URL("http://app.test/"),
    new AbortController().signal,
    async () => new Response("ok"),
    options,
  );
  context.event.cookies.set("session", "private", { path: "/private" });
  context.event.cookies.set("session", "root", {
    domain: "app.test",
    path: "/",
  });
  context.event.cookies.set("session", "private-new", { path: "/private" });
  const response = context.apply(new Response("ok"));
  expect(response.headers.getSetCookie()).toEqual([
    "session=private-new; Path=/private; HttpOnly; SameSite=Lax",
    "session=root; Domain=app.test; Path=/; HttpOnly; SameSite=Lax",
  ]);
  context.event.cookies.delete("session", { path: "/private" });
  context.event.cookies.delete("session", { domain: "app.test", path: "/" });
  expect(context.apply(new Response("ok")).headers.getSetCookie()).toEqual([
    "session=; Path=/private; Max-Age=0; HttpOnly; SameSite=Lax",
    "session=; Domain=app.test; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
  ]);
});

test("does not forward secure or mismatched-domain cookies and honors deletion", async () => {
  const seen: Array<{ path: string; cookie: string | null }> = [];
  const event = eventFor(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, cookie: request.headers.get("cookie") });
    if (path === "/set")
      return (() => {
        const headers = new Headers();
        headers.append("set-cookie", "secure=secret; Secure; Path=/");
        headers.append("set-cookie", "wrong=secret; Domain=other.test; Path=/");
        headers.append("set-cookie", "remove=gone; Path=/");
        return new Response("set", { headers });
      })();
    if (path === "/delete")
      return new Response("delete", {
        headers: { "set-cookie": "remove=; Max-Age=0; Path=/" },
      });
    return new Response("ok");
  });
  await event.fetch("/set");
  await event.fetch("/next");
  await event.fetch("/delete");
  await event.fetch("/after-delete");
  expect(seen).toEqual([
    { path: "/set", cookie: "ambient=1" },
    { path: "/next", cookie: "remove=gone; ambient=1" },
    { path: "/delete", cookie: "remove=gone; ambient=1" },
    { path: "/after-delete", cookie: "ambient=1" },
  ]);
});

test("redirect hops preserve omit and recompute ambient cookies for the target path", async () => {
  const seen: (string | null)[] = [];
  const event = eventFor((request) => {
    seen.push(request.headers.get("cookie"));
    return new URL(request.url).pathname === "/start"
      ? new Response(null, { status: 302, headers: { location: "/target" } })
      : new Response("ok");
  });
  await event.fetch("/start", { credentials: "omit" });
  expect(seen).toEqual([null, null]);
  seen.length = 0;
  event.cookies.set("scoped", "secret", { path: "/start" });
  await event.fetch("/start");
  expect(seen[0]).toContain("scoped=secret");
  expect(seen[1]).not.toContain("scoped=secret");
});

test("cross-origin redirect drops explicit sensitive headers too", async () => {
  let leaked = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      leaked = [
        request.headers.get("cookie"),
        request.headers.get("authorization"),
      ]
        .filter(Boolean)
        .join(";");
      return new Response("ok");
    },
  });
  try {
    const event = eventFor(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: server.url.href },
        }),
    );
    await event.fetch("/start", {
      headers: { cookie: "explicit=secret", authorization: "explicit-secret" },
    });
    expect(leaked).toBe("");
  } finally {
    await server.stop(true);
  }
});

test("redirect targets inherit caller cancellation and received cookies before dispatch", async () => {
  const controller = new AbortController();
  let target: Request | undefined;
  const event = eventFor((request) => {
    if (new URL(request.url).pathname === "/start")
      return new Response(null, {
        status: 302,
        headers: { location: "/target", "set-cookie": "fresh=yes; Path=/" },
      });
    target = request;
    return new Response("ok");
  });
  await event.fetch("/start", { signal: controller.signal });
  expect(target?.headers.get("cookie")).toContain("fresh=yes");
  controller.abort();
  expect(target?.signal.aborted).toBe(true);
});

test("aborting between redirect hops prevents target dispatch", async () => {
  const controller = new AbortController(),
    gate = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  const seen: string[] = [];
  const event = eventFor(async (request) => {
    seen.push(new URL(request.url).pathname);
    if (seen.length === 1) {
      started.resolve();
      await gate.promise;
      return new Response(null, {
        status: 302,
        headers: { location: "/target" },
      });
    }
    return new Response("wrong");
  });
  const work = event.fetch("/start", { signal: controller.signal });
  await started.promise;
  controller.abort(new DOMException("Caller canceled", "AbortError"));
  gate.resolve();
  expect(await throwingRejectionOf(work)).toThrow("Caller canceled");
  expect(seen).toEqual(["/start"]);
});

test("rejected redirects cancel their response bodies while manual redirects remain caller-owned", async () => {
  let canceled = 0;
  const event = eventFor(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("redirect"));
          },
          cancel() {
            canceled++;
          },
        }),
        { status: 302, headers: { location: "/target" } },
      ),
  );
  expect(
    await throwingRejectionOf(event.fetch("/start", { redirect: "error" })),
  ).toThrow("Redirect encountered");
  expect(canceled).toBe(1);
  const manual = await event.fetch("/start", { redirect: "manual" });
  expect(canceled).toBe(1);
  await manual.body!.cancel();
  expect(canceled).toBe(2);
});

test("network and event.fetch mounts preserve identity, release policy, and stream cancellation", async () => {
  const seen: Array<{ path: string; id: string; credential: string | null }> =
    [];
  let authorized = true;
  let admitted = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  let cancelled = Promise.withResolvers<void>();
  const app = await createApplication({
    generation: {
      ...options.generation,
      manifest: { ...options.generation.manifest, basePath: "/base" },
    },
    registry: {
      manifest: options.generation.manifest.routing,
      nodes: [],
      Root: {} as never,
      render: () => ({ body: "", head: "" }),
    },
    hooks: {
      handle: async ({ event, resolve }) => {
        if (event.url.pathname === "/base/page")
          return event.fetch(
            `/base/catalog/items/a%20b?mode=${event.url.searchParams.get("mode")}`,
          );
        return resolve();
      },
    },
    mounts: {
      "/catalog": () => (request) => {
        const url = new URL(request.url);
        seen.push({
          path: url.pathname,
          id: decodeURIComponent(url.pathname.split("/").at(-1)!),
          credential: request.headers.get("authorization"),
        });
        request.signal.addEventListener("abort", () => cancelled.resolve(), {
          once: true,
        });
        if (url.searchParams.get("mode") === "stream")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("started"));
              },
            }),
          );
        admitted.resolve();
        return new Response(
          new ReadableStream(
            {
              start(controller) {
                controller.enqueue(new TextEncoder().encode("admitted"));
              },
              async pull(controller) {
                await release.promise;
                if (authorized)
                  controller.enqueue(new TextEncoder().encode("private value"));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      },
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.fetch(request),
  });
  try {
    for (const path of ["/base/catalog/items/a%20b", "/base/page"]) {
      authorized = true;
      admitted = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();
      const response = await fetch(
        new URL(`${path}?mode=private`, server.url),
        { headers: { authorization: "Bearer actor" } },
      );
      await admitted.promise;
      const privateReader = response.body!.getReader();
      expect(new TextDecoder().decode((await privateReader.read()).value)).toBe(
        "admitted",
      );
      authorized = false;
      release.resolve();
      expect((await privateReader.read()).done).toBe(true);
      cancelled = Promise.withResolvers<void>();
      const controller = new AbortController();
      const stream = await fetch(new URL(`${path}?mode=stream`, server.url), {
        headers: { authorization: "Bearer actor" },
        signal: controller.signal,
      });
      const reader = stream.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "started",
      );
      controller.abort();
      await cancelled.promise;
      await reader.cancel().catch(() => undefined);
    }
    expect(seen).toEqual(
      Array.from({ length: 4 }, () => ({
        path: "/items/a%20b",
        id: "a b",
        credential: "Bearer actor",
      })),
    );
  } finally {
    release.resolve();
    await server.stop(true);
    await app.dispose();
  }
});
