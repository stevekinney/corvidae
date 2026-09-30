/**
 * COR-1390 — the child half of the process-crash recovery harness.
 *
 * Usage: `bun process-crash-child.ts <scenario> <sqlite|lmdb> <storagePath> <markerPath>`
 *
 * Stands up a real durable Bureau under `workflow-lease` ownership, drives
 * the named scenario, writes the marker file synchronously, and then kills
 * itself with SIGKILL. No `dispose()`, no `shutdown()`: SIGKILL cannot be
 * trapped, so whatever the parent finds afterwards was genuinely on disk
 * before the process died and the claim it held is left to lapse.
 *
 * Not a test file: it is spawned by `process-crash-recovery.test.ts`. Each
 * scenario is a named function below; the `scenarios` table is the extension
 * point for further crash scenarios.
 */
import { writeFileSync } from 'node:fs';

import { stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../create-bureau';

/**
 * Must match `CLAIM_TTL_MS` / `CLAIM_RENEW_MS` in `process-crash-recovery.test.ts`:
 * the parent derives its claim-lapse wait from the same TTL.
 */
const CLAIM_TTL_MS = 200;
const CLAIM_RENEW_MS = 50;

const POLL_ATTEMPTS = 2000;
const POLL_DELAY_MS = 5;

const scenarioName = process.argv[2];
const backend = process.argv[3];
const storagePath = process.argv[4];
const markerPath = process.argv[5];

if (
  scenarioName === undefined ||
  (backend !== 'sqlite' && backend !== 'lmdb') ||
  storagePath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: process-crash-child <scenario> <sqlite|lmdb> <storagePath> <markerPath>\n',
  );
  process.exit(2);
}

/** Bounded condition poll with a tiny real delay (LMDB starves a zero-delay loop). */
async function pollUntil(description: string, check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
  }
  process.stderr.write(`child: timed out waiting for ${description}\n`);
  process.exit(3);
}

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

/**
 * Commits step 0, parks mid-step-1, records what the child has durably
 * observed, then returns so the caller can kill the process.
 */
async function parkAfterStepZero(): Promise<void> {
  let reachedStepOne = false;
  const bureau = await createBureau({
    agents: {},
    generate: async ({ step }) => {
      if (step === 0) {
        return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      }
      // Step 0's cursor has committed once step 1 is requested.
      reachedStepOne = true;
      return new Promise<never>(() => {});
    },
    toolbox: createToolbox([createNextTool()]),
    storage: { type: backend as 'sqlite' | 'lmdb', path: storagePath as string },
    durableExecution: true,
    stopWhen: stopWhen.noToolCalls(),
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });

  const auditTrail = bureau.auditTrail;
  if (auditTrail === undefined) {
    process.stderr.write('child: the bureau has no audit trail\n');
    process.exit(4);
  }

  const run = await bureau.createRun({ message: 'crash harness run', principal: 'alice' });
  const session = { kind: 'session', id: run.sessionId } as const;

  await pollUntil('generate to be invoked at step 1', () => reachedStepOne);
  await pollUntil('the step-0 step.completed audit record', async () => {
    const records = await auditTrail.query({ runId: run.id, type: 'step.completed' });
    return records.length > 0;
  });
  await pollUntil('a non-empty session event page', async () => {
    const page = await bureau.eventHistory(session);
    return !('outcome' in page) && page.events.length > 0;
  });

  const records = await auditTrail.query({ runId: run.id });
  const maxAuditSequence = Math.max(...records.map((record) => record.sequence ?? -1));
  const page = await bureau.eventHistory(session);
  if ('outcome' in page) {
    process.stderr.write(`child: expected an event page, got ${JSON.stringify(page)}\n`);
    process.exit(4);
  }
  const last = page.events[page.events.length - 1];
  if (last === undefined) {
    process.stderr.write('child: session event page was empty\n');
    process.exit(4);
  }

  // Written synchronously so it is on disk before the kill.
  writeFileSync(
    markerPath as string,
    JSON.stringify({
      runId: run.id,
      sessionId: run.sessionId,
      maxAuditSequence,
      sessionCursor: last.cursor,
      sessionLastSequence: last.sequence,
    }),
    'utf8',
  );
}

const scenarios: Record<string, () => Promise<void>> = {
  'park-after-step-0': parkAfterStepZero,
};

const scenario = scenarios[scenarioName];
if (scenario === undefined) {
  process.stderr.write(`child: unknown scenario "${scenarioName}"\n`);
  process.exit(2);
}

await scenario();

// No `bureau.dispose()` / `shutdown()`, deliberately.
process.kill(process.pid, 'SIGKILL');
