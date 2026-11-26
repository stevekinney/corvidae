import { expect, test } from "bun:test";
import type { Fetch } from "../data/contract.ts";
import { createEvent } from "./request.ts";
import type { ApplicationOptions } from "./types.ts";

const options: ApplicationOptions = {
  generation: {
    directory: "/tmp/velveteen-cookie-tests",
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
  dispatch: (request: Request) => Response | Promise<Response> = async () =>
    new Response("ok"),
  request = new Request("https://app.test/start"),
) {
  const fetchDispatch: Fetch = async (input, init) =>
    dispatch(input instanceof Request ? input : new Request(input, init));
  return createEvent(
    request,
    new URL(request.url),
    new AbortController().signal,
    fetchDispatch,
    options,
  );
}

test("parses quoted and percent-encoded request cookie values", () => {
  const context = eventFor(
    undefined,
    new Request("https://app.test/", {
      headers: { cookie: 'quoted="hello world"; encoded=hello%20world' },
    }),
  );

  expect(context.event.cookies.get("quoted")).toBe('"hello world"');
  expect(context.event.cookies.get("encoded")).toBe("hello world");
  expect(context.event.cookies.getAll()).toEqual([
    { name: "quoted", value: '"hello world"' },
    { name: "encoded", value: "hello world" },
  ]);
});

test("preserves duplicate request cookies in header order", () => {
  const context = eventFor(
    undefined,
    new Request("https://app.test/", {
      headers: { cookie: "session=private; session=root; other=1" },
    }),
  );

  expect(context.event.cookies.get("session")).toBe("private");
  expect(context.event.cookies.getAll()).toEqual([
    { name: "session", value: "private" },
    { name: "session", value: "root" },
    { name: "other", value: "1" },
  ]);
  context.event.cookies.set("session", "next", { path: "/" });
  expect(context.event.cookies.getAll()).toEqual([
    { name: "session", value: "next" },
    { name: "other", value: "1" },
  ]);
});

test("serializes every supported cookie attribute with defaults", () => {
  const context = eventFor();
  context.event.cookies.set("all", "space value", {
    path: "/path",
    domain: ".app.test",
    expires: new Date("2030-01-02T03:04:05.000Z"),
    maxAge: 60,
    httpOnly: false,
    secure: true,
    sameSite: "strict",
    partitioned: true,
  });
  context.event.cookies.set("default", "yes", { path: "/" });

  expect(context.apply(new Response("ok")).headers.getSetCookie()).toEqual([
    "all=space%20value; Domain=.app.test; Path=/path; Expires=Wed, 02 Jan 2030 03:04:05 GMT; Max-Age=60; Secure; Partitioned; SameSite=Strict",
    "default=yes; Path=/; Secure; HttpOnly; SameSite=Lax",
  ]);
});

test("requires an explicit path for mutations", () => {
  const context = eventFor();

  expect(() =>
    context.event.cookies.set("missing", "path", {} as never),
  ).toThrow("Cookies require an explicit path");
  expect(() => context.event.cookies.delete("missing", {} as never)).toThrow(
    "Cookies require an explicit path",
  );
});

test("scopes internal set-cookie values by path and domain", async () => {
  const seen: Array<{ path: string; cookie: string | null }> = [];
  const context = eventFor(async (request) => {
    const path = new URL(request.url).pathname;
    seen.push({ path, cookie: request.headers.get("cookie") });
    if (path === "/set") {
      const headers = new Headers();
      headers.append("set-cookie", "private=1; Path=/private");
      headers.append("set-cookie", "domain=1; Domain=app.test; Path=/");
      headers.append("set-cookie", "wrong=1; Domain=other.test; Path=/");
      return new Response("set", { headers });
    }
    return new Response("ok");
  });

  await context.event.fetch("/set");
  await context.event.fetch("/public");
  await context.event.fetch("/private/child");

  expect(seen).toEqual([
    { path: "/set", cookie: null },
    { path: "/public", cookie: "domain=1" },
    { path: "/private/child", cookie: "private=1; domain=1" },
  ]);
});
