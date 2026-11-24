import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the installed consumer and starter probes pass", async () => {
  // The command invokes chromium.launch() in both probes; run it only in the browser-capable CI lane.
  const child = spawnWithHangGuard(
    [process.execPath, "run", "test:package-consumer"],
    {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exit, stdout, stderr }).toMatchObject({ exit: 0 });
});
