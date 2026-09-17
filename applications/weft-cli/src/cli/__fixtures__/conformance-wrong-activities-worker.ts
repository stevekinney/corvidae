#!/usr/bin/env bun

import { conformanceManifest } from './conformance-manifest.ts';

export type ConformanceWrongActivitiesWorkerFixture = 'wrong-activities';

const serverUrl = Bun.env['WEFT_WORKER_URL'];

if (serverUrl === undefined) {
  process.stderr.write(`WEFT_WORKER_URL is required\n`);
  process.exit(2);
}

const socket = new WebSocket(serverUrl);

socket.addEventListener('open', () => {
  socket.send(
    JSON.stringify({
      type: 'register',
      protocolVersion: Number(Bun.env['WEFT_WORKER_PROTOCOL_VERSION'] ?? '3'),
      workerId: 'wrong-activities-worker',
      manifest: conformanceManifest(['other.activity']),
      concurrency: 1,
    }),
  );
});

socket.addEventListener('close', () => {
  process.exit(0);
});

socket.addEventListener('error', () => {
  process.exit(1);
});
