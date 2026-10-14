/**
 * Durable steering recovery that fails partway, after the desired-state
 * snapshot has already been restored into the session's gate.
 *
 * The first Bureau steers a session and leaves its snapshot behind. A second
 * Bureau with the same id (a restart) opens the same store through a wrapper
 * that fails exactly one storage call right after the snapshot is read — the
 * mailbox drain that follows the restore. That admission must fail closed,
 * and the next one must recover from scratch rather than trying to restore
 * into the gate the failed attempt had already used.
 */
import { MemoryStorage, type Storage } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';

/** Fails the first storage call made after the steering snapshot is read. */
function failOnceAfterSnapshotRead(storage: Storage): { storage: Storage; arm(): void } {
  let armed = false;
  let tripped = false;
  const wrapped = new Proxy(storage, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...parameters: unknown[]) => {
        if (tripped) {
          tripped = false;
          throw new Error('injected storage failure');
        }
        const result: unknown = Reflect.apply(value, target, parameters);
        if (
          armed &&
          property === 'get' &&
          typeof parameters[0] === 'string' &&
          parameters[0].includes('steering-desired-state')
        ) {
          armed = false;
          tripped = true;
        }
        return result;
      };
    },
  });
  return {
    storage: wrapped,
    arm() {
      armed = true;
    },
  };
}

async function openBureau(storage: Storage) {
  return createBureau({
    id: 'restarting-bureau',
    agents: {},
    generate: () => new Promise<never>(() => {}),
    toolbox: createToolbox([]),
    storage,
    durableExecution: true,
  });
}

describe('durable steering recovery failure', () => {
  it('fails closed, then recovers from scratch on the next admission', async () => {
    const backend = new MemoryStorage();
    const first = await openBureau(backend);
    const faulty = failOnceAfterSnapshotRead(backend);
    let second: Awaited<ReturnType<typeof openBureau>> | undefined;

    try {
      const run = await first.createRun({ message: 'Wait forever', principal: 'alice' });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const session = await first.getSession(run.sessionId);
        if (session?.metadata['lastRunStatus'] === 'running') break;
        await Bun.sleep(10);
      }
      const steered = await first.submitSteeringCommand(run.sessionId, {
        id: 'steer',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(steered.outcome).toBe('accepted');

      second = await openBureau(faulty.storage);
      await second.waitForRecovery?.();
      faulty.arm();

      const probe = {
        id: 'probe',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      } as const;
      await expect(second.submitSteeringCommand(run.sessionId, probe)).rejects.toThrow(
        /injected storage failure/,
      );

      const retried = await second.submitSteeringCommand(run.sessionId, probe);
      expect(retried.outcome).toBe('accepted');
      if (retried.outcome !== 'accepted') throw new Error('expected accepted');
      // The restored model, at the version the first Bureau reported.
      expect(retried.command.configVersion).toBe(1);
    } finally {
      await second?.dispose();
      await first.dispose();
      backend[Symbol.dispose]();
    }
  }, 60_000);
});
