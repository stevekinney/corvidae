/**
 * COR-424, COR-1795 — the child half of the run-creation fault-point test
 * (`run-creation-fault-points.test.ts`).
 *
 * Usage: `bun run-creation-crash-child.ts <scenario> <sqlite|lmdb> <storagePath> <markerPath>`
 *
 * Stands up Bureau A, the process that fails: a durable Bureau over the store at `storagePath`,
 * whose storage handle is wrapped so that the process "dies" at the first write the scenario names.
 * From that write on, no write the process makes reaches the backend: each stays unsettled forever.
 * Once the crash point is reached the child records what its Bureau observed in the marker file,
 * synchronously, and kills itself with SIGKILL. There is no `dispose()` or `shutdown()`: a graceful
 * dispose would cancel the durable run, which a crash does not.
 *
 * It constructs its own storage handle on the path its parent passes, as every crash child does, so
 * the parent holds exactly one handle on the path, Bureau B's, opened only after this process is
 * gone: LMDB must not have two handles on one path in one process.
 *
 * Not a test file: it is spawned by `run-creation-fault-points.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import type { BatchOperation, Storage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { LMDBStorage } from '@lostgradient/storage-lmdb';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { decode } from '@lostgradient/weft';
import { createToolbox, type Tool } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import type { Bureau, BureauDiagnostic } from '../types';
import {
  type FaultMarker,
  type FaultScenario,
  FAULT_SCENARIOS,
  REQUEST,
} from './run-creation-fault-fixtures';
import { startTaskFrom } from './task-start-request.ts';

const LEDGER_ENTRY_PREFIX = 'command-ledger:v1:entry:';
const POLL_DELAY_MS = 5;
const runtime = createDefaultRuntimeServices();

const scenarioName = process.argv[2];
const backend = process.argv[3];
const storagePath = process.argv[4];
const markerPath = process.argv[5];

if (
  scenarioName === undefined ||
  !(FAULT_SCENARIOS as readonly string[]).includes(scenarioName) ||
  (backend !== 'sqlite' && backend !== 'lmdb') ||
  storagePath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: run-creation-crash-child <scenario> <sqlite|lmdb> <storagePath> <markerPath>\n',
  );
  process.exit(2);
}

/**
 * Condition poll with a tiny real delay (LMDB starves a zero-delay loop). It is unbounded: the
 * parent owns the deadline and kills this process there.
 */
async function pollUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for await (const _turn of awakeTurns()) {
    if (await check()) return;
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, POLL_DELAY_MS));
  }
}

/** One key/value a storage call was about to write. */
interface PendingWrite {
  readonly key: string;
  readonly text: string;
  readonly value: Uint8Array;
}

const decoder = new TextDecoder();

function writesOf(verb: string, args: readonly unknown[]): PendingWrite[] {
  if (verb === 'put') {
    const value = args[1] as Uint8Array;
    return [{ key: args[0] as string, text: decoder.decode(value), value }];
  }
  const operations = verb === 'batch' ? args[0] : verb === 'conditionalBatch' ? args[1] : undefined;
  if (!Array.isArray(operations)) return [];
  return (operations as BatchOperation[]).flatMap((operation) =>
    operation.type === 'put'
      ? [{ key: operation.key, text: decoder.decode(operation.value), value: operation.value }]
      : [],
  );
}

/** Where the crash falls relative to the write that triggers it. */
type CrashPoint = 'before-write' | 'after-write';

/** A storage handle whose process dies at the first write matching a trigger. */
interface CrashingStorage {
  readonly storage: Storage;
  crashed(): boolean;
}

const WRITE_VERBS = new Set<PropertyKey>([
  'put',
  'delete',
  'batch',
  'conditionalBatch',
  'deletePrefix',
  'deleteRange',
]);

/**
 * Wraps `storage` so the process dies at the first write matching `trigger`: with `before-write`
 * that write never reaches the backend, and with `after-write` it lands and the process dies as it
 * returns. From then on no write the process makes reaches the backend; each stays unsettled
 * forever. Reads pass through, since they cannot change what a later process finds.
 */
function crashOnWrite(
  storage: Storage,
  trigger: (write: PendingWrite) => boolean,
  point: CrashPoint,
  landsFirst?: (write: PendingWrite) => boolean,
): CrashingStorage {
  let crashed = false;
  let crashing = false;
  let resolveLanded: () => void = () => {};
  const landed =
    landsFirst === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          resolveLanded = resolve;
        });
  const wrapped = new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (!WRITE_VERBS.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        const writes = writesOf(String(property), args);
        if (!crashed && !crashing && writes.some(trigger)) {
          // The process dies here, but only once a write that must precede the crash has landed;
          // other writes go through meanwhile.
          crashing = true;
          const written =
            point === 'after-write' ? await Reflect.apply(value, target, args) : undefined;
          await landed;
          crashed = true;
          if (point === 'after-write') return written;
        }
        if (!crashed) {
          const written: unknown = await Reflect.apply(value, target, args);
          if (landsFirst !== undefined && writes.some(landsFirst)) resolveLanded();
          return written;
        }
        return new Promise(() => {});
      };
    },
  });
  return { storage: wrapped, crashed: () => crashed };
}

/**
 * COR-297 — the write that launches the run: its workflow record moving from `pending` to
 * `running`. `createRun` acknowledges a run once `prepare()` commits it, before it launches, so a
 * scenario about a run that has started work waits for this write before its process dies.
 */
function runLaunched(write: PendingWrite): boolean {
  if (!write.key.startsWith('wf:')) return false;
  try {
    const record = decode(write.value);
    return (
      typeof record === 'object' && record !== null && Reflect.get(record, 'status') === 'running'
    );
  } catch {
    return false;
  }
}

function ledgerWriteIn(state: 'pending' | 'completed'): (write: PendingWrite) => boolean {
  return (write) => {
    if (!write.key.startsWith(LEDGER_ENTRY_PREFIX)) return false;
    try {
      return (JSON.parse(write.text) as { state?: unknown }).state === state;
    } catch {
      return false;
    }
  };
}

/** A generate held at every call, so a run stays in flight until the process dies. */
const heldGenerate: GenerateFunction = () => new Promise<never>(() => {});

interface CrashPlan {
  readonly trigger: (write: PendingWrite) => boolean;
  readonly point: CrashPoint;
  readonly landsFirst?: (write: PendingWrite) => boolean;
}

/** Where each scenario's process dies. */
const PLANS: Record<FaultScenario, CrashPlan> = {
  // The crash lands before the claim is written: no entry, no run.
  'crash-before-claim': { trigger: ledgerWriteIn('pending'), point: 'before-write' },
  // The claim lands and the process dies as it returns: the entry exists, pending, and names a
  // run that never reached the engine.
  'after-claim': { trigger: ledgerWriteIn('pending'), point: 'after-write' },
  // The run is durably started, but the process dies before the ledger records it.
  'after-work-start': {
    trigger: ledgerWriteIn('completed'),
    point: 'before-write',
    landsFirst: runLaunched,
  },
  // `createRun` acknowledges a run once `prepare()` commits it. The process dies as the ledger
  // records that, before the run launches.
  'after-prepare-before-launch': { trigger: ledgerWriteIn('completed'), point: 'before-write' },
  // The process dies as the ledger records the run, before the caller hears back.
  'after-effect-before-ack': {
    trigger: ledgerWriteIn('completed'),
    point: 'after-write',
    landsFirst: runLaunched,
  },
  // The crash interrupts cancellation cleanup: the run's terminal session write, which follows
  // the durable cancellation.
  'during-cancellation': {
    trigger: (write) => write.text.includes('"lastRunStatus":"aborted"'),
    point: 'before-write',
  },
};

function openStorage(): Storage {
  return backend === 'lmdb'
    ? new LMDBStorage(storagePath as string)
    : new BunSQLiteStorage(storagePath);
}

async function durableRunIds(bureau: Bureau): Promise<string[] | undefined> {
  const page = await bureau.tasks.workflows();
  return page?.items.map((run) => run.id);
}

function crashedOrDie(crash: CrashingStorage): void {
  if (crash.crashed()) return;
  process.stderr.write('child: the scenario ended before its crash point\n');
  process.exit(4);
}

const plan = PLANS[scenarioName as FaultScenario];
const crash = crashOnWrite(openStorage(), plan.trigger, plan.point, plan.landsFirst);
// A dead process reports nothing: its writes never settle. Anything it does report is a defect, and
// the parent asserts there is none.
const diagnostics: BureauDiagnostic[] = [];
const bureau = await createBureau<AgentDefinitions>({
  onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  agents: {
    default: createAgent({
      generate: heldGenerate,
      toolbox: createToolbox<readonly Tool[]>([]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage: crash.storage,
  durable: true,
  durableOwnership: { ownership: 'none' },
});

const marker: { -readonly [Key in keyof FaultMarker]: FaultMarker[Key] } = { diagnostics: [] };

switch (scenarioName as FaultScenario) {
  case 'crash-before-claim':
  case 'after-claim':
  case 'after-work-start':
  case 'after-prepare-before-launch': {
    startTaskFrom(bureau, REQUEST).catch(() => {});
    await pollUntil(() => crash.crashed());
    marker.runIds = await durableRunIds(bureau);
    break;
  }
  case 'after-effect-before-ack': {
    const unacknowledged = await startTaskFrom(bureau, REQUEST);
    crashedOrDie(crash);
    marker.started = { id: unacknowledged.id, receipt: unacknowledged.receipt };
    break;
  }
  case 'during-cancellation': {
    const created = await startTaskFrom(bureau, REQUEST);
    await bureau.tasks.cancel(created.id);
    await pollUntil(async () => {
      if (!crash.crashed()) return false;
      const durable = await bureau.tasks.workflow(created.id);
      return durable?.status === 'cancelled';
    });
    marker.started = { id: created.id, receipt: created.receipt };
    break;
  }
}

// Written synchronously so it is on disk before the kill.
writeFileSync(
  markerPath,
  JSON.stringify({ ...marker, diagnostics: diagnostics.map((diagnostic) => diagnostic.message) }),
  'utf8',
);
// No `bureau.dispose()` / `shutdown()`, deliberately: SIGKILL cannot be trapped.
process.kill(process.pid, 'SIGKILL');
