import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import {
  writeRuntimeFixture,
  type RuntimeBoundary,
} from "./runtime-fixture.ts";
const root = resolve(import.meta.dir, "../..");
export async function startRuntime(
  boundary: RuntimeBoundary,
  mode: "development" | "production",
) {
  const directory = join(
    root,
    boundary === "reference"
      ? "tests/reference/.velveteen/runtime"
      : ".velveteen/runtime",
    `${boundary}-${mode}`,
  );
  await writeRuntimeFixture(directory, boundary);
  const evidence = join(
    root,
    ".velveteen/evidence",
    `runtime-${boundary}-${mode}`,
  );
  await mkdir(evidence, { recursive: true });
  let command: string[];
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  if (boundary === "candidate") {
    const generation = await buildProduction({
      projectDirectory: directory,
      routesDirectory: join(directory, "src/routes"),
      staticDirectory: join(directory, "static"),
      outputDirectory: join(directory, "output"),
      basePath: "/runtime",
      mode,
    });
    const description = join(directory, "generation.json");
    await Bun.write(description, JSON.stringify(generation));
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "runtime-host.ts")],
      target: "bun",
      outdir: join(directory, "host"),
      naming: "host.js",
      minify: mode === "production",
    });
    if (!result.success || result.logs.length)
      throw new Error(`Host build failed: ${result.logs.join("\n")}`);
    command = [process.execPath, join(directory, "host/host.js"), description];
    const path = join(evidence, "bin");
    await mkdir(path, { recursive: true });
    if (!(await Bun.file(join(path, "bun")).exists()))
      await symlink(process.execPath, join(path, "bun"));
    environment.PATH = path;
  } else
    command = [
      process.execPath,
      join(root, "tests/reference/runtime-launch.ts"),
      directory,
      mode,
    ];
  const ready = Promise.withResolvers<string>();
  const child = spawnWithHangGuard(command, {
    cwd: directory,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "",
    stderr = "";
  const output = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      stdout += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
          const data: unknown = JSON.parse(line);
          if (
            data &&
            typeof data === "object" &&
            "url" in data &&
            typeof data.url === "string"
          )
            ready.resolve(data.url);
        } catch {
          /* Non-protocol application output is retained below. */
        }
      }
    }
  })();
  const errors = (async () => {
    for await (const chunk of child.stderr)
      stderr += new TextDecoder().decode(chunk);
  })();
  void child.exited.then((exit) =>
    ready.reject(new Error(`Runtime exited ${exit}\n${stdout}\n${stderr}`)),
  );
  let url: string;
  try {
    url = await ready.promise;
  } catch (error) {
    child.kill();
    await child.exited;
    await Promise.all([output, errors]);
    throw error;
  }
  return {
    url,
    directory,
    evidence,
    async stop() {
      child.kill("SIGTERM");
      const exit = await child.exited;
      await Promise.all([output, errors]);
      await Bun.write(join(evidence, "stdout.log"), stdout);
      await Bun.write(join(evidence, "stderr.log"), stderr);
      await Bun.write(
        join(evidence, "process.json"),
        JSON.stringify(
          {
            boundary,
            mode,
            command,
            cwd: directory,
            bun: Bun.version,
            pid: child.pid,
            url,
            exit,
            PATH: environment.PATH,
          },
          null,
          2,
        ),
      );
      if (exit !== 0) throw new Error(`Runtime shutdown ${exit}\n${stderr}`);
    },
  };
}
