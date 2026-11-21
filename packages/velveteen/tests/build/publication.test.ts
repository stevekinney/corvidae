import {
  rejectionOf,
  throwingRejectionOf,
} from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  publishProductionGeneration,
  readProductionGeneration,
} from "../../src/build/publication.ts";
import type { ProductionManifest } from "../../src/build/manifest-types.ts";

const routing = { version: 1 as const, nodes: [], routes: [] };

const createManifest = (content: string): ProductionManifest => {
  const bytes = new TextEncoder().encode(content);
  const serverContent = "export default {};\n";
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const serverSha256 = new Bun.CryptoHasher("sha256")
    .update(serverContent)
    .digest("hex");
  return {
    version: 1,
    basePath: "/app",
    routing,
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
        bytes: bytes.byteLength,
        sha256,
        url: "/app/_assets/app.js",
        contentType: "text/javascript; charset=utf-8",
        immutable: true,
      },
    ],
    outputs: [
      {
        file: "browser/app.js",
        target: "browser",
        bytes: bytes.byteLength,
        sha256,
      },
      {
        file: "server/server.js",
        target: "server",
        bytes: serverContent.length,
        sha256: serverSha256,
      },
    ],
  };
};

const createStage = async (
  root: string,
  content: string,
  manifest: ProductionManifest,
) => {
  const stage = await mkdtemp(join(root, "stage-"));
  await mkdir(join(stage, "browser"), { recursive: true });
  await mkdir(join(stage, "server"), { recursive: true });
  await Bun.write(join(stage, "browser/app.js"), content);
  await Bun.write(join(stage, "server/server.js"), "export default {};\n");
  await Bun.write(join(stage, "manifest.json"), JSON.stringify(manifest));
  return stage;
};

test("D05: publication switches whole generations and preserves old snapshots", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/publication-"),
  );
  const outputDirectory = join(root, "output");
  try {
    const firstManifest = createManifest("first");
    const firstStage = await createStage(root, "first", firstManifest);
    const first = await publishProductionGeneration({
      stagingDirectory: firstStage,
      outputDirectory,
      manifest: firstManifest,
    });
    expect((await readProductionGeneration(outputDirectory)).directory).toBe(
      first.directory,
    );
    expect(
      await readFile(join(first.directory, "browser/app.js"), "utf8"),
    ).toBe("first");

    const secondManifest = createManifest("second");
    const secondStage = await createStage(root, "second", secondManifest);
    const second = await publishProductionGeneration({
      stagingDirectory: secondStage,
      outputDirectory,
      manifest: secondManifest,
    });
    expect(second.directory).not.toBe(first.directory);
    expect((await readProductionGeneration(outputDirectory)).directory).toBe(
      second.directory,
    );
    expect(
      await readFile(join(first.directory, "browser/app.js"), "utf8"),
    ).toBe("first");
    expect(
      await readFile(join(second.directory, "browser/app.js"), "utf8"),
    ).toBe("second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D05: invalid stages are rejected before pointer switch and cleaned", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/publication-invalid-"),
  );
  const outputDirectory = join(root, "output");
  try {
    const manifest = createManifest("good");
    const goodStage = await createStage(root, "good", manifest);
    await publishProductionGeneration({
      stagingDirectory: goodStage,
      outputDirectory,
      manifest,
    });
    const previous = await readProductionGeneration(outputDirectory);

    const badManifest = createManifest("bad");
    const badStage = await createStage(root, "bad", badManifest);
    await Bun.write(join(badStage, "browser/app.js"), "corrupt");
    expect(
      await throwingRejectionOf(
        publishProductionGeneration({
          stagingDirectory: badStage,
          outputDirectory,
          manifest: badManifest,
        }),
      ),
    ).toThrow("does not match manifest");
    expect((await readProductionGeneration(outputDirectory)).directory).toBe(
      previous.directory,
    );
    expect(await rejectionOf(lstat(badStage))).toMatchObject({
      code: "ENOENT",
    });

    const escapeManifest = createManifest("escape");
    escapeManifest.outputs[0].file = "../escape.js";
    const escapeStage = await createStage(root, "escape", escapeManifest);
    expect(
      await throwingRejectionOf(
        publishProductionGeneration({
          stagingDirectory: escapeStage,
          outputDirectory,
          manifest: escapeManifest,
        }),
      ),
    ).toThrow("safe relative path");
    expect(await rejectionOf(lstat(escapeStage))).toMatchObject({
      code: "ENOENT",
    });

    const malformedManifest = createManifest("malformed-url");
    malformedManifest.client.url = "/app/app.js";
    malformedManifest.assets[0].url = "/app/app.js";
    const malformedStage = await createStage(
      root,
      "malformed-url",
      malformedManifest,
    );
    expect(
      await throwingRejectionOf(
        publishProductionGeneration({
          stagingDirectory: malformedStage,
          outputDirectory,
          manifest: malformedManifest,
        }),
      ),
    ).toThrow("asset URL is not canonical");
    expect((await readProductionGeneration(outputDirectory)).directory).toBe(
      previous.directory,
    );
    expect(await rejectionOf(lstat(malformedStage))).toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D05: reserved static namespace is rejected before publication", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/publication-static-collision-"),
  );
  const outputDirectory = join(root, "output");
  try {
    const previousManifest = createManifest("previous");
    const previousStage = await createStage(root, "previous", previousManifest);
    const previous = await publishProductionGeneration({
      stagingDirectory: previousStage,
      outputDirectory,
      manifest: previousManifest,
    });
    const manifest = createManifest("collision");
    const body = "static collision\n";
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    manifest.outputs.push({
      file: "static/_assets/collision.txt",
      target: "static",
      bytes: body.length,
      sha256: hash,
    });
    manifest.assets.push({
      file: "static/_assets/collision.txt",
      target: "static",
      bytes: body.length,
      sha256: hash,
      url: "/app/_assets/collision.txt",
      contentType: "text/plain; charset=utf-8",
      immutable: false,
    });
    const stage = await createStage(root, "collision", manifest);
    await mkdir(join(stage, "static", "_assets"), { recursive: true });
    await Bun.write(join(stage, "static/_assets/collision.txt"), body);
    expect(
      await throwingRejectionOf(
        publishProductionGeneration({
          stagingDirectory: stage,
          outputDirectory,
          manifest,
        }),
      ),
    ).toThrow("_assets namespace");
    expect((await readProductionGeneration(outputDirectory)).directory).toBe(
      previous.directory,
    );
    expect(await rejectionOf(lstat(stage))).toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D05: symlink stages are rejected without deleting their target", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/publication-symlink-"),
  );
  try {
    const manifest = createManifest("symlink");
    const target = await createStage(root, "symlink", manifest);
    const alias = join(root, "stage-alias");
    await symlink(target, alias, "dir");
    expect(
      await throwingRejectionOf(
        publishProductionGeneration({
          stagingDirectory: alias,
          outputDirectory: join(root, "output"),
          manifest,
        }),
      ),
    ).toThrow("must not be a symlink");
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect((await lstat(join(target, "manifest.json"))).isFile()).toBe(true);
    await rm(alias, { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D05: pointer publication failure preserves unrelated metadata", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/publication-pointer-"),
  );
  const outputDirectory = join(root, "output");
  try {
    await mkdir(outputDirectory, { recursive: true });
    const pointerDirectory = join(outputDirectory, "current.json");
    await mkdir(pointerDirectory);
    await Bun.write(join(pointerDirectory, "unrelated.txt"), "keep me");
    const manifest = createManifest("blocked");
    const stage = await createStage(root, "blocked", manifest);
    expect(
      await throwingRejectionOf(
        publishProductionGeneration({
          stagingDirectory: stage,
          outputDirectory,
          manifest,
        }),
      ),
    ).toThrow("current production pointer");
    expect(
      await readFile(join(pointerDirectory, "unrelated.txt"), "utf8"),
    ).toBe("keep me");
    expect(await rejectionOf(lstat(stage))).toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D05: concurrent publications leave one valid complete pointer", async () => {
  const root = await mkdtemp(
    join(process.cwd(), ".velveteen/build/publication-concurrent-"),
  );
  const outputDirectory = join(root, "output");
  try {
    const manifests = ["a", "b", "c", "d"].map(createManifest);
    const stages = await Promise.all(
      manifests.map((manifest, index) =>
        createStage(root, String.fromCharCode(97 + index), manifest),
      ),
    );
    const results = await Promise.all(
      stages.map((stagingDirectory, index) =>
        publishProductionGeneration({
          stagingDirectory,
          outputDirectory,
          manifest: manifests[index],
        }),
      ),
    );
    const current = await readProductionGeneration(outputDirectory);
    expect(results.map((result) => result.directory)).toContain(
      current.directory,
    );
    expect(
      (await lstat(join(current.directory, "browser/app.js"))).isFile(),
    ).toBe(true);
    expect(
      await readFile(join(current.directory, "manifest.json"), "utf8"),
    ).toContain('"version":1');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
