/**
 * COR-1481 — the child half of the task-record SIGKILL tests.
 *
 * Usage: `bun task-record-crash-child.ts settlement <sqlitePath> <markerPath>`
 *
 * Stands up a durable Bureau over a storage wrapper that holds the task-record write that
 * records a settlement for ever, then kills the process with SIGKILL once the task's durable
 * workflow is `completed`.
 *
 * No `dispose()`, no `shutdown()`, no flush: whatever the next process finds was on disk
 * before this one died. Not a test file: it is spawned by `task-record-crash.slow.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { stopWhen, createAgent } from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { createToolbox } from 'armorer';

import { createBureau } from '../create-bureau';
import { finishes } from './task-record-crash-agent';
import type { AgentDefinitions } from '../agent-catalog';

const [mode, storagePath, markerPath] = process.argv.slice(2);

if (mode !== 'settlement' || storagePath === undefined || markerPath === undefined) {
  process.stderr.write('usage: task-record-crash-child settlement <path> <marker>\n');
  process.exit(2);
}

let held = false;
/** The arguments of a storage call as text, values (stored as bytes) decoded. */
const textOf = (args: readonly unknown[]): string =>
  JSON.stringify(args, (_key, value: unknown) =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
  );
const holdsThisWrite = (args: readonly unknown[]): boolean => {
  const text = textOf(args);
  if (!text.includes('bureau-task:v1:')) return false;
  return text.includes('\\"settled\\"');
};

const raw = await resolveStorage({ type: 'sqlite', path: storagePath });
const storage = new Proxy(raw, {
  get(target, property) {
    const member = Reflect.get(target, property, target) as unknown;
    if (typeof member !== 'function') return member;
    return (...args: unknown[]) => {
      if (typeof property === 'string' && !held && holdsThisWrite(args)) {
        held = true;
        return new Promise<never>(() => undefined);
      }
      return (member as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as Storage;

const bureau = await createBureau<AgentDefinitions>({
  id: 'task-record-crash',
  agents: {
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

const run = await bureau.tasks.start('default', 'finish me', { principal: 'api-key:alice' });
for (;;) {
  const durable = await bureau.tasks.workflow(run.id);
  if (held && durable?.status === 'completed') kill(run.id);
  await sleep(10);
}
