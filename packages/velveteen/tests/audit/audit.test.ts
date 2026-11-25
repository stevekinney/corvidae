import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditBuildEvidence,
  auditCommands,
  auditDependencyClosure,
  auditPackageFiles,
} from "./audit-core.ts";

test("P03 rejects a forbidden alias in a nested transitive installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "velveteen-audit-"));
  try {
    const parent = join(root, "node_modules/allowed");
    const nested = join(parent, "node_modules/innocent-alias");
    await mkdir(nested, { recursive: true });
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { allowed: "1.0.0" } }),
    );
    await Bun.write(
      join(parent, "package.json"),
      JSON.stringify({
        name: "allowed",
        version: "1.0.0",
        dependencies: { "innocent-alias": "npm:vite@8.3.3" },
      }),
    );
    await Bun.write(
      join(nested, "package.json"),
      JSON.stringify({ name: "vite", version: "8.3.3" }),
    );
    expect(await throwingRejectionOf(auditDependencyClosure(root))).toThrow(
      "forbidden dependency: vite",
    );
    await Bun.write(
      join(nested, "package.json"),
      JSON.stringify({ name: "innocent-alias", version: "1.0.0" }),
    );
    expect((await auditDependencyClosure(root)).identities).toEqual([
      "allowed@1.0.0",
      "innocent-alias@1.0.0",
    ]);
    await rm(nested, { recursive: true });
    expect(await throwingRejectionOf(auditDependencyClosure(root))).toThrow(
      "unresolved dependency edge",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P03 only admits an optional forbidden peer while it is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "velveteen-optional-peer-"));
  try {
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        dependencies: { provider: "1.0.0" },
      }),
    );
    await Bun.write(
      join(root, "node_modules/provider/package.json"),
      JSON.stringify({
        name: "provider",
        version: "1.0.0",
        peerDependencies: { vite: "*" },
        peerDependenciesMeta: { vite: { optional: true } },
      }),
    );
    expect((await auditDependencyClosure(root)).identities).toEqual([
      "provider@1.0.0",
    ]);
    await Bun.write(
      join(root, "node_modules/vite/package.json"),
      JSON.stringify({
        name: "vite",
        version: "8.3.3",
      }),
    );
    expect(await throwingRejectionOf(auditDependencyClosure(root))).toThrow(
      "forbidden dependency edge: provider -> vite",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P03 recorded commands require completed execution evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "velveteen-command-audit-"));
  try {
    const entry = join(root, "fixture.ts");
    const stdout = join(root, "stdout.log");
    const stderr = join(root, "stderr.log");
    const artifact = join(root, "artifact.json");
    await Bun.write(entry, "export {};\n");
    await Bun.write(
      stdout,
      JSON.stringify({
        pid: 123,
        bun: Bun.version,
        url: "http://127.0.0.1:1/",
      }) + "\n",
    );
    await Bun.write(stderr, "");
    await Bun.write(artifact, "{}");
    const evidence = async (path: string) => ({
      path,
      sha256: new Bun.CryptoHasher("sha256")
        .update(await Bun.file(path).arrayBuffer())
        .digest("hex"),
    });
    const files = {
      entry: await evidence(entry),
      stdout: await evidence(stdout),
      stderr: await evidence(stderr),
      artifact: await evidence(artifact),
    };
    const commands = ["development", "production"].map((mode) => ({
      boundary: "candidate",
      mode,
      cwd: root,
      command: [process.execPath, entry],
      pid: 123,
      bun: Bun.version,
      status: "completed",
      exitCode: 0,
      startedAt: "2026-11-17T00:00:00Z",
      finishedAt: "2026-11-17T00:00:01Z",
      ...files,
    }));
    await auditCommands(commands, root);
    const shell = Bun.which("sh");
    if (!shell) throw new Error("A shell is required for the non-Bun control");
    expect(
      await throwingRejectionOf(
        auditCommands(
          [{ ...commands[0], command: [shell, entry] }, commands[1]],
          root,
        ),
      ),
    ).toThrow("must use Bun");
    expect(
      await throwingRejectionOf(
        auditCommands(
          [{ ...commands[0], status: "prepared" }, commands[1]],
          root,
        ),
      ),
    ).toThrow("completed execution");
    expect(
      await throwingRejectionOf(
        auditCommands([{ ...commands[0], exitCode: 1 }, commands[1]], root),
      ),
    ).toThrow("completed execution");
    expect(
      await throwingRejectionOf(
        auditCommands(
          [{ ...commands[0], finishedAt: "invalid" }, commands[1]],
          root,
        ),
      ),
    ).toThrow("timestamps are invalid");
    expect(
      await throwingRejectionOf(
        auditCommands(
          [{ ...commands[0], stdout: undefined }, commands[1]],
          root,
        ),
      ),
    ).toThrow("file evidence");
    expect(await throwingRejectionOf(auditCommands([], root))).toThrow(
      "both execution modes",
    );
    expect(
      await throwingRejectionOf(
        auditCommands(
          [{ boundary: "reference", command: ["node", "vite.js"] }],
          root,
        ),
      ),
    ).toThrow("both execution modes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P03 package contents reject reference tooling and omitted product sources", () => {
  expect(() =>
    auditPackageFiles([
      "package/package.json",
      "package/src/compiler/index.ts",
    ]),
  ).not.toThrow();
  expect(() =>
    auditPackageFiles([
      "package/src/compiler/index.ts",
      "package/tests/reference/package.json",
    ]),
  ).toThrow("unexpected package content");
  expect(() => auditPackageFiles(["package/package.json"])).toThrow(
    "no framework source",
  );
});

test("P03 build provenance rejects forbidden inputs and changed output bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "velveteen-build-audit-"));
  try {
    const output = join(root, "output.js");
    await Bun.write(output, "export const value = 1;");
    const sha256 = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(output).arrayBuffer())
      .digest("hex");
    await mkdir(join(root, "src"));
    await Bun.write(join(root, "src/entry.ts"), "export const value = 1;");
    const build = {
      inputRoot: root,
      outputDirectory: root,
      metafile: {
        inputs: { "src/entry.ts": { imports: [] } },
        outputs: { "output.js": {} },
      },
      outputs: [{ path: output, sha256 }],
    };
    const evidence = {
      schemaVersion: 1,
      root,
      builds: [
        { ...build, target: "browser" },
        { ...build, target: "bun" },
      ],
    };
    await auditBuildEvidence(evidence);
    await Bun.write(join(root, "src/Page.svelte"), "<h1>Style provenance</h1>");
    const virtualStyles = {
      ...evidence,
      builds: [
        {
          ...build,
          target: "browser",
          metafile: {
            ...build.metafile,
            inputs: { "src/Page.svelte.velveteen.css": { imports: [] } },
          },
        },
        evidence.builds[1],
      ],
    };
    await auditBuildEvidence(virtualStyles);
    expect(
      await throwingRejectionOf(
        auditBuildEvidence({
          ...virtualStyles,
          builds: [
            {
              ...virtualStyles.builds[0],
              metafile: {
                ...build.metafile,
                inputs: { "src/Missing.svelte.velveteen.css": { imports: [] } },
              },
            },
            evidence.builds[1],
          ],
        }),
      ),
    ).toThrow();
    const invalid = {
      ...evidence,
      builds: [
        {
          ...build,
          target: "browser",
          metafile: { inputs: { "node_modules/@vitest/runner/index.js": {} } },
        },
        evidence.builds[1],
      ],
    };
    expect(await throwingRejectionOf(auditBuildEvidence(invalid))).toThrow(
      "forbidden emitted input",
    );
    const foreign = join(root, "unrelated.js");
    await Bun.write(foreign, "export const value = 1;");
    expect(
      await throwingRejectionOf(
        auditBuildEvidence({
          ...evidence,
          builds: [
            {
              ...build,
              target: "browser",
              outputs: [{ path: foreign, sha256 }],
            },
            evidence.builds[1],
          ],
        }),
      ),
    ).toThrow("absent from metafile");
    expect(
      await throwingRejectionOf(
        auditBuildEvidence({
          ...evidence,
          builds: [
            {
              ...build,
              target: "browser",
              metafile: {
                ...build.metafile,
                inputs: { [import.meta.path]: {} },
              },
            },
            evidence.builds[1],
          ],
        }),
      ),
    ).toThrow("input escapes root");
    await Bun.write(output, "export const value = 2;");
    expect(await throwingRejectionOf(auditBuildEvidence(evidence))).toThrow(
      "output bytes changed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
