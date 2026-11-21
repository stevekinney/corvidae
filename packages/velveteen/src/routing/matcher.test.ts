import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildRouteManifest, matchRoute } from "./index.ts";
import { parseRoute } from "./grammar.ts";

async function fixture(files: Record<string, string>) {
  const parent = join(import.meta.dir, "../../.velveteen/routing");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "matcher-"));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await Bun.write(join(directory, file), source);
  }
  return directory;
}

// Derived from the pinned Kit routing.spec.js matcher and decoding cases.
test("L01: required matchers preserve precedence, primitive outputs, and one decode", async () => {
  const root = await fixture({
    "params.ts": `export const params = {
      digits: (value) => /^\\d+$/.test(value) ? 0 : undefined,
      falsey: () => false,
      encoded: (value) => value === "%2F" ? value : undefined,
    };`,
    "items/[id=digits]/+page.svelte": "<p>matched</p>",
    "items/[slug]/+page.svelte": "<p>plain</p>",
    "items/456/+page.svelte": "<p>static</p>",
    "value/[id=falsey]/+page.svelte": "<p>falsey</p>",
    "encoded/[id=encoded]/+page.svelte": "<p>encoded</p>",
  });
  try {
    const manifest = await buildRouteManifest(root, {
      matcherModule: join(root, "params.ts"),
    });
    const matchers = {
      digits: (value: string) => (/^\d+$/.test(value) ? 0 : undefined),
      falsey: () => false,
      encoded: (value: string) => (value === "%2F" ? value : undefined),
    };
    expect(matchRoute(manifest, "/items/456", matchers)?.route.id).toBe(
      "/items/456",
    );
    expect(matchRoute(manifest, "/items/123", matchers)?.params.id).toBe(0);
    expect(matchRoute(manifest, "/items/123", matchers)?.route.id).toBe(
      "/items/[id=digits]",
    );
    expect(matchRoute(manifest, "/items/name", matchers)?.route.id).toBe(
      "/items/[slug]",
    );
    expect(matchRoute(manifest, "/value/anything", matchers)?.params).toEqual({
      id: false,
    });
    expect(matchRoute(manifest, "/encoded/%252F", matchers)?.params).toEqual({
      id: "%2F",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L01: matcher declarations and runtime results fail at their owning boundary", async () => {
  const root = await fixture({
    "params.ts": "export const params = { valid: () => true };",
    "missing/[id=unknown]/+page.svelte": "<p>missing</p>",
  });
  try {
    expect(
      await throwingRejectionOf(
        buildRouteManifest(root, { matcherModule: join(root, "params.ts") }),
      ),
    ).toThrow("unknown");
    const route = {
      id: "/x/[id=valid]",
      pattern: "^/x/([^/]+?)/?$",
      params: [{ name: "id", matcher: "valid", optional: false, rest: false }],
    };
    expect(() => matchRoute({ routes: [route] }, "/x/a")).toThrow(
      "runtime registry",
    );
    expect(() =>
      matchRoute({ routes: [route] }, "/x/a", {
        valid: () => ({}) as never,
      }),
    ).toThrow("primitive");
    expect(() =>
      matchRoute({ routes: [route] }, "/x/a", {
        valid: () => Promise.reject(new Error("late failure")) as never,
      }),
    ).toThrow("asynchronous");
    expect(() =>
      matchRoute({ routes: [route] }, "/x/a", {
        valid: () => {
          throw new URIError("matcher failure");
        },
      }),
    ).toThrow("Parameter matcher valid failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("L01: matcher source changes are revalidated on the next build", async () => {
  const root = await fixture({
    "params.ts": "export { params } from './definitions.ts';",
    "definitions.ts": "export const params = { valid: () => true };",
    "[id=valid]/+page.svelte": "<p>valid</p>",
  });
  try {
    const options = { matcherModule: join(root, "params.ts") };
    const first = await buildRouteManifest(root, options);
    expect(first.matcherModule).toBe(options.matcherModule);
    await Bun.write(
      join(root, "definitions.ts"),
      "export const params = { changed: () => true };",
    );
    expect(
      await throwingRejectionOf(buildRouteManifest(root, options)),
    ).toThrow("valid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M01: qualified optionals and rest captures follow pinned reassignment rules", () => {
  const calls: Array<[string, string]> = [];
  const matchers = {
    reject: (value: string) => {
      calls.push(["reject", value]);
      return undefined;
    },
    accept: (value: string) => {
      calls.push(["accept", value]);
      return false;
    },
    empty: (value: string) => {
      calls.push(["empty", value]);
      return value === "" ? "empty" : undefined;
    },
    encoded: (value: string) => {
      calls.push(["encoded", value]);
      return value === "%2F" ? value : undefined;
    },
  };
  const route = (id: string) => {
    const parsed = parseRoute(id);
    return { id, ...parsed };
  };

  const skipped = matchRoute(
    { routes: [route("/[[first=reject]]/[second]/[...rest]")] },
    "/one/two/three",
    matchers,
  );
  expect(skipped?.params).toEqual({ second: "one", rest: "two/three" });
  expect(calls).toEqual([["reject", "one"]]);

  calls.length = 0;
  const absent = matchRoute(
    { routes: [route("/[[first=reject]]/sub")] },
    "/sub",
    matchers,
  );
  expect(absent?.params).toEqual({});
  expect(calls).toEqual([]);

  calls.length = 0;
  const qualifiedRest = matchRoute(
    { routes: [route("/foo/[...rest=empty]/edit")] },
    "/foo/edit",
    matchers,
  );
  expect(qualifiedRest?.params).toEqual({ rest: "empty" });
  expect(calls).toEqual([["empty", ""]]);

  calls.length = 0;
  const falsy = matchRoute(
    { routes: [route("/[[first=reject]]/[[second=accept]]/[...rest]")] },
    "/one/two/three",
    matchers,
  );
  expect(falsy?.params).toEqual({ second: false, rest: "two/three" });
  expect(calls).toEqual([
    ["reject", "one"],
    ["accept", "one"],
  ]);

  calls.length = 0;
  const decoded = matchRoute(
    { routes: [route("/encoded/[value=encoded]")] },
    "/encoded/%252F",
    matchers,
  );
  expect(decoded?.params).toEqual({ value: "%2F" });
  expect(calls).toEqual([["encoded", "%2F"]]);
});

test("M01: pinned Kit agrees on chained captures, suffixes, and omitted values", async () => {
  const upstream = join(
    import.meta.dir,
    "../../tests/reference/node_modules/@sveltejs/kit/src",
  );
  const { find_route, parse_route_id } = await import(
    join(upstream, "utils/routing.js")
  );
  const { defineParams } = await import(
    join(upstream, "exports/params/index.js")
  );
  const matchers = {
    reject: () => undefined,
    digits: (value: string) =>
      /^\d+$/.test(value) ? Number(value) : undefined,
    path: (value: string) => value,
    empty: (value: string) => (value === "" ? false : undefined),
    nonEmpty: (value: string) => value || undefined,
  };
  const cases = [
    [
      "/[[a=reject]]/[[b=digits]]/[[c=reject]]/[...tail=path].json",
      "/42/bar/baz.json",
      { b: 42, tail: "bar/baz" },
    ],
    ["/trailing/[[item=empty]]", "/trailing/", {}],
    [
      "/(manual)/docs/[[section=digits]]/[...tail=path]",
      "/docs/guide/install",
      { tail: "guide/install" },
    ],
    ["/docs/[[section=digits]]/[...tail=path]", "/docs/%252F", { tail: "%2F" }],
    ["/files/[...tail=empty]/edit", "/files/edit", { tail: false }],
    ["/files/[...tail=nonEmpty]/edit", "/files/edit", undefined],
  ] as const;
  for (const [id, pathname, expected] of cases) {
    const reference = find_route(
      pathname,
      [{ id, ...parse_route_id(id) }],
      defineParams(matchers),
    );
    const candidate = matchRoute(
      { routes: [{ id, ...parseRoute(id) }] },
      pathname,
      matchers,
    );
    expect(reference?.params).toEqual(expected);
    expect(candidate?.params).toEqual(expected);
  }
});

test("R: escaped filename literals decode as static route text", () => {
  expect(parseRoute("/[x+2e]well-known/[u+0041]/[one]")).toEqual({
    pattern: "^/\\.well-known/A/([^/]+?)/?$",
    params: [
      {
        name: "one",
        matcher: undefined,
        optional: false,
        rest: false,
        chained: false,
      },
    ],
  });
  expect(parseRoute("/literal[x+2f]part").pattern).toBe(
    "^/literal%2[Ff]part/?$",
  );
  expect(parseRoute("/a[x+23][id]").pattern).toBe("^/a%23([^/]+?)/?$");
  expect(() => parseRoute("/broken][id]")).toThrow("unbalanced parameter");
  expect(() => parseRoute("/prefix[[id]]")).toThrow("unsupported parameter");
  expect(() => parseRoute("/[first][second]")).toThrow("Adjacent parameters");
  expect(() =>
    parseRoute("/[u+110000]", "/routes/[u+110000]/+page.svelte"),
  ).toThrow("Invalid route escape sequence");
});
