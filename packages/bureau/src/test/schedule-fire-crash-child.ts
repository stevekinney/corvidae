/**
 * COR-409 — the child half of the schedule-fire SIGKILL test.
 *
 * Usage: `bun schedule-fire-crash-child.ts <sqlite|lmdb> <storagePath> <markerPath>`
 *
 * Stands up a real durable Bureau whose engine timers are driven by hand
 * (`durableBackgroundTasks: 'manual'`), registers a recurring interval
 * schedule, and drives it to its first occurrence with
 * `bureau.runDurableMaintenance(occurrence)`, which is `engine.scheduler.tick`
 * under the hood. No real time elapses and no poller runs.
 *
 * The fire's agent body is the kill point. Once it is inside `generate`, so the
 * fire has begun and cannot complete, it reads the schedule record (which
 * already names the fire's workflow), writes the marker synchronously, and
 * kills the process with SIGKILL. No `dispose()`, no `shutdown()`, no flush:
 * whatever the next process finds was on disk before this one died.
 *
 * Not a test file: it is spawned by `schedule-fire-crash-recovery.slow.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createToolbox } from 'armorer';

import { createBureau } from '../create-bureau';

const [backend, storagePath, markerPath] = process.argv.slice(2);

if (
  (backend !== 'sqlite' && backend !== 'lmdb') ||
  storagePath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: schedule-fire-crash-child <sqlite|lmdb> <storagePath> <markerPath>\n',
  );
  process.exit(2);
}

let scheduleId: string | undefined;
let occurrence: number | undefined;

const bureau = await createBureau({
  agents: {},
  generate: async () => {
    const summary = scheduleId === undefined ? undefined : await bureau.getSchedule(scheduleId);
    if (
      scheduleId === undefined ||
      occurrence === undefined ||
      summary?.currentWorkflowId === undefined
    ) {
      process.stderr.write('child: the fire began without a recorded schedule fire\n');
      process.exit(3);
    }
    // Written synchronously so it is on disk before the kill.
    writeFileSync(
      markerPath,
      JSON.stringify({ scheduleId, occurrence, fireId: summary.currentWorkflowId }),
      'utf8',
    );
    // No `bureau.dispose()`, deliberately. SIGKILL cannot be trapped.
    process.kill(process.pid, 'SIGKILL');
    return new Promise<never>(() => {});
  },
  toolbox: createToolbox([]),
  storage: { type: backend, path: storagePath },
  durableExecution: true,
  durableBackgroundTasks: 'manual',
  // One process per store: a restart must not wait out a dead holder's claim.
  durableOwnership: { ownership: 'none' },
});

const created = await bureau.createSchedule({
  agentName: 'researcher',
  input: 'crash during this fire',
  spec: '1m',
});
const firstOccurrence = created?.nextFireAt;
if (created === undefined || firstOccurrence === null || firstOccurrence === undefined) {
  process.stderr.write('child: the schedule has no first occurrence\n');
  process.exit(3);
}
scheduleId = created.id;
occurrence = firstOccurrence;

await bureau.runDurableMaintenance(firstOccurrence);

// The tick launches the fire and returns before its body runs. The process now
// waits to be killed from inside `generate`; if no fire is in flight the event
// loop drains and Bun exits non-zero, which the parent reports as a failed premise.
await new Promise<never>(() => {});
