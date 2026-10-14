/**
 * AB-200 — the child half of the durable-steering SIGKILL tests.
 *
 * Stands up a real durable Bureau on the SQLite path given as `argv[2]`,
 * submits a steering command through the public verb, writes the marker
 * file at `argv[3]`, and then kills itself with SIGKILL.
 *
 * The self-kill is the point. Every other durability test in this package
 * reaches its restart boundary by disposing cleanly and reopening, which
 * proves the record survives an orderly shutdown. It does not prove the
 * record was durably committed at the moment admission returned — a
 * buffered write flushed by `dispose()` would pass that test and lose the
 * command in a real crash. SIGKILL runs no exit handler, no `dispose()`,
 * and no flush, so whatever the parent finds afterwards was genuinely on
 * disk before the process died.
 *
 * `argv[4]` selects the mode and `argv[5]` the command (see `COMMANDS`):
 *
 * - `admit` (the default, with the `pause` command by default) starts a run,
 *   admits the command, and records the session id in the marker.
 * - `retry` reopens an existing backend and re-submits the identical
 *   command against the session named by `argv[6]`. That drives steering
 *   recovery — replaying and acknowledging the command an earlier crash
 *   left in the mailbox — and the marker records the retry's outcome.
 *   Crashing afterwards produces a restart whose mailbox is already drained.
 *
 * Not a test file: it is spawned by `steering-crash-recovery.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';

import { createBureau } from '../create-bureau';
import type { SteeringCommandRequest } from '../steering';

const COMMANDS = {
  pause: { id: 'crash-cmd-1', principal: 'alice', requestedValue: { target: 'pause' } },
  model: {
    id: 'crash-cmd-2',
    principal: 'alice',
    requestedValue: { target: 'model', override: 'claude-sonnet-5' },
  },
} as const satisfies Record<string, SteeringCommandRequest>;

const [storagePath, markerPath, mode = 'admit', commandName = 'pause', sessionArgument] =
  process.argv.slice(2);
const runtime = createDefaultRuntimeServices();

if (
  storagePath === undefined ||
  markerPath === undefined ||
  (mode !== 'admit' && mode !== 'retry') ||
  !(commandName in COMMANDS) ||
  (mode === 'retry' && sessionArgument === undefined)
) {
  process.stderr.write(
    'usage: steering-crash-child <storagePath> <markerPath> [admit|retry] [pause|model] [sessionId]\n',
  );
  process.exit(2);
}

const command = COMMANDS[commandName as keyof typeof COMMANDS];
const bureau = await createBureau({
  agents: {},
  generate: () => new Promise<never>(() => {}),
  toolbox: createToolbox([]),
  storage: { type: 'sqlite', path: storagePath },
  durableExecution: true,
});

let sessionId: string;
if (mode === 'retry') {
  await bureau.waitForRecovery?.();
  sessionId = sessionArgument ?? '';
} else {
  const run = await bureau.createRun({ message: 'Wait forever', principal: 'alice' });
  sessionId = run.sessionId;
  // Poll rather than sleep: the run must actually be live before a pause is
  // admissible, and a fixed delay would either be flaky or slow.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = await bureau.getSession(sessionId);
    if (session?.metadata['lastRunStatus'] === 'running') break;
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, 10));
  }
}

const outcome = await bureau.submitSteeringCommand(sessionId, command);

if (mode === 'admit' && outcome.outcome !== 'accepted') {
  process.stderr.write(`child: expected accepted, got ${outcome.outcome}\n`);
  process.exit(3);
}

// The parent reads this to learn the session id and the outcome. Written
// synchronously so it is on disk before the kill.
writeFileSync(markerPath, JSON.stringify({ sessionId, outcome }), 'utf8');

// No `bureau.dispose()`, deliberately. SIGKILL cannot be trapped, so no
// cleanup, no flush, no graceful close runs after this line.
process.kill(process.pid, 'SIGKILL');
