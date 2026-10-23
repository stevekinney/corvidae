/**
 * COR-1476 — the child half of the session-input SIGKILL recovery tests.
 *
 * Stands up a real durable Bureau on the backend named by `argv[2]` (`sqlite` or
 * `lmdb`) at the path `argv[3]`, writes the marker file at `argv[4]`, and kills
 * itself with SIGKILL in the state `argv[5]` names:
 *
 * - `running` (the default): a run whose first step commits and whose second
 *   step hangs, with two session inputs admitted while it hangs. The inputs are
 *   admitted and durable, and the run is mid-step with nothing delivered, when
 *   the process dies: the recovering process's run must deliver them.
 * - `ended`: a run that has finished, with the write that marks its session
 *   completed held so the session still reads as running, and one session
 *   input admitted into that window. The process dies the moment the
 *   admission is durable, before the submit reads liveness and before the run's
 *   end settles anything: the input is open, no run is live, and the
 *   recovering process's boot sweep must cancel it.
 *
 * Not a test file: it is spawned by `session-input-crash-recovery.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, createAgent } from '@lostgradient/operative';
import { resolveStorage } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../create-bureau';
import { admitsSessionInput, savesSessionAs, seamStorage } from './session-input-fixtures';
import type { AgentDefinitions } from '../agent-catalog';

const [backend, storagePath, markerPath, mode = 'running'] = process.argv.slice(2);
if (
  (backend !== 'sqlite' && backend !== 'lmdb') ||
  storagePath === undefined ||
  markerPath === undefined ||
  (mode !== 'running' && mode !== 'ended')
) {
  process.stderr.write(
    'usage: session-input-crash-child <sqlite|lmdb> <storagePath> <markerPath> [running|ended]\n',
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
// A short workflow claim, so a later process can recover this one's run soon
// after it is killed (the parent waits out the TTL first).
const durableOwnership = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 200,
  workflowClaimRenewIntervalMs: 50,
} as const;

function killNow(sessionId: string, incarnation: string, runId: string): never {
  // Written synchronously so it is on disk before the kill.
  writeFileSync(markerPath!, JSON.stringify({ sessionId, incarnation, runId }), 'utf8');
  // No `bureau.dispose()`, deliberately: SIGKILL cannot be trapped, so no cleanup
  // or flush runs after this line.
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

async function submit(
  bureau: Awaited<ReturnType<typeof createBureau>>,
  sessionId: string,
  id: string,
  payload: string,
): Promise<string> {
  const outcome = await bureau.submitSessionInput(sessionId, {
    id,
    principal: 'alice',
    deliveryMode: 'steer',
    payload,
  });
  return outcome.outcome;
}

if (mode === 'running') {
  let stepOneStarted = false;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          if (step === 0)
            return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
          stepOneStarted = true;
          return new Promise<never>(() => {});
        },
        toolbox: createToolbox([nextTool]),
      }),
    },
    storage: { type: backend, path: storagePath },
    durableExecution: true,
    durableOwnership,
  });

  const run = await bureau.createRun({
    agentName: 'default',
    message: 'Start',
    principal: 'alice',
  });
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
    outcomes.push(await submit(bureau, run.sessionId, id, payload));
  }
  if (outcomes.some((outcome) => outcome !== 'admitted')) {
    process.stderr.write(`child: expected both inputs admitted, got ${outcomes.join(',')}\n`);
    process.exit(4);
  }
  const session = await bureau.getSession(run.sessionId);
  killNow(run.sessionId, session?.incarnation ?? '', run.id);
}

// `ended`: the run finishes; its terminal session write is held so the session
// still reads as running; the input is admitted into that window; the process
// dies as soon as the admission is durable.
const seam = seamStorage(await resolveStorage({ type: backend, path: storagePath }));
const bureau = await createBureau<AgentDefinitions>({
  agents: {
    default: createAgent({
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createToolbox([nextTool]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage: seam.storage,
  durableExecution: true,
  durableOwnership,
  // Ends the run on its first reply, as `completed`.
});
const heldTerminalSave = seam.holdWrite(savesSessionAs('completed'));
const run = await bureau.createRun({
  agentName: 'default',
  message: 'Start',
  principal: 'alice',
  maximumSteps: 1,
});
await heldTerminalSave.reached;
const endedSession = await bureau.getSession(run.sessionId);
void seam
  .awaitWriteCommitted(admitsSessionInput)
  .then(() => killNow(run.sessionId, endedSession?.incarnation ?? '', run.id));
const outcome = await submit(bureau, run.sessionId, 'input-a', 'too late');
// Unreachable when the admission commits: the kill lands first.
process.stderr.write(`child: survived the admission, which answered ${outcome}\n`);
process.exit(5);
