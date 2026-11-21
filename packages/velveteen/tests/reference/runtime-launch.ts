import { spawnWithHangGuard } from "@lostgradient/testing/hang-guard";
import { join } from "node:path";
import { createServer } from "node:http";
const directory = process.argv[2],
  mode = process.argv[3];
const executable = join(import.meta.dir, "node_modules/vite/bin/vite.js");
if (mode === "production") {
  const child = spawnWithHangGuard([process.execPath, executable, "build"], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exit = await child.exited;
  if (exit) process.exit(exit);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing reference address");
  const url = `http://127.0.0.1:${address.port}/`;
  process.env.ORIGIN = new URL(url).origin;
  const { handler } = await import(join(directory, "build/handler.js"));
  server.on("request", handler);
  console.log(JSON.stringify({ url }));
  process.on("SIGTERM", () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
  await new Promise(() => {});
}
const child = spawnWithHangGuard(
  [
    process.execPath,
    executable,
    mode === "production" ? "preview" : "dev",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ],
  { cwd: directory, stdout: "pipe", stderr: "pipe" },
);
const pump = async (stream: ReadableStream<Uint8Array>) => {
  for await (const chunk of stream) {
    const text = new TextDecoder().decode(chunk);
    process.stdout.write(text);
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) console.log(JSON.stringify({ url: match[0] + "/" }));
  }
};
const outputs = Promise.all([pump(child.stdout), pump(child.stderr)]);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  child.kill("SIGTERM");
});
const exit = await child.exited;
await outputs;
process.exit(stopping ? 0 : exit);
