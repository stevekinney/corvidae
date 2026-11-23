import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("packed compiler proves an unrelated installed consumer", () => {
  const probe = join(import.meta.dir, "package-consumer-probe.ts");
  const result = Bun.spawnSync(
    [process.execPath, "--no-install", probe, root],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Installed consumer failed:\n${result.stderr.toString()}\n${result.stdout.toString()}`,
    );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    '"browser":"Count: 3 -> Count: 4"',
  );
  expect(result.stdout.toString()).toContain('"css":"rgb(1, 2, 3)"');
  expect(result.stdout.toString()).toContain(
    '"applicationModes":["development","production"]',
  );
  expect(result.stdout.toString()).toContain(
    '"cleanup":{"consumerDirectoryRemoved":true,"browserDisconnected":true,"serverStopResolved":true}',
  );
});
