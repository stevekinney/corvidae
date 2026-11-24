import { expect, test } from "bun:test";
import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outcome = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), "compiler-source-maps-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "index.ts")],
      outdir: directory,
      target: "bun",
    });
    const artifact = build.outputs.find(
      (output) => output.kind === "entry-point",
    );
    if (!build.success || !artifact) throw new Error("Compiler bundle failed");
    const child = spawnWithHangGuard(
      [
        process.execPath,
        "-e",
        `
      import { compileComponent } from ${JSON.stringify(artifact.path)};
      try {
        compileComponent('<script>let = ;</script>', { filename: 'Broken.svelte' });
        process.exitCode = 1;
      } catch (error) {
        void error.stack;
        if (!String(error).includes('Broken.svelte') || error.code !== 'js_parse_error') process.exitCode = 1;
        else console.log('expected compiler error');
      }
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test("bundled compiler reports an error stack without source map diagnostics", () => {
  expect(outcome.stderr).toBe("");
  expect(outcome.stdout).toContain("expected compiler error");
  expect(outcome.exitCode).toBe(0);
});
