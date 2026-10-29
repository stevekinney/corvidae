/**
 * COR-1481 — the child half of the task-record SIGKILL tests.
 *
 * Usage: `bun task-record-crash-child.ts <settlement|admission> <sqlitePath> <markerPath>`
 *
 * Stands up a durable Bureau over a storage wrapper that holds one kind of task-record write
 * for ever, then kills the process with SIGKILL once the durable state has gone as far as the
 * crash window needs:
 *
 * - `settlement`: a task finishes, and its durable workflow is `completed`, while the write that
 *   records its settlement on the task is still held.
 * - `admission`: a task of an asking agent, in a named context, is started while the write that
 *   records its admission is held. `tasks.start` writes that record before anything of the run
 *   starts, so the start waits on it; the task's id is read from the held write's key.
 *
 * No `dispose()`, no `shutdown()`, no flush: whatever the next process finds was on disk
 * before this one died. Not a test file: it is spawned by `task-record-crash.slow.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { stopWhen, createAgent } from '@lostgradient/operative';
import { BunSQLiteStorage } from '@lostgradient/weft';
import { type Storage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';

import { createBureau } from '../create-bureau';
import { createAskingAgent, finishes } from './task-record-crash-agent';
import type { AgentDefinitions } from '../agent-catalog';

const [mode, storagePath, markerPath] = process.argv.slice(2);

if (
  (mode !== 'settlement' && mode !== 'admission' && mode !== 'parked') ||
  storagePath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: task-record-crash-child <settlement|admission|parked> <path> <marker>\n',
  );
  process.exit(2);
}

let held = false;
/** The held write's arguments as text, once it is held. */
let heldText: string | undefined;
const CONTEXT_ID = 'crash-context';
/** The arguments of a storage call as text, values (stored as bytes) decoded. */
const textOf = (args: readonly unknown[]): string =>
  JSON.stringify(args, (_key, value: unknown) =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
  );
const holdsThisWrite = (args: readonly unknown[]): boolean => {
  const text = textOf(args);
  if (mode === 'parked' || !text.includes('bureau-task:v1:')) return false;
  return mode === 'settlement' ? text.includes('\\"settled\\"') : text.includes('\\"history\\"');
};

const raw = new BunSQLiteStorage(storagePath);
const storage = new Proxy(raw, {
  get(target, property) {
    const member = Reflect.get(target, property, target) as unknown;
    if (typeof member !== 'function') return member;
    return (...args: unknown[]) => {
      if (typeof property === 'string' && !held && holdsThisWrite(args)) {
        held = true;
        heldText = textOf(args);
        return new Promise<never>(() => undefined);
      }
      return (member as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as Storage;

const bureau = await createBureau<AgentDefinitions>({
  id: 'task-record-crash',
  agents: {
    asker: createAskingAgent(),
    default: createAgent({
      generate: finishes,
      toolbox: createToolbox([]),
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    }),
  },
  storage,
  durable: true,
  durableOwnership: { ownership: 'none' },
});

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const kill = (runId: string): never => {
  // Written synchronously so it is on disk before the kill.
  writeFileSync(markerPath, JSON.stringify({ runId }), 'utf8');
  process.kill(process.pid, 'SIGKILL');
  return undefined as never;
};

if (mode === 'settlement') {
  const run = await bureau.tasks.start('default', 'finish me', { principal: 'api-key:alice' });
  for (;;) {
    const durable = await bureau.tasks.workflow(run.id);
    if (held && durable?.status === 'completed') kill(run.id);
    await sleep(10);
  }
} else if (mode === 'parked') {
  // Holds no write: the task parks on its human wait, and the process dies there.
  const run = await bureau.tasks.start('asker', 'which environment?', {
    principal: 'api-key:alice',
    contextId: CONTEXT_ID,
  });
  for (;;) {
    if (bureau.reviews.list().some((review) => review.runId === run.id)) kill(run.id);
    await sleep(10);
  }
} else {
  // Not awaited: the start waits on the held admission write for ever.
  void bureau.tasks.start('asker', 'which environment?', {
    principal: 'api-key:alice',
    contextId: CONTEXT_ID,
  });
  for (;;) {
    // The held write is this task's admission: it names the context and carries the message.
    const admission =
      heldText?.includes(CONTEXT_ID) === true && heldText.includes('which environment?')
        ? heldText
        : undefined;
    const taskId =
      admission === undefined ? undefined : /bureau-task:v1:([^"\\]+)/u.exec(admission)?.[1];
    if (taskId !== undefined) kill(taskId);
    await sleep(10);
  }
}
