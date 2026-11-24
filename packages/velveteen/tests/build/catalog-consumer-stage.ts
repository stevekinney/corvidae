import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Materialize the workspace source packages as archives for an unrelated consumer. */
export async function stageCatalogPackages(
  repository: string,
  directory: string,
) {
  const workspaceRoot = resolve(repository, "../..");
  const rootManifest = JSON.parse(
    await readFile(join(workspaceRoot, "package.json"), "utf8"),
  ) as {
    catalog: Record<string, string>;
  };
  const archives = new Map<string, string>();
  for (const name of [
    "storage",
    "credentials",
    "backchannel",
    "backchannel-svelte",
  ]) {
    const source = join(workspaceRoot, "packages", name);
    const stage = join(directory, `stage-${name}`);
    const manifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    ) as {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      [key: string]: unknown;
    };
    await mkdir(stage, { recursive: true });
    await cp(join(source, "src"), join(stage, "src"), { recursive: true });
    if (name === "backchannel")
      await cp(join(source, "scripts"), join(stage, "scripts"), {
        recursive: true,
      });
    for (const dependencies of [
      manifest.dependencies,
      manifest.peerDependencies,
    ]) {
      for (const [dependency, version] of Object.entries(dependencies ?? {})) {
        if (version === "workspace:*") {
          const archive = archives.get(dependency);
          if (!archive)
            throw new Error(`Missing staged dependency ${dependency}`);
          dependencies![dependency] = `file:${archive}`;
        } else if (version === "catalog:") {
          const resolved = rootManifest.catalog[dependency];
          if (!resolved)
            throw new Error(`Missing catalog version for ${dependency}`);
          dependencies![dependency] = resolved;
        }
      }
    }
    delete manifest.devDependencies;
    delete manifest.scripts;
    manifest.version = "0.0.0";
    await writeFile(join(stage, "package.json"), JSON.stringify(manifest));
    const archive = join(directory, `${name}.tgz`);
    const packed = Bun.spawnSync(
      [
        process.execPath,
        "pm",
        "pack",
        "--ignore-scripts",
        "--filename",
        archive,
      ],
      { cwd: stage, stdout: "pipe", stderr: "pipe" },
    );
    if (packed.exitCode !== 0)
      throw new Error(`Packing ${name}: ${packed.stderr.toString()}`);
    archives.set(manifest.name, archive);
  }
  return Object.fromEntries(archives);
}
