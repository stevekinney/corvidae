import { runWithHangGuard } from "@lostgradient/testing/hang-guard";
const positive = await runWithHangGuard([
  process.execPath,
  "node_modules/svelte-check/bin/svelte-check",
  "--config",
  "svelte-check.config.ts",
  "--tsconfig",
  "tests/types/tsconfig.json",
  "--fail-on-warnings",
]);
if (positive.exitCode !== 0) {
  throw new Error(
    `positive Svelte check failed:\n${positive.stdout.toString()}${positive.stderr.toString()}`,
  );
}
const negative = await runWithHangGuard([
  process.execPath,
  "node_modules/typescript/bin/tsc",
  "--project",
  "tests/types/invalid-tsconfig.json",
  "--noEmit",
]);
if (
  negative.exitCode === 0 ||
  !/TS2322/.test(negative.stdout.toString() + negative.stderr.toString())
) {
  throw new Error("invalid TypeScript fixture did not fail with TS2322");
}
const negativeSvelte = await runWithHangGuard([
  process.execPath,
  "node_modules/svelte-check/bin/svelte-check",
  "--config",
  "svelte-check.config.ts",
  "--tsconfig",
  "tests/types/invalid-svelte-tsconfig.json",
  "--output",
  "machine",
]);
const svelteDiagnostic =
  negativeSvelte.stdout.toString() + negativeSvelte.stderr.toString();
if (
  negativeSvelte.exitCode === 0 ||
  !svelteDiagnostic.includes("invalid.svelte") ||
  !svelteDiagnostic.includes("Type 'string' is not assignable to type 'number'")
) {
  throw new Error(
    `invalid Svelte fixture did not produce the required type diagnostic:\n${svelteDiagnostic}`,
  );
}
console.log(
  "type gate passed: positive Svelte check and rejected TypeScript/Svelte negative controls",
);
