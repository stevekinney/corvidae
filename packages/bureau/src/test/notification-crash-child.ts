/**
 * COR-1945 — the child half of the failure-notification crash tests.
 *
 * Usage: `bun notification-crash-child.ts <mode> <sqlitePath> <markerPath>`
 *
 * Stands up a durable Bureau over a storage wrapper that interferes with one write of the
 * notification path, runs one task, and kills the process with SIGKILL once the durable state has
 * gone as far as the crash window needs:
 *
 * - `before-notification-write`: a failing run settles, and the write of its notification is held
 *   for ever. The settlement is on disk; the notification is not.
 * - `failing-notification-write`: a failing run settles, and the write of its notification
 *   rejects (a storage error). The process dies after the rejection.
 * - `before-outbox-clear`: a failing run settles and its notification is written; the delete of its
 *   outbox entry is held for ever.
 * - `after-both`: a failing run settles, its notification is written and its outbox entry cleared.
 * - `completed-run`: a run that completes settles; there is nothing to notify.
 *
 * No `dispose()`, no `shutdown()`, no flush: whatever the next process finds was on disk before
 * this one died. Not a test file: it is spawned by `notification-crash-recovery.slow.test.ts`.
 */
import { publishChildFile } from './child-output-file';

import { stopWhen, createAgent } from '@lostgradient/operative';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { type Storage, textValueStore } from '@lostgradient/storage';
import { createToolbox } from 'armorer';

import { createBureau } from '../create-bureau';
import { failsToGenerate, finishes } from './notification-crash-agents';
import type { AgentDefinitions } from '../agent-catalog';

const MODES = [
  'before-notification-write',
  'failing-notification-write',
  'before-outbox-clear',
  'after-both',
  'completed-run',
] as const;
type Mode = (typeof MODES)[number];

const [modeArgument, storagePath, markerPath] = process.argv.slice(2);
const mode = MODES.find((candidate) => candidate === modeArgument);
if (mode === undefined || storagePath === undefined || markerPath === undefined) {
  process.stderr.write(`usage: notification-crash-child <${MODES.join('|')}> <path> <marker>\n`);
  process.exit(2);
}

const OWNER = 'api-key:alice';
const NOTIFICATION_RECORD_PREFIX = 'bureau-notification:v1:';
const OUTBOX_PREFIX = 'bureau-notification:v1:o:';

/** The arguments of a storage call as text, values (stored as bytes) decoded. */
const textOf = (args: readonly unknown[]): string =>
  JSON.stringify(args, (_key, value: unknown) =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
  );
const READS = new Set(['get', 'scan', 'has', 'capabilities', 'list']);
/** Whether the call writes a notification record or its dedupe index (not the outbox). */
const writesNotification = (property: string, text: string): boolean =>
  !READS.has(property) &&
  text.includes(NOTIFICATION_RECORD_PREFIX) &&
  !text.includes(OUTBOX_PREFIX);
/** Whether the call deletes an outbox entry. */
const clearsOutbox = (property: string, text: string): boolean =>
  property === 'delete' && text.includes(OUTBOX_PREFIX);

let interfered = false;
const raw = new BunSQLiteStorage(storagePath);
const storage = new Proxy(raw, {
  get(target, property) {
    const member = Reflect.get(target, property, target) as unknown;
    if (typeof member !== 'function' || typeof property !== 'string') return member;
    return (...args: unknown[]) => {
      const text = textOf(args);
      if (
        !interfered &&
        mode === 'before-notification-write' &&
        writesNotification(property, text)
      ) {
        interfered = true;
        return new Promise<never>(() => undefined);
      }
      if (
        !interfered &&
        mode === 'failing-notification-write' &&
        writesNotification(property, text)
      ) {
        interfered = true;
        return Promise.reject(new Error('the notification write failed'));
      }
      if (!interfered && mode === 'before-outbox-clear' && clearsOutbox(property, text)) {
        interfered = true;
        return new Promise<never>(() => undefined);
      }
      return (member as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as Storage;

const bureau = await createBureau<AgentDefinitions>({
  id: 'notification-crash',
  agents: {
    default: createAgent({
      generate: finishes,
      toolbox: createToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
    }),
    failing: createAgent({
      generate: failsToGenerate,
      toolbox: createToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage,
  durable: true,
  durableOwnership: { ownership: 'none' },
  // The injected storage error is diagnosed by design.
  onDiagnostic: () => undefined,
});

const direct = textValueStore(raw);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const kill = (runId: string): never => {
  // Written synchronously so it is on disk before the kill.
  publishChildFile(markerPath, JSON.stringify({ runId }));
  process.kill(process.pid, 'SIGKILL');
  return undefined as never;
};

const run = await bureau.tasks.start(mode === 'completed-run' ? 'default' : 'failing', 'go', {
  principal: OWNER,
});
const crashReady = async (current: Mode): Promise<boolean> => {
  const record = await bureau.internals.taskRegistry.record(run.id);
  if (record?.settled === undefined) return false;
  const owedKeys = await direct.list(OUTBOX_PREFIX);
  const page = await bureau.notifications.list({ owner: OWNER });
  const owed = owedKeys.length;
  const written = page.notifications.length;
  switch (current) {
    case 'before-notification-write':
    case 'failing-notification-write':
    case 'before-outbox-clear':
      return interfered;
    case 'after-both':
      return written === 1 && owed === 0;
    case 'completed-run':
      // Settled; give a notification it must not write time to appear.
      return written === 0 && owed === 0;
  }
};
for (;;) {
  if (await crashReady(mode)) {
    // `before-outbox-clear` is ready once the delete is held, with the notification written.
    if (mode === 'completed-run') await sleep(100);
    kill(run.id);
  }
  await sleep(10);
}
