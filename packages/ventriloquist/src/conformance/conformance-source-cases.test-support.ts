import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

import { isAlive } from '../bun/bun-process.test-support.ts';
import { shellProfile } from '../bun/fixtures/bun-pipe-stdin.ts';
import { pidsIn } from '../bun/fixtures/terminal-output.ts';
import type { HostedProcess } from '../bun/process-types.ts';
import { createDeferred } from '../session/fixtures/deferred.ts';
import { createScriptedBackend } from '../session/fixtures/scripted-backend.ts';
import { DEFAULT_SESSION_BUDGETS, type OutputSource } from '../session/session-types.ts';
import {
  conclude,
  type CaseDefinition,
  type CaseLaunch,
} from './conformance-cases.test-support.ts';
import { check } from './conformance.test-support.ts';

/**
 * A real child whose standard output the cell hands to a session as a source. The session does
 * not own the child (a scripted backend stands in for the process owner), so what these cells
 * prove is what the session does to the sources it was given when it closes.
 */
function spawnPrinter() {
  return Bun.spawn(['sh', '-c', 'printf \'child=%s \' "$$"; exec sleep 7919'], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
}

type Printer = ReturnType<typeof spawnPrinter>;

/** What a wrapped reader or subscription saw the session do to it. */
type Observation = {
  canceled: boolean;
  released: boolean;
  unsubscribed: boolean;
  readonly cancelRequested: ReturnType<typeof createDeferred<void>>;
};

type SourceState = { readonly child: Printer; readonly observation: Observation };

function launchOver(child: Printer, source: OutputSource, observation: Observation): CaseLaunch {
  const hosted: HostedProcess = {
    mode: 'pipe',
    backend: createScriptedBackend({ mode: 'pipe' }),
    sources: [source],
    startFailure: undefined,
    // The session is started and then left running: this host's "process" never exits by itself.
    reportExitTo: async (receiver) => {
      await receiver.start();
    },
  };
  const state: SourceState = { child, observation };
  return {
    profile: shellProfile('true'),
    hosted,
    state,
    dispose: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}

function newObservation(): Observation {
  return {
    canceled: false,
    released: false,
    unsubscribed: false,
    cancelRequested: createDeferred<void>(),
  };
}

/** An owned stream over the child's output whose cancellation resolves, rejects or never settles. */
function ownedOver(child: Printer, cancel: 'resolve' | 'reject' | 'hang'): CaseLaunch {
  const observation = newObservation();
  const source: OutputSource = {
    kind: 'stream',
    channel: 'stdout',
    stream: {
      getReader: () => {
        const reader = child.stdout.getReader();
        return {
          read: () => reader.read(),
          releaseLock: () => {
            observation.released = true;
            reader.releaseLock();
          },
          cancel: async (reason?: unknown) => {
            observation.canceled = true;
            observation.cancelRequested.resolve();
            if (cancel === 'reject') throw new Error('the cancellation failed');
            if (cancel === 'hang') return new Promise<void>(() => undefined);
            await reader.cancel(reason);
          },
        };
      },
    },
  };
  return launchOver(child, source, observation);
}

/** A borrowed subscription over the child's output: unsubscribing must not stop the producer. */
function borrowedOver(child: Printer): CaseLaunch {
  const observation = newObservation();
  const reader = child.stdout.getReader();
  const source: OutputSource = {
    kind: 'subscription',
    channel: 'stdout',
    subscribe: (deliver, end) => {
      void (async () => {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            if (!observation.unsubscribed) end();
            return;
          }
          if (!observation.unsubscribed) deliver(result.value);
        }
      })();
      return () => {
        observation.unsubscribed = true;
      };
    },
  };
  return launchOver(child, source, observation);
}

const stateOf = (launched: CaseLaunch): SourceState => launched.state as SourceState;

async function stopAndConclude(context: Parameters<CaseDefinition['run']>[0]) {
  const { rig } = context;
  await rig.client.handshake();
  const { child } = pidsIn(await rig.client.waitForOutput(/child=\d+ /));
  rig.client.sendResult(rig.client.endpoint.terminate());
  return { child: child as number, ...(await conclude(rig)) };
}

const ownedRelease: CaseDefinition = {
  id: 'owned-source-release',
  modes: ['pipe'],
  launch: () => ownedOver(spawnPrinter(), 'resolve'),
  async run(context) {
    const { child, cleanup } = await stopAndConclude(context);
    const { observation } = stateOf(context.launched);
    return [
      check('the owned stream was canceled', observation.canceled),
      check('its reader was released', observation.released),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the session never owned the child, so it is still running', isAlive(child)),
    ];
  },
};

const borrowedUnsubscribe: CaseDefinition = {
  id: 'borrowed-source-unsubscribe',
  modes: ['pipe'],
  launch: () => borrowedOver(spawnPrinter()),
  async run(context) {
    const { child, cleanup } = await stopAndConclude(context);
    const { observation } = stateOf(context.launched);
    return [
      check('the subscription was unsubscribed', observation.unsubscribed),
      check(
        'the producer behind it was neither canceled nor released',
        !observation.canceled && !observation.released,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the producer keeps running', isAlive(child)),
    ];
  },
};

const failingCancellation: CaseDefinition = {
  id: 'failing-cancellation',
  modes: ['pipe'],
  launch: () => ownedOver(spawnPrinter(), 'reject'),
  async run(context) {
    const { cleanup } = await stopAndConclude(context);
    const summary = await context.rig.session().closed;
    return [
      check(
        'a rejected cancellation is incomplete, never complete',
        cleanup.outcome === 'incomplete',
      ),
      check('the slot is quarantined', summary.quarantined),
    ];
  },
};

const hangingCancellation: CaseDefinition = {
  id: 'hanging-cancellation',
  modes: ['pipe'],
  launch: () => ownedOver(spawnPrinter(), 'hang'),
  async run(context) {
    const { rig } = context;
    await rig.client.handshake();
    await rig.client.waitForOutput(/child=\d+ /);
    rig.client.sendResult(rig.client.endpoint.terminate());
    // Wait until the session has asked for the cancellation, then let the fake clock run out the
    // cleanup deadline: nothing else in this cell can end the wait.
    await stateOf(context.launched).observation.cancelRequested.promise;
    rig.clock.advance(DEFAULT_SESSION_BUDGETS.cleanupDeadlineMilliseconds);
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    return [
      check(
        'a cancellation that never settles is unknown at the deadline',
        cleanup.outcome === 'unknown',
      ),
      check('the slot is quarantined', summary.quarantined),
    ];
  },
};

export const SOURCE_CASES: readonly CaseDefinition[] = [
  ownedRelease,
  borrowedUnsubscribe,
  failingCancellation,
  hangingCancellation,
];
