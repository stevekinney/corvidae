import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const evidence = join(root, ".velveteen/evidence");
await mkdir(evidence, { recursive: true });
await Bun.write(join(evidence, "commands.jsonl"), "");
async function execute(
  name: string,
  arguments_: string[] = [],
  environment: Record<string, string> = {},
) {
  const child = await runWithHangGuard(
    [process.execPath, "tests/conformance/harness.ts", ...arguments_],
    {
      cwd: root,
      env: { ...process.env, ...environment },
    },
  );
  const output = child.stdout.toString() + child.stderr.toString();
  return { name, exitCode: child.exitCode, output };
}
const baseline = await execute("baseline");
await Bun.write(join(evidence, "harness-baseline.log"), baseline.output);
if (baseline.exitCode !== 0)
  throw new Error(`baseline harness failed:\n${baseline.output}`);
const wrong = await execute(
  "wrong-endpoint",
  ["--target", "candidate", "--mode", "production"],
  { VELVETEEN_ENDPOINT_STATUS: "wrong" },
);
if (
  wrong.exitCode === 0 ||
  !wrong.output.includes('endpoint expected {"status":"ok"}')
)
  throw new Error(
    `wrong-endpoint control failed for the wrong reason:\n${wrong.output}`,
  );
const empty = await execute("empty-selection", ["--case", "unknown"]);
if (empty.exitCode === 0 || !empty.output.includes("no selected tests"))
  throw new Error(
    `empty selection control failed for the wrong reason:\n${empty.output}`,
  );
const restored = await execute("restored");
await Bun.write(join(evidence, "harness-restored.log"), restored.output);
if (restored.exitCode !== 0)
  throw new Error(`restored harness failed:\n${restored.output}`);
await Bun.write(
  join(evidence, "harness-controls.json"),
  JSON.stringify([baseline, wrong, empty, restored], null, 2),
);
console.log(
  "P02/P03 passed: real four-cell baseline, causal wrong-endpoint and empty-selection rejection, restored four-cell baseline",
);
