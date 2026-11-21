import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { error, redirect } from "../../src/data/errors.ts";
import type { RequestEvent } from "../../src/server/types.ts";
import { createRemoteClient } from "../../src/remote/client.ts";
import {
  defineBatchQuery,
  defineRemote,
  dispatchRemote,
  type RemoteDefinitions,
} from "../../src/remote/server.ts";
import {
  decodeRemote,
  encodeRemote,
  remoteBatchLimit,
  remoteBatchPath,
  remoteContentType,
} from "../../src/remote/protocol.ts";

function eventFor(url = "http://app.test/page"): RequestEvent {
  const request = new Request(url);
  return {
    request,
    url: new URL(url),
    params: {},
    route: { id: "/" },
    locals: {},
    cookies: { get: () => undefined, getAll: () => [], set() {}, delete() {} },
    platform: undefined,
    fetch: globalThis.fetch,
    setHeaders() {},
    getClientAddress: () => "127.0.0.1",
    signal: new AbortController().signal,
  };
}
const definitions = {
  rich: defineRemote({
    kind: "query",
    validate: (value: unknown) => value,
    handle: (value: unknown) => value,
  }),
  command: defineRemote({
    kind: "command",
    validate: (value: unknown) => value,
    handle: (value: unknown) => value,
  }),
  invalid: defineRemote({
    kind: "query",
    validate: (value: unknown) => value,
    handle: () => ({ fn: () => "private" }),
  }),
  redirecting: defineRemote({
    kind: "command",
    validate: (value: unknown) => value,
    handle: () => redirect(303, "https://app.test/destination"),
  }),
};
async function browserFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  registry: RemoteDefinitions = definitions,
) {
  const request = new Request(input, init);
  const event = eventFor(request.url);
  const headers = new Headers(request.headers);
  headers.set("origin", event.url.origin);
  const submitted = new Request(request, { headers });
  return dispatchRemote(registry, submitted, {
    ...event,
    request: submitted,
    signal: submitted.signal,
  });
}

test("round-trips rich devalue values through separated client/server", async () => {
  const cycle: {
    date: Date;
    map: Map<string, bigint>;
    set: Set<number>;
    self?: unknown;
    missing?: unknown;
    array: number[];
  } = {
    date: new Date("2020-01-01"),
    map: new Map([["n", 2n]]),
    set: new Set([1, 2]),
    array: [1, 2],
  };
  cycle.self = cycle;
  cycle.missing = undefined;
  const client = createRemoteClient<typeof definitions>({
    baseURL: "http://app.test/",
    invalidate: async () => {},
    fetch: browserFetch,
  });
  const result = (await client.call("rich", cycle)) as typeof cycle;
  expect(result).toMatchObject({ date: cycle.date, array: [1, 2] });
  expect(result.map).toEqual(new Map([["n", 2n]]));
  expect(result.set).toEqual(new Set([1, 2]));
  expect(result.self).toBe(result);
});

test("rejects missing, foreign, malformed, invalid-name and wrong-content requests", async () => {
  const event = eventFor("http://app.test/_remote/rich");
  const request = (url: string, init: RequestInit = {}) =>
    new Request(url, {
      method: "POST",
      headers: { origin: event.url.origin, "content-type": remoteContentType },
      ...init,
    });
  expect(
    (
      await dispatchRemote(
        definitions,
        request("http://app.test/_remote/rich"),
        event,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await dispatchRemote(
        definitions,
        request("http://other.test/_remote/rich", {
          headers: {
            origin: "http://other.test",
            "content-type": remoteContentType,
          },
        }),
        event,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await dispatchRemote(
        definitions,
        new Request("http://app.test/_remote/rich", {
          method: "POST",
          headers: { origin: event.url.origin },
        }),
        event,
      )
    ).status,
  ).toBe(415);
  const prototypeEvent = eventFor("http://app.test/_remote/__proto__");
  expect(
    (
      await dispatchRemote(
        definitions,
        request("http://app.test/_remote/__proto__", {
          body: encodeRemote({ version: 1, name: "__proto__", input: null }),
        }),
        prototypeEvent,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await dispatchRemote(
        definitions,
        request("http://app.test/_remote/rich", { body: "not-devalue" }),
        event,
      )
    ).status,
  ).toBe(400);
});

test("validates before user code and sanitizes unsupported returned values", async () => {
  let called = false;
  const guarded = {
    bad: defineRemote({
      kind: "query" as const,
      validate: () => {
        throw new Error("bad input");
      },
      handle: () => {
        called = true;
        return 1;
      },
    }),
  };
  const event = eventFor("http://app.test/_remote/bad");
  const request = new Request("http://app.test/_remote/bad", {
    method: "POST",
    headers: { origin: event.url.origin, "content-type": remoteContentType },
    body: encodeRemote({ version: 1, name: "bad", input: 1 }),
  });
  expect((await dispatchRemote(guarded, request, event)).status).toBe(400);
  expect(called).toBe(false);
  const invalidEvent = eventFor("http://app.test/_remote/invalid");
  const output = new Request("http://app.test/_remote/invalid", {
    method: "POST",
    headers: {
      origin: invalidEvent.url.origin,
      "content-type": remoteContentType,
    },
    body: encodeRemote({ version: 1, name: "invalid", input: null }),
  });
  expect((await dispatchRemote(definitions, output, invalidEvent)).status).toBe(
    500,
  );
});

test("rejects unsupported input before fetch and invalidates successful commands", async () => {
  let calls = 0;
  let fetches = 0;
  const client = createRemoteClient<typeof definitions>({
    baseURL: "http://app.test/",
    invalidate: () => {
      calls++;
    },
    fetch: async (input) => {
      fetches++;
      return browserFetch(input);
    },
  });
  for (const value of [
    () => 1,
    Symbol("x"),
    Promise.resolve(1),
    new (class Secret {})(),
    new File(["x"], "x"),
  ])
    expect(
      await throwingRejectionOf(client.call("command", value as never)),
    ).toThrow();
  expect(fetches).toBe(0);
  expect(calls).toBe(0);
  expect(await client.call("command", { ok: true })).toEqual({ ok: true });
  expect(calls).toBe(1);
});

test("handles redirects and per-call cancellation", async () => {
  let redirected = "";
  const client = createRemoteClient<typeof definitions>({
    baseURL: "http://app.test/",
    invalidate: () => {},
    redirect: (location) => {
      redirected = location;
    },
    fetch: browserFetch,
  });
  await client.call("redirecting", null);
  expect(redirected).toBe("https://app.test/destination");
  const controller = new AbortController();
  controller.abort();
  const canceled = createRemoteClient<typeof definitions>({
    baseURL: "http://app.test/",
    invalidate: () => {
      throw new Error("must not invalidate");
    },
    fetch: browserFetch,
  });
  expect(
    await throwingRejectionOf(
      canceled.call("command", null, { signal: controller.signal }),
    ),
  ).toThrow();
  let invalidateCount = 0;
  const heldController = new AbortController();
  const reading = Promise.withResolvers<void>();
  let canceledBody = false;
  const held = createRemoteClient<typeof definitions>({
    baseURL: "http://app.test/",
    invalidate: () => {
      invalidateCount++;
    },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            reading.resolve();
          },
          cancel() {
            canceledBody = true;
          },
        }),
        { headers: { "content-type": remoteContentType } },
      ),
  });
  const pending = held.call("command", null, { signal: heldController.signal });
  await reading.promise;
  heldController.abort();
  expect(await throwingRejectionOf(pending)).toThrow();
  expect(canceledBody).toBe(true);
  expect(invalidateCount).toBe(0);
});

test("V: same-turn reads coalesce, deduplicate and retain successful undefined", async () => {
  const batches: string[][] = [];
  let exchanges = 0;
  const registry = {
    row: defineBatchQuery({
      validate: (value) => {
        if (typeof value !== "string" || value === "invalid")
          throw new Error("PRIVATE_VALIDATION");
        return value;
      },
      handle: (inputs) => {
        batches.push(inputs);
        return (input) => {
          if (input === "missing") error(404, "Not found");
          if (input === "private") throw new Error("PRIVATE_QUERY_ERROR");
          if (input === "unserializable") return () => "PRIVATE_SERIALIZATION";
          return input === "undefined" ? undefined : input.toUpperCase();
        };
      },
    }),
  };
  const client = createRemoteClient<typeof registry>({
    baseURL: "http://app.test/",
    invalidate() {},
    fetch(input, init) {
      exchanges++;
      return browserFetch(input, init, registry);
    },
  });
  const one = client.query("row", "one");
  const missingValue = client.query("row", "undefined");
  const received = await Promise.allSettled([
    one.get(),
    client.query("row", "one").refresh(),
    Promise.resolve().then(() => missingValue.get()),
    client.query("row", "missing").get(),
    client.query("row", "private").get(),
    client.query("row", "invalid").get(),
    client.query("row", "unserializable").get(),
  ]);
  expect(exchanges).toBe(1);
  expect(batches).toEqual([
    ["one", "missing", "private", "unserializable", "undefined"],
  ]);
  expect(received.slice(0, 3)).toEqual([
    { status: "fulfilled", value: "ONE" },
    { status: "fulfilled", value: "ONE" },
    { status: "fulfilled", value: undefined },
  ]);
  expect(
    received
      .slice(3)
      .map((result) => result.status === "rejected" && result.reason.message),
  ).toEqual(["Not found", "Internal Error", "Bad Request", "Internal Error"]);
  expect(await missingValue.get()).toBeUndefined();
  expect(await one.get()).toBe("ONE");
  expect(exchanges).toBe(1);

  const bulk = Array.from({ length: remoteBatchLimit + 1 }, (_, index) =>
    client.query("row", String(index)).get(),
  );
  expect(await Promise.all(bulk)).toHaveLength(remoteBatchLimit + 1);
  expect(
    batches
      .slice(1)
      .map((batch) => batch.length)
      .sort((a, b) => a - b),
  ).toEqual([1, remoteBatchLimit]);
  expect(exchanges).toBe(3);
});

test("V: one command exchange publishes refresh and fences an older query response", async () => {
  const oldArrived = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  const oldBodySent = Promise.withResolvers<void>();
  const updates: string[] = [];
  const paths: string[] = [];
  let row = "old";
  let hold = true;
  const registry = {
    row: defineBatchQuery({
      validate: (value) => String(value),
      async handle(inputs) {
        const values = inputs.map((key) => [key, row] as const);
        if (hold) {
          hold = false;
          oldArrived.resolve();
          await releaseOld.promise;
        }
        const results = new Map(values);
        return (key) => results.get(key)!;
      },
    }),
    command: defineRemote({
      kind: "command",
      validate: (value) => String(value),
      handle(value) {
        row = value;
        return row;
      },
      refresh: () => [
        { name: "row", input: "same" },
        { name: "unknown", input: 0 },
      ],
    }),
  };
  const client = createRemoteClient<typeof registry>({
    baseURL: "http://app.test/",
    invalidate() {},
    async fetch(input, init) {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      paths.push(path);
      const oldest = paths.length === 1;
      const response = await browserFetch(input, init, registry);
      if (!oldest) return response;
      return new Response(
        response.body!.pipeThrough(
          new TransformStream({
            flush() {
              oldBodySent.resolve();
            },
          }),
        ),
        { headers: response.headers, status: response.status },
      );
    },
  });
  const current = client.query("row", "same");
  const stop = current.subscribe((value) => {
    updates.push(value);
  });
  try {
    const older = current.get();
    await oldArrived.promise;
    expect(await client.call("command", "new")).toBe("new");
    expect(await older).toBe("new");
    expect(await current.get()).toBe("new");
    expect(updates).toEqual(["new"]);
    expect(paths).toEqual([`/_remote/${remoteBatchPath}`, "/_remote/command"]);

    releaseOld.resolve();
    await oldBodySent.promise;
    // Crossing another scheduled batch gives the released response an earlier turn to settle.
    await client.query("row", "fence").get();
    expect(await current.get()).toBe("new");
    expect(updates).toEqual(["new"]);
  } finally {
    releaseOld.resolve();
    stop();
  }
});

test("V: invalid batch envelopes execute no query or command", async () => {
  let executions = 0;
  const registry = {
    count: defineRemote({
      kind: "query",
      validate: Number,
      handle: () => ++executions,
    }),
    command: defineRemote({
      kind: "command",
      validate: Number,
      handle: () => ++executions,
    }),
  };
  const url = `http://app.test/_remote/${remoteBatchPath}`;
  const event = eventFor(url);
  const send = (entries: unknown[], origin = event.url.origin) =>
    dispatchRemote(
      registry,
      new Request(url, {
        method: "POST",
        headers: { origin, "content-type": remoteContentType },
        body: encodeRemote({ version: 1, kind: "batch", entries }),
      }),
      event,
    );
  const count = { name: "count", input: 0 };
  const invalid = await Promise.all([
    send([count], "http://foreign.test"),
    send([count, { name: "command", input: 0 }]),
    send([count, { name: "count" }]),
    send([]),
    send(Array.from({ length: remoteBatchLimit + 1 }, () => count)),
  ]);
  expect(invalid.map(({ status }) => status)).toEqual([
    403, 400, 400, 400, 413,
  ]);
  expect(executions).toBe(0);

  const valid = await send([
    { name: "count", input: 1 },
    { name: "count", input: 1 },
  ]);
  expect(valid.status).toBe(200);
  expect(decodeRemote(await valid.text())).toMatchObject({
    entries: [
      { value: 1, ok: true },
      { value: 1, ok: true },
    ],
  });
  expect(executions).toBe(1);
});
