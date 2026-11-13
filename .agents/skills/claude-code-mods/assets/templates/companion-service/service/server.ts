// The attention-queue companion service for Bun: `bun service/server.ts`.
// It listens on loopback only. The port is the single-owner lock: a second
// instance fails to bind and exits, leaving the first one's runtime file alone.
import { PROTOCOL_VERSION } from '../plugin/hooks/protocol.ts';
import { createHandler } from './handler.ts';
import { createQueue } from './queue.ts';
import { newToken, removeRuntimeFile, runtimeFilePath, writeRuntimeFile } from './runtime-file.ts';

const port = Number(process.env.ATTENTION_QUEUE_PORT ?? '47615');
const token = newToken();
const runtimeFile = runtimeFilePath();

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: createHandler({ queue: createQueue(), token, port, now: Date.now }),
  });
} catch (error) {
  console.error(
    `attention-queue: could not listen on 127.0.0.1:${port} (${String(error)}); another instance may own it`,
  );
  process.exit(1);
}

writeRuntimeFile(runtimeFile, {
  url: `http://127.0.0.1:${server.port}`,
  token,
  protocolVersion: PROTOCOL_VERSION,
  pid: process.pid,
});
console.error(
  `attention-queue: listening on http://127.0.0.1:${server.port}; runtime file ${runtimeFile}`,
);

function shutDown(): void {
  removeRuntimeFile(runtimeFile, process.pid);
  void server.stop();
  process.exit(0);
}
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
