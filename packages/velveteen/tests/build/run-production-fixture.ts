import { expect } from "bun:test";
import { chromium } from "@playwright/test";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packProductionFixture } from "./pack-production-fixture.ts";
import { startProductionFixture } from "./production-process.ts";

export async function verifyProductionFixture(
  basePath: string,
  name: string,
  options: {
    compression?: boolean;
    browserPlugins?: readonly Bun.BunPlugin[];
    incrementedLabel?: string;
  } = {},
) {
  const packed = await packProductionFixture(basePath, name, options);
  let server: Awaited<ReturnType<typeof startProductionFixture>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const { manifest } = packed.evidence;
    expect(
      await lstat(packed.evidence.sourceDirectory).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    for (let directory = packed.runtime; ; directory = dirname(directory)) {
      expect(
        await lstat(join(directory, "node_modules")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      if (dirname(directory) === directory) break;
    }
    server = await startProductionFixture(
      packed.runtime,
      packed.evidenceDirectory,
      { compression: packed.compression },
    );
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        errors.push(message.text());
    });
    page.on("response", (response) => {
      requests.push(response.url());
      if (response.status() >= 400)
        errors.push(`${response.status()} ${response.url()}`);
    });
    expect(server.bun).toBe(Bun.version);
    const root = server.url.replace(/\/$/, "") + manifest.basePath;
    const firstResponse = await fetch(root + "/");
    expect(firstResponse.status).toBe(200);
    const html = await firstResponse.text();
    expect(html).toContain("First: 0");
    if (options.incrementedLabel !== undefined) {
      const label = options.incrementedLabel;
      const scripts = packed.evidence.files.filter(({ file }) =>
        /\/(?:browser|server)\/.*\.js$/.test(file),
      );
      const matches = (
        await Promise.all(
          scripts.map(async ({ file }) =>
            (await Bun.file(join(packed.runtime, file)).text()).includes(label)
              ? file
              : undefined,
          ),
        )
      ).filter((file) => file !== undefined);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((file) => file.includes("/browser/"))).toBe(true);
    }
    expect(html).not.toContain("PRODUCTION_PRIVATE_SENTINEL");
    expect(html).not.toContain("PRODUCTION_DEV_SENTINEL");
    if (manifest.basePath) expect((await fetch(root)).status).toBe(200);
    expect(await (await fetch(server.url + "host-api")).json()).toEqual({
      host: "preserved",
    });
    expect(await (await fetch(root + "/compiled-endpoint")).json()).toEqual({
      compiledEndpoint: true,
    });
    expect(await (await fetch(root + "/plain.txt")).text()).toBe(
      "static production bytes\n",
    );
    expect(
      await (await fetch(root + "/hello%20world.txt?cache=1")).text(),
    ).toBe("encoded static filename\n");
    if (packed.compression) {
      const plainAsset = manifest.assets.find((asset) =>
        asset.url.endsWith("/plain.txt"),
      );
      expect(plainAsset).toBeDefined();
      if (!plainAsset)
        throw new Error("plain text asset missing from manifest");
      const assetUrl = root + "/plain.txt";
      const rawFetch = (input: string, init: RequestInit = {}) => {
        const options: RequestInit & { decompress: false } = {
          ...init,
          decompress: false,
        };
        return fetch(input, options);
      };
      const bytes = async (response: Response) =>
        new Uint8Array(await response.arrayBuffer());
      const digest = (value: Uint8Array) =>
        new Bun.CryptoHasher("sha256").update(value).digest("hex");
      const BunDecompressionStream = DecompressionStream as new (
        format: Bun.CompressionFormat,
      ) => DecompressionStream;
      const decode = (
        value: Uint8Array<ArrayBuffer>,
        format: "brotli" | "gzip",
      ) =>
        bytes(
          new Response(
            new Blob([value])
              .stream()
              .pipeThrough(new BunDecompressionStream(format)),
          ),
        );
      const identity = await rawFetch(assetUrl, {
        headers: { "accept-encoding": "identity" },
      });
      const identityBytes = await bytes(identity);
      expect(identity.status).toBe(200);
      expect(identity.headers.get("content-encoding")).toBeNull();
      expect(identity.headers.get("vary")).toContain("Accept-Encoding");
      expect(new TextDecoder().decode(identityBytes)).toBe(
        "static production bytes\n",
      );
      expect(digest(identityBytes)).toBe(plainAsset.sha256);
      const brotli = await rawFetch(assetUrl, {
        headers: { "accept-encoding": "br, gzip" },
      });
      const brotliBytes = await bytes(brotli);
      expect(brotli.status).toBe(200);
      expect(brotli.headers.get("content-encoding")).toBe("br");
      expect(brotli.headers.get("etag")).not.toBe(identity.headers.get("etag"));
      const brotliDigest = digest(await decode(brotliBytes, "brotli"));
      expect(brotliDigest).toBe(plainAsset.sha256);
      const gzip = await rawFetch(assetUrl, {
        headers: { "accept-encoding": "gzip, br;q=0" },
      });
      expect(gzip.headers.get("content-encoding")).toBe("gzip");
      const gzipBytes = await bytes(gzip);
      const gzipDigest = digest(await decode(gzipBytes, "gzip"));
      expect(gzipDigest).toBe(plainAsset.sha256);
      const quality = await rawFetch(assetUrl, {
        headers: { "accept-encoding": "br;q=0.8, gzip;q=0.6, identity;q=0" },
      });
      expect(quality.headers.get("content-encoding")).toBe("br");
      const compressedNotModified = await rawFetch(assetUrl, {
        headers: {
          "accept-encoding": "br, gzip",
          "if-none-match": brotli.headers.get("etag")!,
        },
      });
      expect(compressedNotModified.status).toBe(304);
      expect(await bytes(compressedNotModified)).toHaveLength(0);
      expect(compressedNotModified.headers.get("content-encoding")).toBe("br");
      const head = await rawFetch(assetUrl, {
        method: "HEAD",
        headers: { "accept-encoding": "br" },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-encoding")).toBe("br");
      expect(await bytes(head)).toHaveLength(0);
      const identityRange = await rawFetch(assetUrl, {
        headers: { "accept-encoding": "identity", range: "bytes=0-6" },
      });
      expect(identityRange.status).toBe(206);
      expect(new TextDecoder().decode(await bytes(identityRange))).toBe(
        "static ",
      );
      expect(identityRange.headers.get("content-encoding")).toBeNull();
      expect(identityRange.headers.get("etag")).toBe(
        identity.headers.get("etag"),
      );
      const implicitIdentityRange = await rawFetch(assetUrl, {
        headers: { "accept-encoding": "br", range: "bytes=0-6" },
      });
      expect(implicitIdentityRange.status).toBe(206);
      expect(implicitIdentityRange.headers.get("content-encoding")).toBeNull();
      expect(await bytes(implicitIdentityRange)).toHaveLength(7);
      const compressedRange = await rawFetch(assetUrl, {
        headers: {
          "accept-encoding": "br, identity;q=0",
          range: "bytes=0-6",
        },
      });
      expect(compressedRange.status).toBe(406);
      expect(compressedRange.headers.get("content-encoding")).toBeNull();
      expect(compressedRange.headers.get("vary")).toContain("Accept-Encoding");
      expect(await bytes(compressedRange)).toHaveLength(0);
      const emittedAsset = manifest.assets.find((asset) =>
        /^(text\/javascript|text\/css|application\/javascript)/.test(
          asset.contentType,
        ),
      );
      if (!emittedAsset)
        throw new Error("emitted JavaScript/CSS asset missing");
      const emitted = await rawFetch(
        root + emittedAsset.url.slice(manifest.basePath.length),
        { headers: { "accept-encoding": "br" } },
      );
      const emittedBytes = await bytes(emitted);
      expect(emitted.headers.get("content-encoding")).toBe("br");
      const emittedIdentity = await decode(emittedBytes, "brotli");
      expect(digest(emittedIdentity)).toBe(emittedAsset.sha256);
      const emittedAssetEvidence = {
        url: emittedAsset.url,
        encoding: emitted.headers.get("content-encoding"),
        identityDigest: digest(emittedIdentity),
      };
      await Bun.write(
        join(packed.evidenceDirectory, "compression.json"),
        JSON.stringify(
          {
            asset: plainAsset.url,
            identity: {
              status: identity.status,
              bytes: identityBytes.length,
              etag: identity.headers.get("etag"),
            },
            brotli: {
              status: brotli.status,
              bytes: brotliBytes.length,
              etag: brotli.headers.get("etag"),
              identityDigest: brotliDigest,
            },
            gzip: {
              status: gzip.status,
              encoding: gzip.headers.get("content-encoding"),
              identityDigest: gzipDigest,
            },
            quality: quality.headers.get("content-encoding"),
            notModified: compressedNotModified.status,
            head: head.status,
            identityRange: identityRange.status,
            compressedRange: compressedRange.status,
            emittedAsset: emittedAssetEvidence,
          },
          null,
          2,
        ),
      );
    }
    for (const path of [
      "/_assets/missing.js",
      "/server/entry.js",
      "/%2e%2e%2fserver/entry.js",
      "/not-found",
    ])
      expect((await fetch(root + path)).status).toBe(404);
    if (manifest.basePath)
      for (const path of ["/", manifest.basePath + "-other", "/plain.txt"])
        expect((await fetch(new URL(path, server.url))).status).toBe(404);
    const secondRoute = manifest.routing.routes.find(
      (route) => route.id === "/second",
    )!;
    const secondModule = manifest.client.nodes[String(secondRoute.leaf)].page!;
    await page.goto(root + "/");
    await page.waitForFunction(
      () => document.documentElement.dataset.hydrated === "true",
    );
    expect(
      await page.getByRole("button", { name: "First: 0", exact: true }).count(),
    ).toBe(1);
    await page.getByRole("button", { name: "First: 0", exact: true }).click();
    expect(
      await page
        .getByRole("button", {
          name: `${options.incrementedLabel ?? "First"}: 1`,
          exact: true,
        })
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator("#app button")
        .evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(1, 2, 3)");
    expect(
      await page
        .locator(".frame")
        .evaluate((element) => getComputedStyle(element).borderTopWidth),
    ).toBe("7px");
    expect(
      await page
        .getByAltText("Logo")
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBe(8);
    const logo = await page.getByAltText("Logo").getAttribute("src");
    expect(logo).toMatch(
      new RegExp(`^${manifest.basePath}/_assets/assets/logo-`),
    );
    expect(html).toContain(`src="${logo}"`);
    const backgroundUrl = await page
      .locator(".background")
      .evaluate((element) => {
        const value = getComputedStyle(element).backgroundImage;
        const match = value.match(/^url\(["']?(.*?)["']?\)$/);
        if (!match) throw new Error(`missing background image URL: ${value}`);
        return new URL(match[1], document.baseURI).href;
      });
    const backgroundWidth = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image.naturalWidth;
    }, backgroundUrl);
    expect(backgroundWidth).toBe(8);
    expect(
      requests.some((url) => new URL(url).pathname === secondModule.url),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Load second module", exact: true })
      .click();
    await page.waitForFunction(
      () => document.documentElement.dataset.secondLoaded === "true",
    );
    expect(
      requests.some((url) => new URL(url).pathname === secondModule.url),
    ).toBe(true);
    await page.goto(root + "/second");
    await page.waitForFunction(
      () => document.documentElement.dataset.hydrated === "true",
    );
    await page.getByRole("button", { name: "Second: 0", exact: true }).click();
    expect(
      await page
        .getByRole("button", { name: "Second: 1", exact: true })
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator("#app button")
        .evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(4, 5, 6)");
    expect(errors).toEqual([]);
    await Bun.write(
      join(packed.evidenceDirectory, "browser.json"),
      JSON.stringify(
        {
          basePath: manifest.basePath,
          requests,
          errors,
          hydrationRecovery: false,
          firstRequest: 200,
          secondModule: secondModule.url,
          logo,
          background: backgroundUrl,
          backgroundWidth,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.stop();
      } finally {
        await packed.cleanup();
      }
    }
  }
}
