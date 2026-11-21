import { mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Launch the packaged fixture with auto-install disabled, and always reap the owned process. */
export async function startProductionFixture(
  directory: string,
  evidenceDirectory: string,
  options: { compression?: boolean } = {},
) {
  const startedAt = new Date().toISOString();
  const bin = join(directory, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "bun"));
  const pathEntries = await Promise.all(
    (await readdir(bin)).map(async (name) => ({
      name,
      executable: await realpath(join(bin, name)),
    })),
  );
  const command = [
    process.execPath,
    "--no-install",
    "--no-env-file",
    join(directory, "host.js"),
  ];
  const process_ = Bun.spawn(command, {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: bin,
      NODE_ENV: "production",
      VELVETEEN_FIXTURE_COMPRESSION: options.compression ? "true" : "false",
    },
  });
  const ready = Promise.withResolvers<{
    url: string;
    bun: string;
    pid: number;
  }>();
  let stdout = "";
  let stderr = "";
  const outputTask = (async () => {
    let pending = "";
    for await (const chunk of process_.stdout) {
      const value = new TextDecoder().decode(chunk);
      stdout += value;
      pending += value;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines)
        if (line.startsWith("{")) {
          const value: unknown = JSON.parse(line);
          if (
            value &&
            typeof value === "object" &&
            "url" in value &&
            typeof value.url === "string" &&
            "bun" in value &&
            typeof value.bun === "string" &&
            "pid" in value &&
            typeof value.pid === "number"
          )
            ready.resolve({ url: value.url, bun: value.bun, pid: value.pid });
        }
    }
  })();
  const errorTask = (async () => {
    stderr = await new Response(process_.stderr).text();
  })();
  void outputTask.catch((error: unknown) => ready.reject(error));
  void errorTask.catch((error: unknown) => ready.reject(error));
  void process_.exited
    .then(async (exit) => {
      try {
        await Promise.all([outputTask, errorTask]);
        ready.reject(
          new Error(
            `Production fixture exited ${exit} before readiness:\n${stdout}\n${stderr}`,
          ),
        );
      } catch (error) {
        ready.reject(error);
      }
    })
    .catch((error: unknown) => ready.reject(error));
  const timeout = setTimeout(
    () =>
      ready.reject(
        new Error(`Production fixture not ready:\n${stdout}\n${stderr}`),
      ),
    5_000,
  );
  let information;
  try {
    information = await ready.promise;
  } catch (error) {
    process_.kill();
    await process_.exited;
    await Promise.all([outputTask, errorTask]);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return {
    ...information,
    async stop() {
      process_.kill("SIGTERM");
      const exitCode = await process_.exited;
      await Promise.all([outputTask, errorTask]);
      await mkdir(evidenceDirectory, { recursive: true });
      await Bun.write(join(evidenceDirectory, "stdout.log"), stdout);
      await Bun.write(join(evidenceDirectory, "stderr.log"), stderr);
      const result = {
        command,
        cwd: directory,
        path: bin,
        pathEntries,
        bun: information.bun,
        pid: information.pid,
        exitCode,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "completed",
        stdout,
        stderr,
      };
      await Bun.write(
        join(evidenceDirectory, "process.json"),
        JSON.stringify(result, null, 2),
      );
      if (exitCode !== 0 || stderr.trim())
        throw new Error(
          `Production fixture failed shutdown: ${JSON.stringify(result)}`,
        );
      return result;
    },
  };
}
