import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import {
  buildRouteManifest,
  createClientManifest,
  createRouteDispatcher,
  matchRoute,
} from "./index.ts";
import { RouteDiagnostic } from "./grammar.ts";

const parent = join(import.meta.dir, "../../.velveteen/routing");
const fixtures = {
  "+layout.svelte": "<main>Layout metadata fixture</main>",
  "+layout.server.ts": "export const load = () => ({ private: true });",
  "+error.svelte": "<p>Error</p>",
  "(marketing)/+page.svelte": "<h1>Home</h1>",
  "users/[id]/+page.svelte": "<h1>User</h1>",
  "users/[id]/+page.ts": "export const load = () => ({ title: 'User' });",
  "users/[id]/+page.server.ts": "export const load = () => ({ user: 'User' });",
  "users/[id]/+server.ts": "export const GET = () => new Response('User');",
  "settings/+layout.svelte": "<section>Layout only</section>",
  "settings/deep/[name]/+page.svelte": "<p>Nested</p>",
  "users/new/+page.svelte": "<h1>New</h1>",
  "files/static/+server.ts": "export const GET = () => new Response('Static');",
  "files/[...path]/+server.ts":
    "export const GET = () => new Response('File');",
  "documents/[name].[extension]/+page.svelte": "<p>Document</p>",
  "localized/[[lang]]/+page.svelte": "<p>Localized</p>",
  "localized/+page.svelte": "<p>Default locale</p>",
  "optional/[[lang]]/+page.svelte": "<p>Optional</p>",
  "optional/[[lang]]/about/+page.svelte": "<p>About</p>",
  "overlap/[...rest]/end/+page.svelte": "<p>Rest</p>",
  "overlap/[id]/+page.svelte": "<p>Required</p>",
  "café/+page.svelte": "<p>Unicode</p>",
  "100%/+page.svelte": "<p>Percent</p>",
};
const cases: Array<
  [string, { id: string; params: Record<string, string> } | null]
> = [
  ["/", { id: "/(marketing)", params: {} }],
  ["/users/new", { id: "/users/new", params: {} }],
  ["/users/new/", { id: "/users/new", params: {} }],
  ["/users/alice", { id: "/users/[id]", params: { id: "alice" } }],
  ["/users/a%2Fb", { id: "/users/[id]", params: { id: "a/b" } }],
  ["/users/%252F", { id: "/users/[id]", params: { id: "%2F" } }],
  ["/files/static", { id: "/files/static", params: {} }],
  ["/files", { id: "/files/[...path]", params: { path: "" } }],
  ["/files/a/b/", { id: "/files/[...path]", params: { path: "a/b/" } }],
  [
    "/documents/a.b.c",
    {
      id: "/documents/[name].[extension]",
      params: { name: "a", extension: "b.c" },
    },
  ],
  ["/localized", { id: "/localized", params: {} }],
  ["/localized/en", { id: "/localized/[[lang]]", params: { lang: "en" } }],
  ["/overlap/end", { id: "/overlap/[...rest]/end", params: { rest: "" } }],
  [
    "/overlap/a/b/end",
    { id: "/overlap/[...rest]/end", params: { rest: "a/b" } },
  ],
  ["/overlap/a", { id: "/overlap/[id]", params: { id: "a" } }],
  ["/caf%C3%A9", { id: "/café", params: {} }],
  ["/100%25", { id: "/100%", params: {} }],
  ["/optional", { id: "/optional/[[lang]]", params: {} }],
  ["/optional/about", { id: "/optional/[[lang]]/about", params: {} }],
  [
    "/optional/en/about",
    { id: "/optional/[[lang]]/about", params: { lang: "en" } },
  ],
  ["/absent", null],
];
async function fixture(files: Record<string, string> = fixtures) {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await Bun.write(join(root, file), source);
  }
  return root;
}

test("C01: native probes identify compatible paths and exact matching gaps", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/static": () => new Response("static"),
      "/users/:id": (request) => new Response(`id=${request.params.id}`),
      "/files/*": (request) =>
        new Response(`rest=${(request.params as Record<string, string>)["*"]}`),
      "/embedded/:slug.json": (request) =>
        new Response(`json=${(request.params as Record<string, string>).slug}`),
    },
    fetch: () => new Response("fallback"),
  });
  try {
    const observations = Object.fromEntries(
      await Promise.all(
        [
          "static",
          "static/",
          "users/a%2Fb",
          "files",
          "files/a/b",
          "embedded/a.json",
        ].map(async (path) => {
          const fetchedResponse = await fetch(new URL(path, server.url));
          return [path, await fetchedResponse.text()];
        }),
      ),
    );
    expect(observations).toEqual({
      static: "static",
      "static/": "fallback",
      "users/a%2Fb": "id=a/b",
      files: "fallback",
      "files/a/b": "rest=undefined",
      "embedded/a.json": "json=undefined",
    });
    await Bun.write(
      join(parent, "../evidence/c01-native-routing.json"),
      JSON.stringify({ bun: Bun.version, observations }, null, 2),
    );
  } finally {
    await server.stop(true);
  }
});

test("C02: canonical discovery preserves physical ancestry and removes private browser metadata", async () => {
  const root = await fixture();
  try {
    const manifest = await buildRouteManifest(root);
    expect(manifest).toEqual(await buildRouteManifest(root));
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(
      JSON.parse(JSON.stringify(await buildRouteManifest(root))),
    );
    const route = manifest.routes.find(
      (route) => route.id === "/settings/deep/[name]",
    )!;
    expect(route.ancestors.map((index) => manifest.nodes[index].id)).toEqual([
      "/",
      "/settings",
      "/settings/deep",
      "/settings/deep/[name]",
    ]);
    expect(
      route.layouts.map((index) =>
        index === null ? null : manifest.nodes[index].id,
      ),
    ).toEqual(["/", "/settings", null, null]);
    expect(
      route.errors.map((index) =>
        index === null ? null : manifest.nodes[index].id,
      ),
    ).toEqual(["/", null, null, null]);
    const user = manifest.nodes.find((node) => node.id === "/users/[id]")!;
    expect(user.page).toEqual({
      component: "users/[id]/+page.svelte",
      universal: "users/[id]/+page.ts",
      server: "users/[id]/+page.server.ts",
    });
    expect(user.endpoint).toBe("users/[id]/+server.ts");
    const client = JSON.stringify(createClientManifest(manifest));
    expect(client).not.toContain(".server.ts");
    expect(client).not.toContain("+server.ts");
    expect(client).not.toContain(root);
    expect(client).toContain("+page.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function prepareReference() {
  const root = await fixture();
  try {
    const manifest = await buildRouteManifest(root);
    const reference = spawnWithHangGuard(
      [process.execPath, "tests/reference/routing-control.ts"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    reference.stdin.write(
      JSON.stringify({
        ids: manifest.routes.map((route) => route.id),
        paths: cases.map(([path]) => path),
      }),
    );
    reference.stdin.end();
    return await Promise.all([
      new Response(reference.stdout).text(),
      new Response(reference.stderr).text(),
      reference.exited,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const referenceResult = await prepareReference();

test("C03: pinned oracle, actual HTTP and Chromium share selected route results", async () => {
  const root = await fixture();
  const directory = await mkdtemp(join(parent, "browser-"));
  try {
    const manifest = await buildRouteManifest(root);
    const [referenceOutput, referenceError, referenceExit] = referenceResult;
    expect(referenceError).toBe("");
    expect(referenceExit).toBe(0);
    expect(JSON.parse(referenceOutput)).toEqual(
      cases.map(([, expected]) => expected),
    );
    const client = createClientManifest(manifest);
    await Bun.write(
      join(directory, "entry.ts"),
      `import { matchRoute } from ${JSON.stringify(join(import.meta.dir, "match.ts"))}; globalThis.checkRoute = (manifest, path) => { const match = matchRoute(manifest, path); return match ? {id: match.route.id, params: match.params} : null; };`,
    );
    const build = await Bun.build({
      entrypoints: [join(directory, "entry.ts")],
      target: "browser",
    });
    expect(build.success).toBe(true);
    const javascript = await build.outputs[0].text();
    expect(javascript).not.toContain("node:fs");
    const dispatcher = createRouteDispatcher(manifest, (_request, match) =>
      Response.json({ id: match.route.id, params: match.params }),
    );
    expect(Object.keys(dispatcher.routes)).toContain("/users/:id");
    expect(Object.keys(dispatcher.routes)).toContain("/");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, ...dispatcher });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addScriptTag({ type: "module", content: javascript });
      for (const [path, expected] of cases) {
        const matched = matchRoute(client, path);
        expect(
          matched ? { id: matched.route.id, params: matched.params } : null,
        ).toEqual(expected);
        const response = await fetch(new URL(path, server.url));
        expect(response.status).toBe(expected ? 200 : 404);
        if (expected) expect(await response.json()).toEqual(expected);
        const actual = await page.evaluate(
          ({ manifest, path }) => {
            const scope = globalThis as unknown as {
              checkRoute: (manifest: unknown, path: string) => unknown;
            };
            return scope.checkRoute(manifest, path);
          },
          { manifest: client, path },
        );
        expect(actual).toEqual(expected);
      }
      for (const malformed of ["/users/%", "/users/%E0%A4%A", "/bad%zz"]) {
        expect(() => matchRoute(client, malformed)).toThrow(URIError);
        const fetchedResponse2 = await fetch(new URL(malformed, server.url));
        expect(fetchedResponse2.status).toBe(400);
      }
      expect(errors).toEqual([]);
      await Bun.write(
        join(parent, "../evidence/c03-routing-consumers.json"),
        JSON.stringify(
          {
            bun: Bun.version,
            upstream: "a58e0a92c35dbeee161e96c733464dc7397e073a",
            cases,
            consumers: [
              "pinned Kit oracle",
              "Bun HTTP",
              "Chromium browser bundle",
            ],
            browserErrors: errors,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
      await server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("C04: unsupported syntax and file conflicts fail with source locations", async () => {
  for (const directory of [
    "[id]/[id]",
    "[bad!name]",
    "[id=integer]",
    "prefix[id]]",
    "[...rest]/[[optional]]",
    "[first][second]",
    "(broken",
  ]) {
    const root = await fixture({
      [`${directory}/+page.svelte`]: "<p>Invalid route</p>",
    });
    try {
      let error: unknown;
      try {
        await buildRouteManifest(root);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RouteDiagnostic);
      expect(String(error)).toContain(root);
      expect(String(error)).toContain("segment ");
      expect(String(error)).toContain(directory.split("/").at(-1)!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  for (const files of [
    ["+page.js", "+page.ts"],
    ["(a)/+page.svelte", "(b)/+page.svelte"],
    ["+page.svelte", "(a)/+page.svelte"],
    ["a/[id]/+page.svelte", "a/[other]/+page.svelte"],
  ]) {
    const root = await fixture(
      Object.fromEntries(files.map((file) => [file, "export {};"])),
    );
    try {
      let error: unknown;
      try {
        await buildRouteManifest(root);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      for (const file of files)
        expect(String(error)).toContain(join(root, file));
      if (files.some((file) => file.includes("/"))) {
        expect(error).toBeInstanceOf(RouteDiagnostic);
        if (error instanceof RouteDiagnostic) {
          expect(String(error)).toContain("Route conflict");
          expect(String(error)).toContain(`route ${error.routeId}`);
          expect(String(error)).toContain(`segment ${error.segmentIndex + 1}`);
          expect(files.map((file) => join(root, file))).toContain(
            error.sourcePath,
          );
          expect(error.segment).toBe(error.routeId.split("/").at(-1) || "/");
        }
      } else {
        expect(String(error)).toContain(
          files.length === 1
            ? "unsupported route file role"
            : "duplicate page universal",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("K01: named component layouts resolve effective branches and layout parents", async () => {
  const root = join(
    import.meta.dir,
    "../../tests/reference/upstream/packages/kit/src/core/sync/create_manifest_data/test/samples/named-layouts",
  );
  const manifest = await buildRouteManifest(root);
  const route = (id: string) =>
    manifest.routes.find((entry) => entry.id === id)!;
  const nodeIds = (indexes: number[]) =>
    indexes.map((index) => manifest.nodes[index].id);

  expect(nodeIds(route("/b/c/c2").ancestors)).toEqual(["/"]);
  expect(
    nodeIds(
      route("/b/c/c2").layouts.filter(
        (index): index is number => index !== null,
      ),
    ),
  ).toEqual(["/"]);
  expect(nodeIds(route("/b/d/(special)/(extraspecial)/d3").ancestors)).toEqual([
    "/",
    "/b",
    "/b/d",
    "/b/d/(special)",
  ]);
  expect(
    route("/b/d/(special)/(extraspecial)/d3").layouts.map((index) =>
      index === null ? null : manifest.nodes[index].id,
    ),
  ).toEqual(["/", null, null, "/b/d/(special)"]);
  expect(
    manifest.nodes.find((node) => node.id === "/b/d/(special)")?.layoutParentId,
  ).toBe("/");
  expect(
    manifest.nodes.find((node) => node.id === "/b/d/(special)/(extraspecial)")
      ?.layoutParentId,
  ).toBe("/b/d/(special)");
  expect(manifest.nodes.find((node) => node.id === "/b/c")?.parentId).toBe(
    "/b",
  );
});

test("K01: missing targets, named modules, and duplicate components fail", async () => {
  const cases: Array<[string, string, string]> = [
    ["+page@missing.svelte", "<h1>Missing</h1>", "missing"],
    [
      "module/+page@root.ts",
      "export const load = () => ({})",
      "component files",
    ],
  ];
  for (const [file, source, message] of cases) {
    const root = await fixture({ [file]: source });
    try {
      expect(await throwingRejectionOf(buildRouteManifest(root))).toThrow(
        message,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const root = await fixture({
    "+page.svelte": "<h1>One</h1>",
    "+page@.svelte": "<h1>Two</h1>",
  });
  try {
    expect(await throwingRejectionOf(buildRouteManifest(root))).toThrow(
      "duplicate page component",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
