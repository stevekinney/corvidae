// The same service on Node.js 23.6 or later, which runs TypeScript files directly:
// `node service/node-server.ts`. Only the transport differs from server.ts: Node's
// http module is adapted to the web Request and Response the handler takes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import { PROTOCOL_VERSION } from '../plugin/hooks/protocol.ts';
import { createHandler } from './handler.ts';
import { createQueue } from './queue.ts';
import { newToken, removeRuntimeFile, runtimeFilePath, writeRuntimeFile } from './runtime-file.ts';

const port = Number(process.env.ATTENTION_QUEUE_PORT ?? '47615');
const token = newToken();
const runtimeFile = runtimeFilePath();
const handle = createHandler({ queue: createQueue(), token, port, now: Date.now });

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  return new Request(`http://${incoming.headers.host ?? 'invalid'}${incoming.url ?? '/'}`, {
    method: incoming.method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
}

const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
  toRequest(incoming)
    .then(handle)
    .then(async (response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    })
    .catch(() => {
      outgoing.writeHead(500).end();
    });
});

server.on('error', (error) => {
  console.error(
    `attention-queue: could not listen on 127.0.0.1:${port} (${String(error)}); another instance may own it`,
  );
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  writeRuntimeFile(runtimeFile, {
    url: `http://127.0.0.1:${port}`,
    token,
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
  });
  console.error(
    `attention-queue: listening on http://127.0.0.1:${port}; runtime file ${runtimeFile}`,
  );
});

function shutDown(): void {
  removeRuntimeFile(runtimeFile, process.pid);
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
