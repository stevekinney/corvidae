/**
 * COR-1946 — the child half of the process-local task SIGKILL test.
 *
 * Usage: `bun process-local-task-crash-child.ts <crash|peer> <sqlitePath> <markerPath> <originMs>`
 *
 * Stands up a Bureau with no durable engine (`durable: false`) over the SQLite file, starts one task
 * whose run parks for ever, and publishes `{ runId, ownerProcess }` to the marker file.
 *
 * - `crash`: then kills itself with SIGKILL. No `shutdown()`, no flush: whatever the next process
 *   finds was on disk before this one died. Its lease runs on the real clock.
 * - `peer`: then stays alive until the test kills it. It runs on a manual clock that starts at
 *   `originMs`, so its lease is dated far enough ahead of the parent's clock to read as current.
 *
 * Not a test file: it is spawned by `process-local-task-crash.slow.test.ts`.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createToolbox } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { publishChildFile } from './child-output-file';

const [mode, storagePath, markerPath, originArgument] = process.argv.slice(2);
if (
  (mode !== 'crash' && mode !== 'peer') ||
  storagePath === undefined ||
  markerPath === undefined ||
  originArgument === undefined
) {
  process.stderr.write(
    'usage: process-local-task-crash-child <crash|peer> <path> <marker> <origin>\n',
  );
  process.exit(2);
}

const bureau = await createBureau<AgentDefinitions>({
  agents: {
    default: createAgent({
      generate: () => new Promise<never>(() => undefined),
      toolbox: createToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage: new BunSQLiteStorage(storagePath),
  durable: false,
  maintenance: 'manual',
  ...(mode === 'peer'
    ? {
        runtime: createManualRuntimeServices({
          origin: new Date(Number(originArgument)).toISOString(),
        }),
      }
    : {}),
});

const run = await bureau.tasks.start('default', 'work', { principal: 'api-key:alice' });
const record = await bureau.internals.taskRegistry.record(run.id);
// Written synchronously, so it is on disk before a kill that follows.
publishChildFile(
  markerPath,
  JSON.stringify({ runId: run.id, ownerProcess: record?.ownerProcess ?? null }),
);
if (mode === 'crash') {
  process.kill(process.pid, 'SIGKILL');
}
// A peer stays up until the test kills it.
await new Promise<never>(() => undefined);
