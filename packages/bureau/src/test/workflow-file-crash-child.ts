/**
 * COR-1527 — the child half of the workflow file crash tests.
 *
 * Usage: `bun workflow-file-crash-child.ts <mode> <storagePath> <workflowsPath> <markerPath>`
 *
 * `parked`: stands up a durable Bureau over a workflow directory holding `sleeper.json` (a sleep,
 * then an agent step), `waiter.json` (an await-signal, then an agent step), and `midstep.json` (an
 * agent step whose agent never answers), starts one instance of each, lets every one reach the
 * place it waits at, writes the marker, and kills itself with SIGKILL. The parent then edits one
 * file, deletes another, and boots a Bureau over the same store.
 *
 * `claim`: starts one instance of `claimed.json` (one agent step) with the storage wrapped so that
 * the process kills itself the instant the step's run has its recovery record claimed and before
 * the run is started: the window between the claim and the start.
 *
 * Not a test file: it is spawned by `workflow-file-crash.slow.test.ts`.
 */
import { writeFileSync } from 'node:fs';

import { createAgent } from '@lostgradient/operative';
import { BunSQLiteStorage } from '@lostgradient/weft';
import { type Storage } from '@lostgradient/storage';

import { createBureau } from '../create-bureau';
import { CLAIM_RENEW_MS, CLAIM_TTL_MS } from './process-crash-work-integrity-fixtures';
import type { AgentDefinitions } from '../agent-catalog';
import { workflowFileDirectory } from '../sources/workflow-file-directory';

const [mode, storagePath, workflowsPath, markerPath] = process.argv.slice(2);
if (
  (mode !== 'parked' && mode !== 'claim') ||
  storagePath === undefined ||
  workflowsPath === undefined ||
  markerPath === undefined
) {
  process.stderr.write(
    'usage: workflow-file-crash-child <parked|claim> <storagePath> <workflowsPath> <markerPath>\n',
  );
  process.exit(2);
}

const KILL_CLAIM_PREFIX = 'bureau-catalog-run:workflow-agent-';

/** A storage that kills the process right after a write that claims a workflow step's run. */
function killingAfterStepClaim(raw: Storage): Storage {
  return new Proxy(raw, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function' || typeof property !== 'string') return member;
      return (...args: unknown[]) => {
        const result = (member as (...a: unknown[]) => unknown).apply(target, args);
        const text = JSON.stringify(args, (_key, value) =>
          value instanceof Uint8Array ? undefined : (value as unknown),
        );
        if (mode !== 'claim' || !text.includes(KILL_CLAIM_PREFIX)) return result;
        return Promise.resolve(result).then((settled) => {
          process.kill(process.pid, 'SIGKILL');
          return settled;
        });
      };
    },
  });
}

let midstepStarted = false;
const bureau = await createBureau<AgentDefinitions>({
  agents: {
    writer: createAgent({
      name: 'writer',
      generate: async ({ conversation }) => {
        const message = conversation.getMessages().findLast((entry) => entry.role === 'user');
        const text = typeof message?.content === 'string' ? message.content : '';
        if (mode === 'parked' && text.startsWith('midstep')) {
          midstepStarted = true;
          return new Promise<never>(() => {});
        }
        return { content: `answered: ${text.split('\n')[0]}`, toolCalls: [] };
      },
    }),
  },
  workflowSource: workflowFileDirectory(workflowsPath),
  storage: killingAfterStepClaim(new BunSQLiteStorage(storagePath)),
  durable: true,
  durableOwnership: {
    ownership: 'workflow-lease',
    workflowClaimTtlMs: CLAIM_TTL_MS,
    workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
  },
});

const engine = bureau.durableEngine();
if (engine === undefined) throw new Error('child: no durable engine');

async function until(label: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await ready()) return;
    if (attempt > 4000) {
      process.stderr.write(`child: ${label} never happened\n`);
      process.exit(3);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function parkedOn(workflowId: string, operationType: string): Promise<boolean> {
  const timeline = await engine!.getTimeline(workflowId);
  return timeline.some((entry) => entry.operationType === operationType);
}

if (mode === 'claim') {
  // Written before the start: the kill lands inside it.
  writeFileSync(markerPath, JSON.stringify({ instances: ['claimed-run'] }), 'utf8');
  await engine.start('claimed', { kind: 'schedule', scheduleId: 'manual' }, { id: 'claimed-run' });
  await new Promise<never>(() => {});
}

await engine.start('sleeper', null, { id: 'sleeper-run' });
await engine.start('waiter', null, { id: 'waiter-run' });
await engine.start('midstep', null, { id: 'midstep-run' });
await until('the sleeper to sleep', () => parkedOn('sleeper-run', 'sleep'));
await until('the waiter to wait', () => parkedOn('waiter-run', 'wait-signal'));
await until('the midstep agent to start', () => midstepStarted);

// Written synchronously so it is on disk before the kill. No `dispose()`, deliberately.
writeFileSync(
  markerPath,
  JSON.stringify({ instances: ['sleeper-run', 'waiter-run', 'midstep-run'] }),
  'utf8',
);
process.kill(process.pid, 'SIGKILL');
