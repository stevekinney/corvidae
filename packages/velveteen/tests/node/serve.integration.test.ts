import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildProduction } from "../../src/build/index.ts";

const fixture = join(import.meta.dir, "../workerd/fixture");
const nativeTest = join(import.meta.dir, "serve-node.test.ts");
type NodeTestResult = {
  exitCode: number | null;
  failCount: number;
  passCount: number;
  stderr: string;
  stdout: string;
  version: string;
};
type RunNodeTests = (
  files: readonly string[],
  options: { bundle: boolean; env: Record<string, string> },
) => Promise<NodeTestResult>;

const { runNodeTests } = (await import(
  new URL("../../../../testing/testing/src/node-runtime.ts", import.meta.url)
    .href
)) as { runNodeTests: RunNodeTests };

test("serves a production Velveteen application through Node", async () => {
  const project = await mkdtemp(join(import.meta.dir, ".node-"));
  try {
    await cp(fixture, project, { recursive: true });
    const generation = await buildProduction({
      projectDirectory: project,
      routesDirectory: join(project, "routes"),
      staticDirectory: join(project, "static"),
      outputDirectory: join(project, "output"),
    });
    const result = await runNodeTests([nativeTest], {
      bundle: true,
      env: { VELVETEEN_NODE_GENERATION: generation.directory },
    });
    expect(result.version).toMatch(/^v2[2-9]\./u);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.failCount).toBe(0);
    expect(result.passCount).toBe(1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
