import { throwingRejectionOf } from "@lostgradient/testing/promise-outcome";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditProductionArtifact } from "./production-artifact.ts";

const evidenceRoots = [
  join(process.cwd(), ".velveteen/evidence/d07-root"),
  join(process.cwd(), ".velveteen/evidence/d07-base"),
];

async function copyEvidence(source: string) {
  const target = await mkdtemp(join(tmpdir(), "velveteen-artifact-audit-"));
  for (const file of [
    "artifact.json",
    "process.json",
    "browser.json",
    "stdout.log",
    "stderr.log",
  ]) {
    const path = join(source, file);
    await Bun.write(join(target, file), await Bun.file(path).arrayBuffer());
  }
  const artifact = JSON.parse(
    await Bun.file(join(target, "artifact.json")).text(),
  ) as { archive: string };
  const archive = join(target, "production.tar.gz");
  await Bun.write(archive, await Bun.file(artifact.archive).arrayBuffer());
  artifact.archive = archive;
  await Bun.write(
    join(target, "artifact.json"),
    JSON.stringify(artifact, null, 2),
  );
  return target;
}

test("D07 audits both actual production artifact evidence sets", async () => {
  for (const root of evidenceRoots) {
    expect(await Bun.file(join(root, "artifact.json")).exists()).toBe(true);
    const result = await auditProductionArtifact(root);
    expect(result.outputs).toBeGreaterThan(0);
    expect(result.files).toBeGreaterThan(result.outputs);
  }
});

test("D07 rejects archive and process integrity failures", async () => {
  const source = evidenceRoots[0];
  const root = await copyEvidence(source);
  try {
    const artifactPath = join(root, "artifact.json");
    const artifact = JSON.parse(await Bun.file(artifactPath).text());
    const originalArchiveBytes = await Bun.file(artifact.archive).arrayBuffer();
    await Bun.write(artifact.archive, new Uint8Array([1, 2, 3]));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "archive hash changed",
    );
    await Bun.write(artifact.archive, originalArchiveBytes);
    const archiveFiles = await new Bun.Archive(
      await Bun.file(artifact.archive).arrayBuffer(),
    ).files();
    const pointer = JSON.parse(
      await archiveFiles.get("application/current.json")!.text(),
    );
    const manifestName = `application/generations/${pointer.generation}/manifest.json`;
    const replacementFiles = Object.fromEntries(archiveFiles);
    const archivedManifest = JSON.parse(
      await archiveFiles.get(manifestName)!.text(),
    );
    const removed = archivedManifest.outputs[0].file;
    delete replacementFiles[
      `${manifestName.slice(0, -"manifest.json".length)}${removed}`
    ];
    await Bun.Archive.write(artifact.archive, replacementFiles, {
      compress: "gzip",
    });
    artifact.files = artifact.files.filter(
      (entry: { file: string }) =>
        entry.file !==
        `${manifestName.slice(0, -"manifest.json".length)}${removed}`,
    );
    artifact.archiveSha256 = createHash("sha256")
      .update(Buffer.from(await Bun.file(artifact.archive).arrayBuffer()))
      .digest("hex");
    await Bun.write(artifactPath, JSON.stringify(artifact));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "manifest output missing from archive",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D07 rejects forbidden browser content and non-Bun completion evidence", async () => {
  const source = evidenceRoots[0];
  const root = await copyEvidence(source);
  try {
    const artifactPath = join(root, "artifact.json");
    const artifact = JSON.parse(await Bun.file(artifactPath).text());
    artifact.metadata.browser.inputs["tests/reference/forbidden.js"] = {};
    await Bun.write(artifactPath, JSON.stringify(artifact));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "forbidden browser runtime input",
    );
    const clean = JSON.parse(await Bun.file(artifactPath).text());
    delete clean.metadata.browser.inputs["tests/reference/forbidden.js"];
    await Bun.write(artifactPath, JSON.stringify(clean));
    const processPath = join(root, "process.json");
    const process = JSON.parse(await Bun.file(processPath).text());
    process.command[0] = "node";
    await Bun.write(processPath, JSON.stringify(process));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "must use Bun",
    );
    process.command[0] = JSON.parse(
      await Bun.file(join(source, "process.json")).text(),
    ).command[0];
    process.status = "prepared";
    await Bun.write(processPath, JSON.stringify(process));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "did not complete",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D07 rejects synchronized private browser sentinel bytes", async () => {
  const root = await copyEvidence(evidenceRoots[0]);
  try {
    const artifactPath = join(root, "artifact.json");
    const artifact = JSON.parse(await Bun.file(artifactPath).text());
    const archiveFiles = await new Bun.Archive(
      await Bun.file(artifact.archive).arrayBuffer(),
    ).files();
    const browserName = [...archiveFiles.keys()].find((name) =>
      name.includes("/browser/entries/"),
    )!;
    const original = new Uint8Array(
      await archiveFiles.get(browserName)!.arrayBuffer(),
    );
    const sentinel = new TextEncoder().encode("PRIVATE_BROWSER_SENTINEL");
    const changed = new Uint8Array(original.length + sentinel.length);
    changed.set(original);
    changed.set(sentinel, original.length);
    const replacementFiles = Object.fromEntries(archiveFiles);
    replacementFiles[browserName] = new File([changed], browserName);
    const changedDigest = createHash("sha256").update(changed).digest("hex");
    const relativeName = browserName.replace(
      /^application\/generations\/[^/]+\//,
      "",
    );
    const fileRecord = artifact.files.find(
      (entry: { file: string }) => entry.file === browserName,
    )!;
    fileRecord.bytes = changed.length;
    fileRecord.sha256 = changedDigest;
    const pointer = JSON.parse(
      await archiveFiles.get("application/current.json")!.text(),
    );
    const manifestName = `application/generations/${pointer.generation}/manifest.json`;
    const manifest = JSON.parse(await archiveFiles.get(manifestName)!.text());
    const output = manifest.outputs.find(
      (entry: { file: string }) => entry.file === relativeName,
    )!;
    output.bytes = changed.length;
    output.sha256 = changedDigest;
    const artifactOutput = artifact.manifest.outputs.find(
      (entry: { file: string }) => entry.file === relativeName,
    );
    artifactOutput.bytes = changed.length;
    artifactOutput.sha256 = changedDigest;
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    replacementFiles[manifestName] = new File([manifestBytes], manifestName);
    const manifestRecord = artifact.files.find(
      (entry: { file: string }) => entry.file === manifestName,
    )!;
    manifestRecord.bytes = manifestBytes.length;
    manifestRecord.sha256 = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    await Bun.Archive.write(artifact.archive, replacementFiles, {
      compress: "gzip",
    });
    artifact.archiveSha256 = createHash("sha256")
      .update(Buffer.from(await Bun.file(artifact.archive).arrayBuffer()))
      .digest("hex");
    await Bun.write(artifactPath, JSON.stringify(artifact));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "private/development browser content",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D07 rejects missing evidence and path-segment dependency leaks", async () => {
  const root = await copyEvidence(evidenceRoots[0]);
  try {
    const artifactPath = join(root, "artifact.json");
    const original = await Bun.file(artifactPath).text();
    const restoredSource = join(root, "restored-source");
    await mkdir(restoredSource);
    const presentSource = JSON.parse(original);
    presentSource.sourceDirectory = restoredSource;
    await Bun.write(artifactPath, JSON.stringify(presentSource));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "application source still exists",
    );
    const nestedRuntime = JSON.parse(original);
    nestedRuntime.runtimeDirectory = join(
      nestedRuntime.sourceDirectory,
      "runtime",
    );
    await Bun.write(artifactPath, JSON.stringify(nestedRuntime));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "runtime must be outside",
    );
    for (const input of [
      "node_modules/vite/dist/index.js",
      "node_modules/@vitest/runner/index.js",
      "node_modules/typescript/lib/typescript.js",
      "src/compiler/index.ts",
      "node_modules/svelte/src/compiler/index.js",
    ]) {
      const artifact = JSON.parse(original);
      artifact.metadata.browser.inputs[input] = { imports: [] };
      await Bun.write(artifactPath, JSON.stringify(artifact));
      expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
        "forbidden browser runtime input",
      );
    }
    const allowed = JSON.parse(original);
    allowed.metadata.browser.inputs["application/preferences.ts"] = {
      imports: [],
    };
    await Bun.write(artifactPath, JSON.stringify(allowed));
    await auditProductionArtifact(root);
    await Bun.write(artifactPath, original);
    const processPath = join(root, "process.json");
    const processEvidence = await Bun.file(processPath).json();
    delete processEvidence.pathEntries;
    await Bun.write(processPath, JSON.stringify(processEvidence));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "PATH entries are missing",
    );
    await Bun.write(
      processPath,
      await Bun.file(join(evidenceRoots[0], "process.json")).text(),
    );
    const fakeExecutable = join(root, "bun");
    await Bun.write(fakeExecutable, "fake executable identity");
    const fakeProcess = await Bun.file(processPath).json();
    fakeProcess.command[0] = fakeExecutable;
    await Bun.write(processPath, JSON.stringify(fakeProcess));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "executable is not Bun",
    );
    await Bun.write(
      processPath,
      await Bun.file(join(evidenceRoots[0], "process.json")).text(),
    );

    const browserPath = join(root, "browser.json");
    const browser = await Bun.file(browserPath).json();
    delete browser.hydrationRecovery;
    await Bun.write(browserPath, JSON.stringify(browser));
    expect(await throwingRejectionOf(auditProductionArtifact(root))).toThrow(
      "hydration recovery",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
