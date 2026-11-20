import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import type { ProductionGeneration } from "../../src/build/manifest-types.ts";
import type { Fetch } from "../../src/data/contract.ts";
import { createEvent } from "../../src/server/request.ts";
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
  } as ProductionGeneration,
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
    expect(await (await event.fetch("/start")).text()).toBe("external");
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
