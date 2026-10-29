/**
 * AB-359, COR-1767 — the child half of the LMDB "event history run ownership survives a process
 * restart" test (`event-history-run-ownership-recovery-lmdb.test.ts`).
 *
 * Stands up a real durable Bureau over the LMDB directory given as `argv[2]`, starts one run as
 * principal `alice`, and waits until its model is asked for step 1, which proves step 0 is
 * durably checkpointed. It then writes the run's identifiers to the marker file at `argv[3]` and
 * hangs: the parent kills it with SIGKILL, so the workflow is left non-terminal on disk, exactly as
 * a process that died mid-run leaves it, with no `dispose()` or flush in between.
 *
 * It constructs its own `LMDBStorage` on the path its parent passes, as every crash child does; the
 * handle is released when the process is killed.
 *
 * Not a test file: it is spawned by `event-history-run-ownership-recovery-lmdb.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { stopWhen, createAgent } from '@lostgradient/operative';
import { LMDBStorage } from '@lostgradient/storage-lmdb';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../create-bureau';
import type { AgentDefinitions } from '../agent-catalog';

const [storagePath, markerPath] = process.argv.slice(2);
if (storagePath === undefined || markerPath === undefined) {
  process.stderr.write('usage: event-history-owner-crash-child <lmdb-path> <marker-path>\n');
  process.exit(2);
}

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

let reachedStepOne: () => void = () => {};
const stepOne = new Promise<void>((resolve) => {
  reachedStepOne = resolve;
});

const bureau = await createBureau<AgentDefinitions>({
  agents: {
    default: createAgent({
      generate: async ({ step }) => {
        if (step === 0) {
          return { content: 'A step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        }
        reachedStepOne(); // step 0's saveCursor has committed
        return new Promise<never>(() => {}); // the process dies here
      },
      toolbox: createToolbox([next]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage: new LMDBStorage(storagePath),
  durable: true,
  durableOwnership: { ownership: 'none' },
});

const run = await bureau.tasks.start('default', 'Attribute me to alice across a restart', {
  principal: 'alice',
});
await stepOne;
writeFileSync(markerPath, JSON.stringify({ runId: run.id, contextId: run.contextId }));
// Stay alive until the parent's SIGKILL: an interval keeps the event loop busy whatever Bureau's
// own timers do, and nothing after this line runs.
setInterval(() => {}, 60_000);
