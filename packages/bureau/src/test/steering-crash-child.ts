/**
 * AB-200 — the child half of the durable-steering SIGKILL tests.
 *
 * Stands up a real durable Bureau on the SQLite path given as `argv[2]`,
 * submits steering commands through the public verb, writes the marker
 * file at `argv[3]`, and then kills itself with SIGKILL.
 *
 * The self-kill is the point. A test that reaches its restart boundary by
 * disposing cleanly proves a record survives an orderly shutdown; it does
 * not prove the record was durably committed at the moment admission
 * returned. SIGKILL runs no exit handler, no `dispose()`, and no flush, so
 * whatever the next process finds was genuinely on disk before this one died.
 *
 * `argv[4]` selects the mode and `argv[5]` a comma-separated list of
 * commands from `COMMANDS`, submitted in order:
 *
 * - `admit` (the default, with `pause` by default) starts a run and admits
 *   each command, which must be accepted.
 * - `retry` reopens the backend and submits each command against the session
 *   named by `argv[6]`, after a restart.
 *
 * Either way the marker records the session id, its incarnation, and every
 * outcome.
 *
 * Not a test file: it is spawned by `steering-crash-recovery.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';

import { STEERABLE_MODELS } from '../testing/default-agent.test-support';
import { createBureau } from '../create-bureau';
import type { SteeringCommandRequest } from '../steering';
import { createAgent } from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import { awakeTurns } from '@lostgradient/testing/wait-until';

const COMMANDS = {
  pause: { id: 'crash-cmd-1', principal: 'alice', requestedValue: { target: 'pause' } },
  model: {
    id: 'crash-cmd-2',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
  },
  opus: {
    id: 'crash-cmd-3',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-opus-4-8' },
  },
  probe: {
    id: 'crash-cmd-4',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
  },
} as const satisfies Record<string, SteeringCommandRequest>;

const [storagePath, markerPath, mode = 'admit', commandList = 'pause', sessionArgument] =
  process.argv.slice(2);
const commandNames = commandList.split(',');
const runtime = createDefaultRuntimeServices();

if (
  storagePath === undefined ||
  markerPath === undefined ||
  (mode !== 'admit' && mode !== 'retry') ||
  !commandNames.every((name) => name in COMMANDS) ||
  (mode === 'retry' && sessionArgument === undefined)
) {
  process.stderr.write(
    'usage: steering-crash-child <storagePath> <markerPath> [admit|retry] [command,...] [sessionId]\n',
  );
  process.exit(2);
}

const bureau = await createBureau<AgentDefinitions>({
  agents: {
    default: createAgent({
      allowedCandidates: STEERABLE_MODELS,
      generate: () => new Promise<never>(() => {}),
      toolbox: createToolbox([]),
    }),
  },
  storage: { type: 'sqlite', path: storagePath },
  durable: true,
  // A short workflow claim, so a later process can recover this one's run
  // soon after it is killed (the parent waits out the TTL first).
  durableOwnership: {
    ownership: 'workflow-lease',
    workflowClaimTtlMs: 200,
    workflowClaimRenewIntervalMs: 50,
  },
});

let sessionId: string;
let runId: string | undefined;
if (mode === 'retry') {
  await bureau.waitForRecovery?.();
  sessionId = sessionArgument ?? '';
} else {
  const run = await bureau.createRun({
    agentName: 'default',
    message: 'Wait forever',
    principal: 'alice',
  });
  sessionId = run.sessionId;
  runId = run.id;
  // Poll rather than sleep: the run must actually be live before a pause is
  // admissible, and a fixed delay would either be flaky or slow.
  for await (const _turn of awakeTurns()) {
    const session = await bureau.contexts.get(sessionId);
    if (session?.metadata['lastRunStatus'] === 'running') break;
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, 10));
  }
}

const outcomes = [];
for (const name of commandNames) {
  const outcome = await bureau.contexts.steer(sessionId, COMMANDS[name as keyof typeof COMMANDS]);
  if (mode === 'admit' && outcome.outcome !== 'accepted') {
    process.stderr.write(`child: expected accepted for ${name}, got ${outcome.outcome}\n`);
    process.exit(3);
  }
  outcomes.push(outcome);
}

// The parent reads this to learn the session and the outcomes. Written
// synchronously so it is on disk before the kill.
const markedSession = await bureau.contexts.get(sessionId);
writeFileSync(
  markerPath,
  JSON.stringify({ sessionId, runId, incarnation: markedSession?.incarnation, outcomes }),
  'utf8',
);

// No `bureau.dispose()`, deliberately. SIGKILL cannot be trapped, so no
// cleanup, no flush, no graceful close runs after this line.
process.kill(process.pid, 'SIGKILL');
