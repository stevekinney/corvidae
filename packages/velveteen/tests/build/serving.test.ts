import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createProductionAssetRoutes } from "../../src/build/serving.ts";
import type {
  ProductionGeneration,
  ProductionManifest,
} from "../../src/build/manifest-types.ts";

const digest = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const BunDecompressionStream = DecompressionStream as new (
  format: Bun.CompressionFormat,
) => DecompressionStream;

test("D06: production assets use an exact whitelist and native file serving", async () => {
  await mkdir(join(process.cwd(), ".velveteen/build"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".velveteen/build/serving-"));
  const directory = join(root, "generation");
  await mkdir(join(directory, "browser"), { recursive: true });
  await mkdir(join(directory, "static"), { recursive: true });
  const browserBody = "console.log('asset');\n";
  const staticBody = "hello static\n";
  const unicodeBody = "hello unicode\n";
  await Bun.write(join(directory, "browser/app.js"), browserBody);
  await Bun.write(join(directory, "static/readme.txt"), staticBody);
  await Bun.write(join(directory, "static/hello world.txt"), unicodeBody);
  const manifest: ProductionManifest = {
    version: 1,
    basePath: "/app",
    routing: { version: 1, nodes: [], routes: [] },
    client: {
      file: "browser/app.js",
      url: "/app/_assets/app.js",
      stylesheets: [],
      nodes: {},
    },
    server: { file: "server/server.js", nodes: {} },
    routes: {},
    assets: [
      {
        file: "browser/app.js",
        target: "browser",
        bytes: browserBody.length,
        sha256: digest(browserBody),
        url: "/app/_assets/app.js",
        contentType: "text/javascript; charset=utf-8",
        immutable: true,
      },
      {
        file: "static/readme.txt",
        target: "static",
        bytes: staticBody.length,
        sha256: digest(staticBody),
        url: "/app/readme.txt",
        contentType: "text/plain; charset=utf-8",
        immutable: false,
      },
      {
        file: "static/hello world.txt",
        target: "static",
        bytes: unicodeBody.length,
        sha256: digest(unicodeBody),
        url: "/app/hello%20world.txt",
        contentType: "text/plain; charset=utf-8",
        immutable: false,
      },
    ],
    outputs: [
      {
        file: "browser/app.js",
        target: "browser",
        bytes: browserBody.length,
        sha256: digest(browserBody),
      },
      {
        file: "static/readme.txt",
        target: "static",
        bytes: staticBody.length,
        sha256: digest(staticBody),
      },
      {
        file: "static/hello world.txt",
        target: "static",
        bytes: unicodeBody.length,
        sha256: digest(unicodeBody),
      },
    ],
  };
  const generation: ProductionGeneration = { directory, manifest };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: createProductionAssetRoutes(generation),
    fetch: () => new Response("not found", { status: 404 }),
  });
  const url = (path: string) => new URL(path, server.url);
  try {
    const get = await fetch(url("/app/_assets/app.js"));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(browserBody);
    expect(get.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    const etag = get.headers.get("etag");
    expect(etag).toBe(`"${digest(browserBody)}"`);

    const head = await fetch(url("/app/_assets/app.js"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(browserBody.length));

    const range = await fetch(url("/app/_assets/app.js"), {
      headers: { range: "bytes=0-6" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("console");
    expect(range.headers.get("content-range")).toBe(
      `bytes 0-6/${browserBody.length}`,
    );
    const unsatisfiable = await fetch(url("/app/_assets/app.js"), {
      headers: { range: "bytes=999-1000" },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(await unsatisfiable.text()).toBe("");

    const notModified = await fetch(url("/app/_assets/app.js"), {
      headers: { "if-none-match": `W/${etag}, "other"` },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get("etag")).toBe(etag);

    const headNotModified = await fetch(url("/app/_assets/app.js"), {
      method: "HEAD",
      headers: { "if-none-match": etag! },
    });
    expect(headNotModified.status).toBe(304);
    expect(await headNotModified.text()).toBe("");
    expect(
      (
        await fetch(url("/app/_assets/app.js"), {
          headers: { "if-none-match": "unmatched" },
        })
      ).status,
    ).toBe(200);
    const staticResponse = await fetch(url("/app/readme.txt"));
    expect(staticResponse.status).toBe(200);
    expect(await staticResponse.text()).toBe(staticBody);
    expect(staticResponse.headers.get("cache-control")).toBe("no-cache");
    const unicodeResponse = await fetch(url("/app/hello%20world.txt"));
    expect(unicodeResponse.status).toBe(200);
    expect(await unicodeResponse.text()).toBe(unicodeBody);
    const nativeRange = await fetch(url("/app/_assets/app.js"), {
      headers: {
        range: "bytes=0-6",
        "accept-encoding": "br, identity;q=0",
      },
    });
    expect(nativeRange.status).toBe(206);
    expect(await nativeRange.text()).toBe("console");
    expect(nativeRange.headers.get("vary")).toBeNull();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await fetch(url("/app/_assets/app.js"), { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
    for (const path of [
      "/app/unknown.js",
      "/app/server/server.js",
      "/app/../browser/app.js",
      "/app/%2e%2e/browser/app.js",
      "/app/_assets/app.js?query=1",
    ]) {
      expect((await fetch(url(path))).status).toBe(
        path.includes("?") ? 200 : 404,
      );
    }
    const compressedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      routes: createProductionAssetRoutes(generation, { compression: true }),
      fetch: () => new Response("not found", { status: 404 }),
    });
    try {
      const compressedRoutes = createProductionAssetRoutes(generation, {
        compression: true,
      });
      const compressed = compressedRoutes["/app/_assets/app.js"](
        new Request("http://localhost/app/_assets/app.js", {
          headers: { "accept-encoding": "gzip;q=0.5, br;q=0.8" },
        }),
      );
      expect(compressed.status).toBe(200);
      expect(compressed.headers.get("content-encoding")).toBe("br");
      expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
      expect(compressed.headers.get("etag")).not.toBe(etag);
      const decoded = new Response(
        (await compressed.blob())
          .stream()
          .pipeThrough(new BunDecompressionStream("brotli")),
      );
      expect(await decoded.text()).toBe(browserBody);
      const excluded = compressedRoutes["/app/_assets/app.js"](
        new Request("http://localhost/app/_assets/app.js", {
          headers: { "accept-encoding": "br;q=0, gzip;q=0, identity;q=0" },
        }),
      );
      expect(excluded.status).toBe(406);
      expect(excluded.headers.get("vary")).toBe("Accept-Encoding");
      for (const [preference, encoding, status] of [
        ["", null, 200],
        ["zstd", null, 200],
        ["br;q=0, *;q=1", "gzip", 200],
        ["*;q=0", null, 406],
        ["br;q=0.3, gzip;q=0.8", "gzip", 200],
        ["br;q=0.8, identity;q=0.9", null, 200],
        ["GZIP;q=0x1", null, 200],
      ] as const) {
        const negotiated = compressedRoutes["/app/_assets/app.js"](
          new Request("http://localhost/app/_assets/app.js", {
            headers: { "accept-encoding": preference },
          }),
        );
        expect(negotiated.status).toBe(status);
        expect(negotiated.headers.get("content-encoding")).toBe(encoding);
        expect(negotiated.headers.get("vary")).toBe("Accept-Encoding");
        await negotiated.body?.cancel();
      }
      const ranged = await fetch(
        new URL("/app/_assets/app.js", compressedServer.url),
        {
          headers: {
            range: "bytes=0-6",
            "accept-encoding": "br, gzip",
          },
        },
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-encoding")).toBeNull();
      expect(await ranged.text()).toBe("console");
    } finally {
      await compressedServer.stop(true);
    }
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("D06: asset registration rejects an escaping path or non-base URL", async () => {
  await mkdir(join(process.cwd(), ".velveteen/build"), { recursive: true });
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/serving-invalid-"),
  );
  try {
    const manifest = {
      version: 1 as const,
      basePath: "/app",
      routing: { version: 1 as const, nodes: [], routes: [] },
      client: {
        file: "browser/app.js",
        url: "/app/app.js",
        stylesheets: [],
        nodes: {},
      },
      server: { file: "server/server.js", nodes: {} },
      routes: {},
      assets: [
        {
          file: "../secret.js",
          target: "browser" as const,
          bytes: 1,
          sha256: "0".repeat(64),
          url: "/app/_assets/app.js",
          contentType: "text/javascript",
          immutable: true,
        },
      ],
      outputs: [],
    } as unknown as ProductionManifest;
    expect(() =>
      createProductionAssetRoutes({ directory: root, manifest }),
    ).toThrow("public file mapping");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
