/**
 * COR-1946 — the child half of the SIGKILL test for a stalled owner whose real result replaced
 * `owner-lost`.
 *
 * Usage: `bun owner-lost-replaced-crash-child.ts <completed|canceled> <sqlitePath> <markerPath>`
 *
 * Stands up a Bureau with no durable engine, starts a task whose run waits to be released, and does
 * what a peer would do to a stalled owner: settles the task `owner-lost` through the registry, once
 * the lease it names is read, and writes that failure's notification. Then it holds the next
 * write to a notification record for ever, ends the run for real (completed, or canceled), and
 * kills itself with SIGKILL once the held write is reached: the replacing settlement, and the
 * outbox entry it wrote, are on disk; the dismissal of the false failure is not.
 *
 * Not a test file: it is spawned by `owner-lost-replaced-crash.slow.test.ts`.
 */
import { createAgent, stopWhen } from '@lostgradient/operative';
import { type Storage, textValueStore } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createToolbox } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { processLeaseKey } from '../process-lease';
import { publishChildFile } from './child-output-file';

const [mode, storagePath, markerPath] = process.argv.slice(2);
if ((mode !== 'completed' && mode !== 'canceled') || !storagePath || !markerPath) {
  process.stderr.write(
    'usage: owner-lost-replaced-crash-child <completed|canceled> <path> <marker>\n',
  );
  process.exit(2);
}

const OWNER = 'api-key:alice';
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const textOf = (args: readonly unknown[]): string =>
  JSON.stringify(args, (_key, value: unknown) =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
  );

let holding = false;
let held = false;
const raw = new BunSQLiteStorage(storagePath);
const storage = new Proxy(raw, {
  get(target, property) {
    const member = Reflect.get(target, property, target) as unknown;
    if (typeof member !== 'function' || typeof property !== 'string') return member;
    return (...args: unknown[]) => {
      const text = textOf(args);
      if (
        holding &&
        !held &&
        !['get', 'scan', 'has', 'capabilities', 'list', 'keys'].includes(property) &&
        text.includes('bureau-notification:v1:r:')
      ) {
        held = true;
        return new Promise<never>(() => undefined);
      }
      return (member as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as Storage;

let release = (): void => undefined;
const released = new Promise<void>((resolve) => {
  release = resolve;
});

const bureau = await createBureau<AgentDefinitions>({
  agents: {
    default: createAgent({
      generate: ({ signal }) =>
        new Promise((resolve, reject) => {
          void released.then(() => resolve({ content: 'done', toolCalls: [] }));
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      toolbox: createToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage,
  durable: false,
  maintenance: 'manual',
});

const run = await bureau.tasks.start('default', 'work', { principal: OWNER });
const registry = bureau.internals.taskRegistry;
const record = await registry.record(run.id);
const ownerProcess = record?.ownerProcess ?? '';
const leaseKey = processLeaseKey(ownerProcess);
const lease = await textValueStore(raw).get(leaseKey);
// The peer's inference: this process's lease "lapsed", so its task is settled `owner-lost`.
const outcome = await registry.settleAbandoned(
  run.id,
  ownerProcess,
  { key: leaseKey, expected: lease },
  {
    at: new Date().toISOString(),
    status: 'failed',
    finishReason: 'owner-lost',
    message: 'The process that was running this task stopped before it finished.',
  },
);
if (outcome !== 'written') {
  process.stderr.write(`the owner-lost settlement was ${outcome}\n`);
  process.exit(3);
}
// What the peer's boot writes for that settlement. This process still holds the live run, so its
// own notifications would read the task as working and write nothing: write it as the peer would.
await bureau.notifications.create({
  owner: OWNER,
  kind: 'run.failed',
  title: 'default failed',
  dedupeKey: `run.settled:${run.id}`,
  subject: { runId: run.id },
});

holding = true;
if (mode === 'canceled') await bureau.tasks.cancel(run.id);
else release();
while (!held) await sleep(10);
// Written synchronously, so it is on disk before the kill.
publishChildFile(markerPath, JSON.stringify({ runId: run.id }));
process.kill(process.pid, 'SIGKILL');
await new Promise<never>(() => undefined);
