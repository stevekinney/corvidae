import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  auditBuildEvidence,
  auditCommands,
  auditDependencyClosure,
  auditLockfile,
  auditPackageFiles,
} from "./audit-core.ts";

const root = resolve(import.meta.dir, "../..");
const evidence = join(root, ".velveteen/evidence");
const lockfileRoot = resolve(root, "../..");
const { identities, packageDirectories } = await auditDependencyClosure(
  root,
  lockfileRoot,
);
await auditLockfile(root, identities, lockfileRoot);
await auditBuildEvidence(
  await Bun.file(join(evidence, "candidate-build.json")).json(),
  packageDirectories,
);
const commands: unknown[] = (
  await Bun.file(join(evidence, "commands.jsonl")).text()
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
await auditCommands(commands);
await mkdir(evidence, { recursive: true });
const filename = join(evidence, "velveteen-package.tgz");
const packed = await runWithHangGuard(
  [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", filename],
  { cwd: root },
);
if (packed.exitCode !== 0)
  throw new Error(`package creation failed:\n${packed.stderr.toString()}`);
const files = await new Bun.Archive(
  await Bun.file(filename).arrayBuffer(),
).files();
auditPackageFiles(files.keys());
await Bun.write(
  join(evidence, "dependency-audit.json"),
  JSON.stringify(
    {
      bun: Bun.version,
      installed: identities,
      package: filename,
      files: [...files.keys()],
      commandCount: commands.length,
    },
    null,
    2,
  ),
);
console.log(
  `Dependency audit passed: ${identities.length} installed identities, actual candidate build inputs/outputs, ${commands.length} recorded commands, ${files.size} package entries`,
);
