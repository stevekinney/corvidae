/**
 * COR-1476 — the child half of the session-input SIGKILL recovery test.
 *
 * Stands up a real durable Bureau on the backend named by `argv[2]` (`sqlite` or
 * `lmdb`) at the path `argv[3]`, starts a run whose first step commits and whose
 * second step hangs, admits two session inputs while it hangs, writes the marker
 * file at `argv[4]`, and kills itself with SIGKILL.
 *
 * The inputs are therefore admitted and durable, and the run is mid-step, with
 * nothing delivered, when the process dies: exactly the "restart between
 * admission and delivery" the recovering process must repair.
 *
 * Not a test file: it is spawned by `session-input-crash-recovery.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../create-bureau';

const [backend, storagePath, markerPath] = process.argv.slice(2);
if (
  (backend !== 'sqlite' && backend !== 'lmdb') ||
  storagePath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: session-input-crash-child <sqlite|lmdb> <storagePath> <markerPath>\n',
  );
  process.exit(2);
}

const runtime = createDefaultRuntimeServices();
const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

let stepOneStarted = false;
const bureau = await createBureau({
  agents: {},
  generate: async ({ step }) => {
    if (step === 0) return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
    stepOneStarted = true;
    return new Promise<never>(() => {});
  },
  toolbox: createToolbox([nextTool]),
  storage: { type: backend, path: storagePath },
  durableExecution: true,
  // A short workflow claim, so a later process can recover this one's run soon
  // after it is killed (the parent waits out the TTL first).
  durableOwnership: {
    ownership: 'workflow-lease',
    workflowClaimTtlMs: 200,
    workflowClaimRenewIntervalMs: 50,
  },
});

const run = await bureau.createRun({ message: 'Start', principal: 'alice' });
for (let attempt = 0; attempt < 400 && !stepOneStarted; attempt += 1) {
  await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, 10));
}
if (!stepOneStarted) {
  process.stderr.write('child: the run never reached its second step\n');
  process.exit(3);
}

const outcomes: string[] = [];
for (const [id, payload] of [
  ['input-a', 'first'],
  ['input-b', 'second'],
] as const) {
  const outcome = await bureau.submitSessionInput(run.sessionId, {
    id,
    principal: 'alice',
    deliveryMode: 'steer',
    payload,
  });
  outcomes.push(outcome.outcome);
}
if (outcomes.some((outcome) => outcome !== 'admitted')) {
  process.stderr.write(`child: expected both inputs admitted, got ${outcomes.join(',')}\n`);
  process.exit(4);
}

// Written synchronously so it is on disk before the kill.
writeFileSync(markerPath, JSON.stringify({ sessionId: run.sessionId, runId: run.id }), 'utf8');

// No `bureau.dispose()`, deliberately: SIGKILL cannot be trapped, so no cleanup
// or flush runs after this line.
process.kill(process.pid, 'SIGKILL');
