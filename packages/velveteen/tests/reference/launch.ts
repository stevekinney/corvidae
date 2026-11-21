import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";

const mode = process.argv[process.argv.indexOf("--mode") + 1] ?? "development";
const port = process.argv[process.argv.indexOf("--port") + 1] ?? "4173";
const environment = { ...process.env };
delete environment.FORCE_COLOR;
delete environment.NO_COLOR;
if (mode === "production") {
  const build = spawnWithHangGuard(
    [
      process.execPath,
      "node_modules/vite/bin/vite.js",
      "build",
      "--config",
      "vite-reference.config.ts",
    ],
    {
      cwd: import.meta.dirname,
      env: environment,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  await build.exited;
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
}
const command =
  mode === "production"
    ? ["preview", "--host", "127.0.0.1", "--port", port]
    : ["dev", "--host", "127.0.0.1", "--port", port];
const child = spawnWithHangGuard(
  [
    process.execPath,
    "node_modules/vite/bin/vite.js",
    ...command,
    "--config",
    "vite-reference.config.ts",
  ],
  {
    cwd: import.meta.dirname,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  },
);
let output = "";
const announce = (chunk: Uint8Array) => {
  output += new TextDecoder().decode(chunk);
  const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
  if (match) console.log(JSON.stringify({ url: `${match[0]}/` }));
};
async function read(stream: ReadableStream<Uint8Array>) {
  for await (const chunk of stream) announce(chunk);
}
const stdout = read(child.stdout);
const stderr = read(child.stderr);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  child.kill("SIGTERM");
});
await Promise.all([child.exited, stdout, stderr]);
process.exit(stopping ? 0 : (child.exitCode ?? 1));
