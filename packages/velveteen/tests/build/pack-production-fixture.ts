import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import { writeProductionFixture } from "./production-fixture.ts";

/** Build and archive the actual generation; the extracted runtime contains no source or dependencies. */
export async function packProductionFixture(
  basePath: string,
  name: string,
  options: {
    compression?: boolean;
    browserPlugins?: readonly Bun.BunPlugin[];
  } = {},
) {
  const buildRoot = join(process.cwd(), ".velveteen/build");
  const evidenceDirectory = join(process.cwd(), ".velveteen/evidence", name);
  await mkdir(buildRoot, { recursive: true });
  await mkdir(evidenceDirectory, { recursive: true });
  const project = await mkdtemp(join(buildRoot, "production-source-"));
  const runtime = await mkdtemp(join(tmpdir(), "velveteen-production-"));
  try {
    const source = await writeProductionFixture(project);
    const outputDirectory = join(project, "output");
    const generation = await buildProduction({
      projectDirectory: project,
      ...source,
      outputDirectory,
      basePath,
      ...(options.browserPlugins === undefined
        ? {}
        : { browserPlugins: options.browserPlugins }),
    });
    const host = await Bun.build({
      entrypoints: [join(import.meta.dir, "fixture-host.ts")],
      target: "bun",
      minify: true,
      env: "disable",
      sourcemap: "none",
      metafile: true,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
    });
    if (!host.success || host.logs.length || host.outputs.length !== 1)
      throw new AggregateError(host.logs, "Fixture host bundle failed");
    const pointer = await Bun.file(
      join(outputDirectory, "current.json"),
    ).text();
    const generationName = JSON.parse(pointer).generation as string;
    const files: Record<string, Blob> = {
      "host.js": host.outputs[0],
      "application/current.json": new Blob([pointer]),
      [`application/generations/${generationName}/manifest.json`]: new Blob([
        await Bun.file(
          join(generation.directory, "manifest.json"),
        ).arrayBuffer(),
      ]),
    };
    for (const output of generation.manifest.outputs)
      files[`application/generations/${generationName}/${output.file}`] =
        new Blob([
          await Bun.file(join(generation.directory, output.file)).arrayBuffer(),
        ]);
    const archive = join(evidenceDirectory, "production.tar.gz");
    await Bun.Archive.write(archive, files, { compress: "gzip" });
    const unpacked = new Bun.Archive(await Bun.file(archive).arrayBuffer());
    await unpacked.extract(runtime);
    const metadata = (await Bun.file(
      join(generation.directory, "build-metadata.json"),
    ).json()) as { browser: Bun.BuildMetafile; server: Bun.BuildMetafile };
    const archiveFiles = await unpacked.files();
    const fileIdentities = await Promise.all(
      [...archiveFiles].map(async ([file, blob]) => ({
        file,
        bytes: blob.size,
        sha256: new Bun.CryptoHasher("sha256")
          .update(await blob.arrayBuffer())
          .digest("hex"),
      })),
    );
    // Removing the owned source is part of the clean-start gate, before the first runtime process starts.
    await rm(project, { recursive: true, force: true });
    const evidence = {
      bun: Bun.version,
      basePath: generation.manifest.basePath,
      sourceDirectory: project,
      runtimeDirectory: runtime,
      archive,
      archiveSha256: new Bun.CryptoHasher("sha256")
        .update(await Bun.file(archive).arrayBuffer())
        .digest("hex"),
      files: fileIdentities,
      manifest: generation.manifest,
      metadata: { ...metadata, host: host.metafile },
      hostOutput: basename(host.outputs[0].path),
      sourceRemoved: true,
    };
    await Bun.write(
      join(evidenceDirectory, "artifact.json"),
      JSON.stringify(evidence, null, 2),
    );
    return {
      runtime,
      evidenceDirectory,
      evidence,
      compression: options.compression === true,
      async cleanup() {
        await rm(runtime, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(project, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
    throw error;
  }
}
