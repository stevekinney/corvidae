import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { appendFile, mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type Mode = "development" | "production";
export type Boundary = "reference" | "candidate";
const root = resolve(import.meta.dir, "../..");
const evidenceDirectory = join(root, ".velveteen/evidence");
const hash = async (path: string) =>
  new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");

/** Launch the real fixture, record readiness and complete process evidence, and await cleanup. */
export async function startFixture(boundary: Boundary, mode: Mode) {
  await mkdir(evidenceDirectory, { recursive: true });
  const bunPath = join(evidenceDirectory, "bun-only-path");
  await mkdir(bunPath, { recursive: true });
  if (!(await Bun.file(join(bunPath, "bun")).exists()))
    await symlink(process.execPath, join(bunPath, "bun"));
  const cwd =
    boundary === "reference"
      ? join(root, "tests/reference")
      : join(root, "tests/fixtures/candidate");
  const entry = boundary === "reference" ? "launch.ts" : "server.ts";
  const command = [
    process.execPath,
    ...(boundary === "candidate" ? ["--config=bunfig.toml"] : []),
    entry,
    "--mode",
    mode,
    "--port",
    "0",
  ];
  const identifier = `${boundary}-${mode}-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  const ready = Promise.withResolvers<{ url: string; artifact?: string }>();
  const child = spawnWithHangGuard(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(boundary === "candidate" ? { PATH: bunPath } : {}),
    },
  });
  let stdout = "";
  let stderr = "";
  const stdoutTask = (async () => {
    let pending = "";
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      stdout += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          value &&
          typeof value === "object" &&
          "url" in value &&
          typeof value.url === "string"
        ) {
          const artifact =
            "artifact" in value && typeof value.artifact === "string"
              ? value.artifact
              : undefined;
          ready.resolve({ url: value.url, artifact });
        }
      }
    }
  })();
  const stderrTask = (async () => {
    for await (const chunk of child.stderr)
      stderr += new TextDecoder().decode(chunk);
  })();
  const timer = setTimeout(
    () =>
      ready.reject(
        new Error(
          `${boundary}/${mode} readiness timed out\n${stdout}\n${stderr}`,
        ),
      ),
    5_000,
  );
  void child.exited.then((exit) =>
    ready.reject(
      new Error(
        `${boundary}/${mode} exited ${exit} before readiness\n${stdout}\n${stderr}`,
      ),
    ),
  );
  let information: { url: string; artifact?: string };
  try {
    information = await ready.promise;
  } catch (error) {
    child.kill("SIGTERM");
    await child.exited;
    await Promise.all([stdoutTask, stderrTask]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    ...information,
    async stop() {
      child.kill("SIGTERM");
      const exitCode = await child.exited;
      await Promise.all([stdoutTask, stderrTask]);
      const stdoutPath = join(evidenceDirectory, `${identifier}.stdout.log`);
      const stderrPath = join(evidenceDirectory, `${identifier}.stderr.log`);
      await Bun.write(stdoutPath, stdout);
      await Bun.write(stderrPath, stderr);
      const artifact = information.artifact
        ? {
            path: information.artifact,
            sha256: await hash(information.artifact),
          }
        : undefined;
      const record = {
        identifier,
        boundary,
        mode,
        command,
        cwd,
        pid: child.pid,
        bun: Bun.version,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "completed",
        exitCode,
        entry: { path: join(cwd, entry), sha256: await hash(join(cwd, entry)) },
        stdout: { path: stdoutPath, sha256: await hash(stdoutPath) },
        stderr: { path: stderrPath, sha256: await hash(stderrPath) },
        artifact,
      };
      await appendFile(
        join(evidenceDirectory, "commands.jsonl"),
        `${JSON.stringify(record)}\n`,
      );
      if (exitCode !== 0)
        throw new Error(
          `${boundary}/${mode} did not stop cleanly (${exitCode})\n${stderr}`,
        );
    },
  };
}
