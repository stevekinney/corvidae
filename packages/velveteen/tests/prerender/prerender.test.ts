import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import { prerender } from "../../src/prerender/index.ts";
import { resolvePageOptions } from "../../src/server/page-options.ts";
import { createStaticHandler } from "../../src/prerender/serve.ts";
import {
  buildServiceWorker,
  serviceWorkerVersion,
} from "../../src/prerender/service-worker.ts";

test("prerenders a real production generation and preserves the static manifest", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/prerender-"),
  );
  try {
    const routes = join(root, "routes");
    await mkdir(routes, { recursive: true });
    await Bun.write(join(routes, "+page.svelte"), "<h1>static home</h1>");
    await Bun.write(join(routes, "+page.ts"), "export const prerender = true;");
    const generation = await buildProduction({
      projectDirectory: root,
      routesDirectory: routes,
      outputDirectory: join(root, "generation"),
    });
    const result = await prerender({
      generation,
      outputDirectory: join(root, "static"),
      origin: "http://example.test",
    });
    expect(
      await Bun.file(join(result.directory, "index.html")).text(),
    ).toContain("static home");
    expect(
      result.manifest.responses.filter((record) =>
        record.headers["content-type"]?.startsWith("text/html"),
      ),
    ).toHaveLength(1);
    expect(result.manifest.responses[0].status).toBe(200);
    const accepted = await Bun.file(
      join(result.directory, "index.html"),
    ).text();
    expect(
      await throwingRejectionOf(
        prerender({
          generation,
          outputDirectory: join(root, "static"),
          hooks: {
            init: () => {
              throw new Error("render failed");
            },
          },
        }),
      ),
    ).toThrow("render failed");
    expect(await Bun.file(join(result.directory, "index.html")).text()).toBe(
      accepted,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic prerender entries are explicit", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/prerender-dynamic-"),
  );
  try {
    const routes = join(root, "routes/blog/[slug]");
    await mkdir(routes, { recursive: true });
    await Bun.write(join(routes, "+page.svelte"), "<h1>dynamic</h1>");
    await Bun.write(join(routes, "+page.ts"), "export const prerender = true;");
    const generation = await buildProduction({
      projectDirectory: root,
      routesDirectory: join(root, "routes"),
      outputDirectory: join(root, "generation"),
    });
    expect(
      await throwingRejectionOf(
        prerender({
          generation,
          outputDirectory: join(root, "static"),
          origin: "http://example.test",
        }),
      ),
    ).toThrow("missing prerender entry");
    await Bun.write(
      join(routes, "+page.ts"),
      "export const prerender = true; export const entries = () => [{ slug: 'one' }];",
    );
    const withEntry = await buildProduction({
      projectDirectory: root,
      routesDirectory: join(root, "routes"),
      outputDirectory: join(root, "generation"),
    });
    const result = await prerender({
      generation: withEntry,
      outputDirectory: join(root, "static"),
      origin: "http://example.test",
    });
    expect(
      result.manifest.responses
        .filter((response) =>
          response.headers["content-type"]?.startsWith("text/html"),
        )
        .map((response) => response.url),
    ).toEqual(["http://example.test/blog/one"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service-worker versions use sorted public identities", async () => {
  const files = [
    { url: "/b.js", sha256: "b" },
    { url: "/a.js", sha256: "a" },
  ];
  expect(serviceWorkerVersion(files)).toBe(
    serviceWorkerVersion([...files].reverse()),
  );
  expect(
    serviceWorkerVersion([{ ...files[0], sha256: "changed" }, files[1]]),
  ).not.toBe(serviceWorkerVersion(files));
  const root = await mkdtemp(join(process.cwd(), ".velveteen/build/sw-"));
  try {
    const install = join(root, "worker.ts");
    await Bun.write(
      install,
      "export function install(metadata){self.addEventListener('install',event=>event.waitUntil(Promise.resolve(metadata.version)));}",
    );
    const result = await buildServiceWorker({
      install,
      outputDirectory: root,
      base: "/app",
      build: "build-a",
      files,
      prerendered: ["/app/"],
    });
    expect(await Bun.file(result.file).exists()).toBe(true);
    expect(result.metadata.base).toBe("/app");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("page options use server then universal precedence and endpoint exports", async () => {
  const module = (value: Record<string, unknown>) => async () => value;
  const registry = {
    nodes: [
      {
        layoutServer: module({ prerender: false }),
        layoutUniversal: module({ prerender: true }),
        pageServer: module({ trailingSlash: "always" }),
        pageUniversal: module({
          trailingSlash: "never",
          entries: () => [{ id: 1 }],
        }),
        endpoint: module({ prerender: true }),
      },
    ],
    manifest: { version: 1 as const, nodes: [], routes: [] },
  };
  const page = await resolvePageOptions(registry, {
    id: "/",
    pattern: "^/$",
    params: [],
    node: 0,
    leaf: 0,
    ancestors: [0],
    layouts: [0],
    errors: [null],
  });
  expect(page.prerender).toBe(true);
  expect(page.trailingSlash).toBe("never");
  expect(await (page.entries as () => unknown)()).toEqual([{ id: 1 }]);
  const endpoint = await resolvePageOptions(registry, {
    id: "/api",
    pattern: "^/api$",
    params: [],
    node: 0,
    ancestors: [0],
    layouts: [null],
    errors: [null],
  });
  expect(endpoint.prerender).toBe(true);
});

test("published static responses are portable through the native handler", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/static-handler-"),
  );
  try {
    await Bun.write(join(root, "index.html"), "offline page");
    const handler = createStaticHandler(root, {
      version: 1,
      basePath: "",
      responses: [
        {
          status: 200,
          headers: { "content-type": "text/html" },
          file: "index.html",
          url: "http://example.test/",
          sha256: "unused-test-identity",
        },
      ],
    });
    expect(
      await (await handler(new Request("http://example.test/"))).text(),
    ).toBe("offline page");
    expect(
      (await handler(new Request("http://example.test/missing"))).status,
    ).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("H02: a failed service-worker build preserves the prior worker bytes", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/sw-failed-"),
  );
  try {
    const install = join(root, "worker.ts");
    await Bun.write(
      install,
      "export function install(){self.addEventListener('install',event=>event.waitUntil(Promise.resolve()));}",
    );
    const options = {
      outputDirectory: join(root, "output"),
      base: "/app",
      build: "version",
      files: [],
      prerendered: [],
      install,
    };
    const accepted = await buildServiceWorker(options);
    const bytes = await Bun.file(accepted.file).text();
    await Bun.write(install, "export function install( broken");
    expect(await throwingRejectionOf(buildServiceWorker(options))).toThrow();
    expect(await Bun.file(accepted.file).text()).toBe(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
