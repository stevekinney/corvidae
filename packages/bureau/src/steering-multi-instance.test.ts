/**
 * Durable steering with two live Bureau processes over one backend.
 *
 * Both Bureaus run in this process but share nothing except the SQLite file,
 * which is all two real processes would share. Each admits to the same
 * session, folds the other's appends before deciding, and so agrees with it
 * on versions, command states, and idempotency — with no lease, because
 * every append is conditioned on the log head it was decided against.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSession,
  createSessionStore,
  type GenerateFunction,
  stopWhen,
  type JSONValue,
} from '@lostgradient/operative';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createConversationHistory } from 'conversationalist';
import { encodeStorageKeyComponent } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import type { SteeringCommandRequest } from './steering';
import type { BureauDiagnostic } from './types';
import { createRuntimeComposition } from './runtime-composition';
import {
  appendSteeringLogEvent,
  readSteeringKeyBinding,
  readSteeringLogEntries,
  readSteeringLogHead,
  steeringSessionRunTag,
} from './steering-log';

async function openBureau(path: string) {
  return createBureau({
    agents: {},
    generate: () => new Promise<never>(() => {}),
    toolbox: createToolbox([]),
    storage: { type: 'sqlite', path },
    durableExecution: true,
  });
}

type TestBureau = Awaited<ReturnType<typeof openBureau>>;

/** The prototype every Bureau's durable engine shares, for spying on its reads. */
async function durableEnginePrototype() {
  const probe = await createRuntimeComposition({
    generate: () => new Promise<never>(() => {}),
    toolbox: createToolbox([]),
    storage: { type: 'memory' },
    durableExecution: true,
  });
  const prototype = Object.getPrototypeOf(probe.durable!.engine) as {
    get: (id: string) => Promise<unknown>;
    list: (query: unknown) => Promise<unknown>;
  };
  probe.durable!.engine[Symbol.dispose]?.();
  probe.disposeStorage?.();
  return prototype;
}

async function startRunningSession(bureau: TestBureau, sessionId?: string): Promise<string> {
  const run = await bureau.createRun({
    message: 'Wait forever',
    principal: 'alice',
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const session = await bureau.getSession(run.sessionId);
    if (session?.metadata['lastRunStatus'] === 'running') return run.sessionId;
    await Bun.sleep(10);
  }
  throw new Error(`session "${run.sessionId}" never reached running`);
}

function versionOf(outcome: Awaited<ReturnType<TestBureau['submitSteeringCommand']>>): number {
  if (outcome.outcome !== 'accepted') throw new Error(`expected accepted, got ${outcome.outcome}`);
  return outcome.command.configVersion;
}

describe('durable steering across two Bureau processes', () => {
  it('lets both admit, in one order, with shared versions, states, and keys', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-two-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau(path);
    const bureauB = await openBureau(path);

    try {
      const sessionId = await startRunningSession(bureauA);
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;

      expect(
        versionOf(await bureauA.submitSteeringCommand(sessionId, model('k1', 'claude-sonnet-5'))),
      ).toBe(1);
      expect(
        versionOf(await bureauA.submitSteeringCommand(sessionId, model('k2', 'claude-opus-4-8'))),
      ).toBe(2);

      // B folds A's two commands before deciding, so its own continues at 3,
      // and A folds B's before its next one.
      const fromB = await bureauB.submitSteeringCommand(sessionId, {
        id: 'b1',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(versionOf(fromB)).toBe(3);
      const fromA = await bureauA.submitSteeringCommand(sessionId, {
        id: 'a3',
        principal: 'alice',
        requestedValue: { target: 'effort', override: 'high' },
      });
      expect(versionOf(fromA)).toBe(4);

      // k1 was superseded by k2 in A; B reports that state.
      const superseded = await bureauB.submitSteeringCommand(
        sessionId,
        model('k1', 'claude-sonnet-5'),
      );
      expect(superseded.outcome).toBe('replayed');
      if (superseded.outcome !== 'replayed') throw new Error('expected replayed');
      expect(superseded.command.state).toBe('superseded');

      // One key submitted from both at once is admitted exactly once.
      const raced = await Promise.all([
        bureauA.submitSteeringCommand(sessionId, model('race', 'claude-sonnet-5')),
        bureauB.submitSteeringCommand(sessionId, model('race', 'claude-sonnet-5')),
      ]);
      expect(raced.map(({ outcome }) => outcome).toSorted()).toEqual(['accepted', 'replayed']);

      // A refusal is logged too: the id stays decided in every process.
      const refused = await bureauA.submitSteeringCommand(sessionId, {
        id: 'refused',
        principal: 'alice',
        deadline: '2000-01-01T00:00:00.000Z',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(refused.outcome).toBe('rejected');
      const reusedRefused = await bureauB.submitSteeringCommand(sessionId, {
        id: 'refused',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(reusedRefused.outcome).toBe('conflict');
      if (reusedRefused.outcome !== 'conflict') throw new Error('expected conflict');
      expect(reusedRefused.conflict.reason).toBe('target-mismatch');
      expect(reusedRefused.conflict.original.state).toBe('rejected');
      // A returned refusal is the caller's own copy: changing it changes
      // nothing a later retry sees.
      if (refused.outcome === 'rejected') {
        (refused.failure as { reason: string }).reason = 'mutated';
        const again = await bureauA.submitSteeringCommand(sessionId, {
          id: 'refused',
          principal: 'alice',
          deadline: '2000-01-01T00:00:00.000Z',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        });
        if (again.outcome !== 'rejected') throw new Error('expected rejected');
        expect(again.failure.reason).toBe('deadline-passed');
        (refused.failure as { reason: string }).reason = again.failure.reason;
      }
      const retriedRefusal = await bureauB.submitSteeringCommand(sessionId, {
        id: 'refused',
        principal: 'alice',
        deadline: '2000-01-01T00:00:00.000Z',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(retriedRefusal).toEqual(refused);

      // A refusal Bureau makes before the gate (a model outside the catalog)
      // is logged as well, so the id stays decided in every process.
      const offCatalog = await bureauA.submitSteeringCommand(
        sessionId,
        model('off', 'not-a-real-model'),
      );
      expect(offCatalog.outcome).toBe('rejected');
      expect(
        await bureauB.submitSteeringCommand(sessionId, model('off', 'not-a-real-model')),
      ).toEqual(offCatalog);
      const offCatalogReused = await bureauB.submitSteeringCommand(
        sessionId,
        model('off', 'claude-sonnet-5'),
      );
      expect(offCatalogReused.outcome).toBe('conflict');
      if (offCatalogReused.outcome !== 'conflict') throw new Error('expected conflict');
      expect(offCatalogReused.conflict.reason).toBe('requested-value-mismatch');

      // A's key sent by B to a session of B's own is a session mismatch.
      const otherSession = await startRunningSession(bureauB);
      const crossSession = await bureauB.submitSteeringCommand(
        otherSession,
        model('k2', 'claude-opus-4-8'),
      );
      expect(crossSession.outcome).toBe('conflict');
      if (crossSession.outcome !== 'conflict') throw new Error('expected conflict');
      expect(crossSession.conflict.reason).toBe('session-mismatch');
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("gives a recreated session a fresh log and frees the deleted incarnation's keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-recreate-'));
    const path = join(directory, 'bureau.sqlite');
    const bureau = await openBureau(path);

    try {
      const sessionId = await startRunningSession(bureau);
      const steer = {
        id: 'reused',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-opus-4-8' },
      } as const;
      expect(versionOf(await bureau.submitSteeringCommand(sessionId, steer))).toBe(1);
      await bureau.submitSteeringCommand(sessionId, {
        ...steer,
        id: 'second',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });

      await bureau.deleteSession(sessionId);
      await startRunningSession(bureau, sessionId);

      // A different value under the deleted incarnation's key is a new
      // command in the new incarnation, at version 1 of a fresh log.
      const fresh = await bureau.submitSteeringCommand(sessionId, {
        ...steer,
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(versionOf(fresh)).toBe(1);
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("schedules each session's steering poll on the Bureau's own timers", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-poll-timers-'));
    const path = join(directory, 'bureau.sqlite');
    const runtime = createManualRuntimeServices();
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let generateCalls = 0;
    const bureau = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        generateCalls += 1;
        return step === 0
          ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([
        createTool({
          name: 'next',
          description: 'waits for the test',
          input: z.object({}),
          execute: async () => {
            await toolGate;
            return 'ok';
          },
        }),
      ]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
      runtime,
    });
    try {
      // Time never advances here, so a 2-second interval is due at 2,000 on
      // the manual timer's own scale.
      const pollTimers = () => runtime.pendingTimers().filter((timer) => timer.dueAt === 2_000);
      const before = pollTimers().length;
      const run = await bureau.createRun({ message: 'go', principal: 'alice' });
      for (let attempt = 0; attempt < 200 && generateCalls === 0; attempt += 1) await Bun.sleep(10);
      // The run's session is polled through the injected timer service, so
      // a host driving time itself drives cross-process steering too.
      expect(pollTimers().length).toBe(before + 1);

      // A poll still waiting on a slow store is not joined by another on the
      // next tick: the reads of one poll are all that happen.
      const kv = bureau.kv;
      if (kv === undefined) throw new Error('expected a durable store');
      const read = kv.get.bind(kv);
      let release: (() => void) | undefined;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      let sessionReads = 0;
      const reads = spyOn(kv, 'get').mockImplementation(async (key: string) => {
        if (key.startsWith('agent-session-v2:body:')) {
          sessionReads += 1;
          await slow;
        }
        return read(key);
      });
      try {
        await runtime.advance(2_000);
        await Bun.sleep(0);
        const readsOfOnePoll = sessionReads;
        expect(readsOfOnePoll).toBeGreaterThan(0);
        await runtime.advance(2_000);
        await runtime.advance(2_000);
        await Bun.sleep(0);
        expect(sessionReads).toBe(readsOfOnePoll);
      } finally {
        release?.();
        reads.mockRestore();
      }
      bureau.abortRun(run.id);
      for (let attempt = 0; attempt < 200 && pollTimers().length > before; attempt += 1) {
        await Bun.sleep(10);
      }
      expect(pollTimers().length).toBe(before);
    } finally {
      releaseTool?.();
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('aborts a run that is not paused when another process deletes its session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-remote-delete-running-'));
    const path = join(directory, 'bureau.sqlite');
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let generateCalls = 0;
    const bureauA = await createBureau({
      agents: {},
      generate: async ({ step }) => {
        generateCalls += 1;
        return step === 0
          ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
          : { content: 'done', toolCalls: [] };
      },
      toolbox: createToolbox([
        createTool({
          name: 'next',
          description: 'waits for the test',
          input: z.object({}),
          execute: async () => {
            await toolGate;
            return 'ok';
          },
        }),
      ]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    const bureauB = await openBureau(path);
    try {
      const run = await bureauA.createRun({ message: 'go', principal: 'alice' });
      for (let attempt = 0; attempt < 200 && generateCalls === 0; attempt += 1) await Bun.sleep(10);
      // B deletes the session; A learns of it from its poll and aborts the
      // run as its own deletion would, rather than letting it keep working.
      await bureauB.deleteSession(run.sessionId);
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (bureauA.getRun(run.id)?.status !== 'running') break;
        await Bun.sleep(10);
      }
      expect(bureauA.getRun(run.id)?.status).toBe('aborted');
      expect(generateCalls).toBe(1);
      await bureauA.waitForDurableRun(run.id).catch(() => {});
      expect(await bureauB.getSession(run.sessionId)).toBeUndefined();
    } finally {
      releaseTool?.();
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('delivers a pause and a resume admitted in another process to the run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-remote-delivery-'));
    const path = join(directory, 'bureau.sqlite');
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let generateCalls = 0;
    const generate: GenerateFunction = async ({ step }) => {
      generateCalls += 1;
      return step === 0
        ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
        : { content: 'done', toolCalls: [] };
    };
    const bureauA = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([
        createTool({
          name: 'next',
          description: 'waits for the test',
          input: z.object({}),
          execute: async () => {
            await toolGate;
            return 'ok';
          },
        }),
      ]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    const bureauB = await openBureau(path);
    try {
      const run = await bureauA.createRun({ message: 'go', principal: 'alice' });
      for (let attempt = 0; attempt < 200 && generateCalls === 0; attempt += 1) await Bun.sleep(10);

      // B pauses A's run. A learns of it from its own log poll, which the
      // test observes as A reading the pause's log entry; only then does the
      // tool return and the run reach its boundary.
      const kvA = bureauA.kv;
      if (kvA === undefined) throw new Error('expected a durable store');
      const readsByA = spyOn(kvA, 'get');
      const paused = await bureauB.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(paused.outcome).toBe('accepted');
      const sessionA = await bureauA.getSession(run.sessionId);
      const kvB = bureauB.kv;
      if (sessionA === undefined || kvB === undefined) throw new Error('expected the session');
      const pauseHead = await readSteeringLogHead(kvB, run.sessionId, sessionA.incarnation);
      const pauseSequence = pauseHead.sequence;
      const pauseEntry = `:entry:${String(pauseSequence).padStart(12, '0')}`;
      readsByA.mockClear();
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (readsByA.mock.calls.some(([key]) => key.endsWith(pauseEntry))) break;
        await Bun.sleep(10);
      }
      expect(readsByA.mock.calls.some(([key]) => key.endsWith(pauseEntry))).toBe(true);
      readsByA.mockRestore();
      // The read entry is applied to the gate in the same fold.
      await Bun.sleep(0);
      releaseTool?.();
      await Bun.sleep(300);
      expect(bureauA.getRun(run.id)?.status).toBe('running');
      expect(generateCalls).toBe(1);

      // B resumes it; A's waiting run is released by the next poll.
      const resumed = await bureauB.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'resume' },
      });
      expect(resumed.outcome).toBe('accepted');
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (bureauA.getRun(run.id)?.status !== 'running') break;
        await Bun.sleep(10);
      }
      expect(bureauA.getRun(run.id)?.status).toBe('completed');
      expect(generateCalls).toBe(2);
    } finally {
      releaseTool?.();
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('releases a paused run when another process deletes its session, without recreating it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-remote-delete-'));
    const path = join(directory, 'bureau.sqlite');
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let releaseSecondTool: (() => void) | undefined;
    const secondToolGate = new Promise<void>((resolve) => {
      releaseSecondTool = resolve;
    });
    let toolCalls = 0;
    let generateCalls = 0;
    const generate: GenerateFunction = async ({ step }) => {
      generateCalls += 1;
      return step === 0
        ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
        : { content: 'done', toolCalls: [] };
    };
    const bureauA = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([
        createTool({
          name: 'next',
          description: 'waits for the test',
          input: z.object({}),
          execute: async () => {
            toolCalls += 1;
            await (toolCalls === 1 ? toolGate : secondToolGate);
            return 'ok';
          },
        }),
      ]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      stopWhen: stopWhen.noToolCalls(),
    });
    const bureauB = await openBureau(path);
    try {
      const run = await bureauA.createRun({ message: 'go', principal: 'alice' });
      for (let attempt = 0; attempt < 200 && generateCalls === 0; attempt += 1) await Bun.sleep(10);
      const paused = await bureauA.submitSteeringCommand(run.sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(paused.outcome).toBe('accepted');
      // The tool returns; the run stops at step 1's boundary, paused.
      releaseTool?.();
      await Bun.sleep(200);
      expect(bureauA.getRun(run.id)?.status).toBe('running');
      expect(generateCalls).toBe(1);

      // B deletes the session. Nothing in B knows A's run; A sees the
      // deletion from the paused run's own watch and releases it.
      await bureauB.deleteSession(run.sessionId);
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (bureauA.getRun(run.id)?.status !== 'running') break;
        await Bun.sleep(10);
      }
      expect(bureauA.getRun(run.id)?.status).toBe('completed');
      expect(generateCalls).toBe(2);
      // Its terminal save is fenced to the deleted incarnation.
      await bureauA.waitForDurableRun(run.id);
      expect(await bureauB.getSession(run.sessionId)).toBeUndefined();

      // A paused run that is aborted instead stops its watch with the wait.
      const intervals = spyOn(globalThis, 'setInterval');
      const cleared = spyOn(globalThis, 'clearInterval');
      try {
        const second = await bureauA.createRun({ message: 'again', principal: 'alice' });
        for (let attempt = 0; attempt < 200 && generateCalls < 3; attempt += 1) await Bun.sleep(10);
        const pausedAgain = await bureauA.submitSteeringCommand(second.sessionId, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        });
        expect(pausedAgain.outcome).toBe('accepted');
        releaseSecondTool?.();
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (intervals.mock.calls.some(([, delay]) => delay === 2_000)) break;
          await Bun.sleep(10);
        }
        const watchIndex = intervals.mock.calls.findIndex(([, delay]) => delay === 2_000);
        expect(watchIndex).toBeGreaterThanOrEqual(0);
        const watch = intervals.mock.results[watchIndex]?.value;
        bureauA.abortRun(second.id);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (cleared.mock.calls.some(([handle]) => handle === watch)) break;
          await Bun.sleep(10);
        }
        expect(cleared.mock.calls.some(([handle]) => handle === watch)).toBe(true);
      } finally {
        intervals.mockRestore();
        cleared.mockRestore();
      }
    } finally {
      releaseTool?.();
      releaseSecondTool?.();
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('folds a run boundary and a completion to the same command states everywhere', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-boundary-'));
    const path = join(directory, 'bureau.sqlite');
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let releaseSecondTool: (() => void) | undefined;
    const secondToolGate = new Promise<void>((resolve) => {
      releaseSecondTool = resolve;
    });
    let toolCalls = 0;
    let generateCalls = 0;
    // Step 0 calls a tool that waits for the test; step 1 finishes. Steering
    // admitted while the tool waits is observed at step 1's boundary.
    const generate: GenerateFunction = async ({ step }) => {
      generateCalls += 1;
      return step === 0
        ? { content: '', toolCalls: [{ name: 'next', arguments: {} }] }
        : { content: 'done', toolCalls: [] };
    };
    const bureauA = await createBureau({
      agents: {},
      generate,
      toolbox: createToolbox([
        createTool({
          name: 'next',
          description: 'waits for the test',
          input: z.object({}),
          execute: async () => {
            toolCalls += 1;
            // The first run waits for the test; the second stays live so the
            // session is not terminal while the test inspects it.
            await (toolCalls === 1 ? toolGate : secondToolGate);
            return 'ok';
          },
        }),
      ]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
    });
    let bureauB: TestBureau | undefined;

    try {
      const run = await bureauA.createRun({ message: 'go', principal: 'alice' });
      for (let attempt = 0; attempt < 200 && generateCalls === 0; attempt += 1) await Bun.sleep(10);
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;
      expect(
        versionOf(
          await bureauA.submitSteeringCommand(run.sessionId, model('k1', 'claude-sonnet-5')),
        ),
      ).toBe(1);
      expect(
        versionOf(
          await bureauA.submitSteeringCommand(run.sessionId, model('k2', 'claude-opus-4-8')),
        ),
      ).toBe(2);

      releaseTool?.();
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (bureauA.getRun(run.id)?.status !== 'running') break;
        await Bun.sleep(10);
      }
      expect(bureauA.getRun(run.id)?.status).toBe('completed');

      // A second run keeps the session live (a terminal session answers
      // `session-terminal` before any idempotency check).
      await bureauA.createRun({ message: 'again', principal: 'alice', sessionId: run.sessionId });
      for (let attempt = 0; attempt < 200 && toolCalls < 2; attempt += 1) await Bun.sleep(10);

      // The boundary's `applied` event is logged in the background; wait for
      // A itself to report it, then compare with a process that only folds.
      const stateIn = async (bureau: TestBureau, id: string, override: string) => {
        const outcome = await bureau.submitSteeringCommand(run.sessionId, model(id, override));
        if (outcome.outcome !== 'replayed')
          throw new Error(`expected replayed, got ${outcome.outcome}`);
        return outcome.command.state;
      };
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await stateIn(bureauA, 'k2', 'claude-opus-4-8')) === 'applied') break;
        await Bun.sleep(10);
      }
      expect(await stateIn(bureauA, 'k2', 'claude-opus-4-8')).toBe('applied');
      expect(await stateIn(bureauA, 'k1', 'claude-sonnet-5')).toBe('superseded');

      bureauB = await openBureau(path);
      await bureauB.waitForRecovery?.();
      expect(await stateIn(bureauB, 'k2', 'claude-opus-4-8')).toBe('applied');
      expect(await stateIn(bureauB, 'k1', 'claude-sonnet-5')).toBe('superseded');
    } finally {
      releaseTool?.();
      releaseSecondTool?.();
      await bureauA.dispose();
      await bureauB?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('folds a key reused after another process deleted its session, without stale state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-deleted-elsewhere-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau(path);
    const bureauB = await openBureau(path);

    try {
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;
      const first = await startRunningSession(bureauA);
      expect(
        versionOf(await bureauA.submitSteeringCommand(first, model('k1', 'claude-sonnet-5'))),
      ).toBe(1);

      // B deletes that session; A never hears about it. B then admits the
      // same key in a new session, replacing the dead incarnation's binding.
      await bureauB.deleteSession(first);
      const second = await startRunningSession(bureauB);
      expect(
        versionOf(await bureauB.submitSteeringCommand(second, model('k1', 'claude-opus-4-8'))),
      ).toBe(1);

      // A folds the new session from its log alone: k1 is that session's
      // first command, so a new command is version 2 and k1 replays there.
      expect(
        versionOf(await bureauA.submitSteeringCommand(second, model('k2', 'claude-sonnet-5'))),
      ).toBe(2);
      const replayed = await bureauA.submitSteeringCommand(second, model('k1', 'claude-opus-4-8'));
      expect(replayed.outcome).toBe('replayed');
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('replays a policy-resolved command for an exact retry, even where the policy is gone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-policy-'));
    const path = join(directory, 'bureau.sqlite');
    const withPolicy = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      modelPolicy: {
        policyRevision: 1,
        users: {
          'fast-tier': { exactOverride: { model: 'claude-sonnet-5' } },
          'unknown-tier': { exactOverride: { model: 'no-such-model' } },
        },
      },
    });
    const withoutPolicy = await openBureau(path);
    const withChangedPolicy = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      modelPolicy: {
        policyRevision: 2,
        users: { 'fast-tier': { exactOverride: { model: 'claude-opus-4-8' } } },
      },
    });
    try {
      const sessionId = await startRunningSession(withPolicy);
      const viaPolicy = {
        id: 'p1',
        principal: 'alice',
        requestedValue: { target: 'model', policyRef: 'fast-tier' },
      } as const;
      expect(versionOf(await withPolicy.submitSteeringCommand(sessionId, viaPolicy))).toBe(1);

      // This process has no such profile, so resolving the retry afresh
      // would refuse it; it repeats the original request, so it replays.
      const retried = await withoutPolicy.submitSteeringCommand(sessionId, viaPolicy);
      expect(retried.outcome).toBe('replayed');
      // Nor does a process where the same profile now names another model.
      const retriedChanged = await withChangedPolicy.submitSteeringCommand(sessionId, viaPolicy);
      expect(retriedChanged.outcome).toBe('replayed');

      // A policy-resolved command the gate rejected stays rejected for an
      // exact retry where the policy is gone.
      const late = { ...viaPolicy, id: 'p2', deadline: '2000-01-01T00:00:00.000Z' } as const;
      const rejected = await withPolicy.submitSteeringCommand(sessionId, late);
      expect(rejected.outcome).toBe('rejected');
      expect(await withoutPolicy.submitSteeringCommand(sessionId, late)).toEqual(rejected);

      // The other direction: refused where the profile was missing, an exact
      // retry stays that refusal in a process that could now resolve it.
      const unresolvable = { ...viaPolicy, id: 'p3' } as const;
      const refusedHere = await withoutPolicy.submitSteeringCommand(sessionId, unresolvable);
      expect(refusedHere.outcome).toBe('rejected');
      expect(await withPolicy.submitSteeringCommand(sessionId, unresolvable)).toEqual(refusedHere);

      // A value naming both a policy and an override is malformed. It is
      // refused before anything is logged, so every process still reads the
      // log: the next admission elsewhere succeeds.
      await expect(
        withPolicy.submitSteeringCommand(sessionId, {
          id: 'p-both',
          principal: 'alice',
          requestedValue: {
            target: 'model',
            policyRef: 'fast-tier',
            override: 'claude-opus-4-8',
          } as never,
        }),
      ).rejects.toThrow('Malformed steering command.');
      const afterBoth = await withoutPolicy.submitSteeringCommand(sessionId, {
        id: 'p-after-both',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(afterBoth.outcome).toBe('accepted');

      // Refused by the catalog after the selector resolved: the logged command
      // is the resolved value that was refused, and the selector stays its
      // retry key, so a conflict discloses the value and a retry replays.
      const uncatalogued = {
        id: 'p-uncatalogued',
        principal: 'alice',
        requestedValue: { target: 'model', policyRef: 'unknown-tier' },
      } as const;
      const refusedByCatalog = await withPolicy.submitSteeringCommand(sessionId, uncatalogued);
      expect(refusedByCatalog.outcome).toBe('rejected');
      expect(await withoutPolicy.submitSteeringCommand(sessionId, uncatalogued)).toEqual(
        refusedByCatalog,
      );
      const reusedUncatalogued = await withPolicy.submitSteeringCommand(sessionId, {
        ...uncatalogued,
        requestedValue: { target: 'model', override: 'claude-opus-4-8' },
      });
      expect(reusedUncatalogued.outcome).toBe('conflict');
      if (reusedUncatalogued.outcome !== 'conflict') throw new Error('expected conflict');
      expect(reusedUncatalogued.conflict.original.requestedValue).toEqual({
        target: 'model',
        override: 'no-such-model',
      });

      // Refused after the selector was resolved (an unrepresentable revision):
      // the selector is kept, so an exact retry replays where the profile
      // changed or is gone, instead of mismatching the resolved value.
      const badRevision = { ...viaPolicy, id: 'p4', expectedRevision: Number.NaN } as const;
      const refusedResolved = await withPolicy.submitSteeringCommand(sessionId, badRevision);
      expect(refusedResolved.outcome).toBe('rejected');
      expect(await withChangedPolicy.submitSteeringCommand(sessionId, badRevision)).toEqual(
        refusedResolved,
      );
      expect(await withoutPolicy.submitSteeringCommand(sessionId, badRevision)).toEqual(
        refusedResolved,
      );
    } finally {
      await withPolicy.dispose();
      await withoutPolicy.dispose();
      await withChangedPolicy.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails a run start on a corrupt steering log, leaving the session failed rather than running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-corrupt-start-'));
    const path = join(directory, 'bureau.sqlite');
    const bureau = await openBureau(path);
    try {
      const sessionId = await startRunningSession(bureau);
      const session = await bureau.getSession(sessionId);
      const kv = bureau.kv;
      if (kv === undefined || session === undefined) throw new Error('expected a durable session');
      const logKeys = await kv.list(`steering-log:v1:${encodeStorageKeyComponent(sessionId)}:`);
      const [headKey] = logKeys.filter((key) => key.endsWith(':head'));
      if (headKey === undefined) throw new Error('expected a steering log head');
      await kv.set(headKey, '{"sequence":-1}');

      await expect(
        bureau.createRun({ message: 'again', principal: 'alice', sessionId }),
      ).rejects.toThrow();
      const after = await bureau.getSession(sessionId);
      expect(after?.metadata['lastRunStatus']).toBe('error');
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('binds pause and resume against live runs in every process, not just its own', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-liveness-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau(path);
    const bureauB = await openBureau(path);
    try {
      const sessionId = await startRunningSession(bureauA);
      const sessionInA = await bureauA.getSession(sessionId);
      const runInA = sessionInA?.metadata['lastRunId'];
      if (typeof runInA !== 'string') throw new Error('expected a run id');

      // The session's only live run is in A. B sees it, so an unscoped pause
      // binds to it rather than being `run-ambiguous` with zero runs.
      const unscoped = await bureauB.submitSteeringCommand(sessionId, {
        id: 'pause-from-b',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(unscoped.outcome).toBe('accepted');
      if (unscoped.outcome !== 'accepted') throw new Error('expected accepted');
      expect(unscoped.command.runId).toBe(runInA);

      // Naming A's run explicitly is not `run-terminal` from B either.
      const explicit = await bureauB.submitSteeringCommand(sessionId, {
        id: 'resume-from-b',
        principal: 'alice',
        runId: runInA,
        requestedValue: { target: 'resume' },
      });
      expect(explicit.outcome).toBe('accepted');

      // With a live run in each process, an unscoped pause is ambiguous from
      // either side.
      await startRunningSession(bureauB, sessionId);
      for (const bureau of [bureauA, bureauB]) {
        const ambiguous = await bureau.submitSteeringCommand(sessionId, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        });
        expect(ambiguous.outcome).toBe('rejected');
        if (ambiguous.outcome !== 'rejected') throw new Error('expected rejected');
        expect(ambiguous.failure.reason).toBe('run-ambiguous');
      }
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('counts every run promoted in the log as starting until its workflow exists', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-starting-runs-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau(path);
    const bureauB = await openBureau(path);
    try {
      const sessionId = await startRunningSession(bureauA);
      const session = await bureauA.getSession(sessionId);
      const kv = bureauA.kv;
      if (session === undefined || kv === undefined) throw new Error('expected a durable session');

      // Two runs promoted concurrently by other processes, neither of whose
      // workflows exists yet. Each start records its owner, but the session's
      // single `lastRunId` names neither.
      await createSessionStore(kv).update(sessionId, (current) => {
        if (current === undefined) return undefined;
        const authorities = current.metadata['lastRequestAuthorities'] as Record<string, JSONValue>;
        const alice = authorities[current.metadata['lastRunId'] as string];
        if (alice === undefined) throw new Error("expected the running run's authority");
        return {
          ...current,
          metadata: {
            ...current.metadata,
            lastRequestAuthorities: {
              ...authorities,
              'starting-early': alice,
              'starting-late': alice,
            },
          },
        };
      });
      for (const runId of ['starting-early', 'starting-late']) {
        const head = await readSteeringLogHead(kv, sessionId, session.incarnation);
        const appended = await appendSteeringLogEvent(kv, sessionId, session.incarnation, head, {
          type: 'promoted',
          runId,
          now: new Date().toISOString(),
        });
        expect(appended.status).toBe('appended');
      }

      // The earlier starting run is still live, not `run-terminal`.
      const explicit = await bureauB.submitSteeringCommand(sessionId, {
        principal: 'alice',
        runId: 'starting-early',
        requestedValue: { target: 'pause' },
      });
      expect(explicit.outcome).toBe('accepted');

      // With three live runs, an unscoped pause binds to none of them.
      const unscoped = await bureauB.submitSteeringCommand(sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(unscoped.outcome).toBe('rejected');
      if (unscoped.outcome !== 'rejected') throw new Error('expected rejected');
      expect(unscoped.failure.reason).toBe('run-ambiguous');
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("folds starting runs before the terminal check, reads markers only as far as admission needs, and surfaces a named run's liveness failure", async () => {
    // The engine every Bureau composes: its reads are counted, then failed.
    const engineType = await durableEnginePrototype();
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-starting-terminal-'));
    const path = join(directory, 'bureau.sqlite');
    const writer = await openBureau(path);
    let reader: TestBureau | undefined;
    const engineGet = spyOn(engineType, 'get');
    const engineList = spyOn(engineType, 'list');
    try {
      // An older run's terminal save made the session terminal, while five
      // newer runs were promoted elsewhere and have no workflow yet. Bob owns
      // the older run; alice owns the starting ones.
      const kv = writer.kv;
      if (kv === undefined) throw new Error('expected a durable store');
      const sessionId = 'session-starting-terminal';
      const starting = ['starting-1', 'starting-2', 'starting-3', 'starting-4', 'starting-5'];
      const store = createSessionStore(kv);
      await store.save(
        createAgentSession({
          id: sessionId,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: sessionId }),
          metadata: {
            lastRunId: 'older',
            lastRunStatus: 'completed',
            lastRequestAuthorities: {
              older: { principalId: 'bob' },
              ...Object.fromEntries(starting.map((runId) => [runId, { principalId: 'alice' }])),
            },
          },
        }),
      );
      const session = await store.load(sessionId);
      if (session === undefined) throw new Error('expected the session');
      for (const runId of starting) {
        const head = await readSteeringLogHead(kv, sessionId, session.incarnation);
        await appendSteeringLogEvent(kv, sessionId, session.incarnation, head, {
          type: 'promoted',
          runId,
          now: new Date().toISOString(),
        });
      }

      // A Bureau with no folded view of the session yet.
      reader = await openBureau(path);
      const explicit = await reader.submitSteeringCommand(sessionId, {
        principal: 'alice',
        runId: 'starting-3',
        requestedValue: { target: 'pause' },
      });
      expect(explicit.outcome).toBe('accepted');

      // Two starting runs settle "ambiguous"; the other three go unread.
      engineGet.mockClear();
      const unscoped = await reader.submitSteeringCommand(sessionId, {
        principal: 'bob',
        requestedValue: { target: 'pause' },
      });
      expect(unscoped.outcome).toBe('rejected');
      if (unscoped.outcome !== 'rejected') throw new Error('expected rejected');
      expect(unscoped.failure.reason).toBe('run-ambiguous');
      // Liveness is read twice per admission (before and inside the queue).
      expect(engineGet.mock.calls.length).toBeLessThanOrEqual(4);

      // A backend failure reaches the caller authorized for the run it
      // named, even though the session's default authority is someone else's.
      engineGet.mockImplementation(() => Promise.reject(new Error('backend unavailable')));
      await expect(
        reader.submitSteeringCommand(sessionId, {
          principal: 'alice',
          runId: 'starting-4',
          requestedValue: { target: 'pause' },
        }),
      ).rejects.toThrow('backend unavailable');
      // ...unless that run's authority was taken from the caller while the
      // query was failing: then the answer is `not-found`, not the failure.
      engineGet.mockImplementation(async () => {
        await store.update(sessionId, (current) => {
          if (current === undefined) return undefined;
          const authorities = current.metadata['lastRequestAuthorities'] as Record<
            string,
            JSONValue
          >;
          return {
            ...current,
            metadata: {
              ...current.metadata,
              lastRequestAuthorities: { ...authorities, 'starting-5': { principalId: 'bob' } },
            },
          };
        });
        throw new Error('backend unavailable');
      });
      expect(
        await reader.submitSteeringCommand(sessionId, {
          principal: 'alice',
          runId: 'starting-5',
          requestedValue: { target: 'pause' },
        }),
      ).toEqual({ outcome: 'not-found' });

      // A run whose workflow became queryable after the tag listing is
      // counted from the marker's own read, not dropped with its marker.
      const appearingSession = 'session-appearing';
      await store.save(
        createAgentSession({
          id: appearingSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: appearingSession }),
          metadata: { lastRunId: 'older', lastRunStatus: 'completed' },
        }),
      );
      const appearing = await store.load(appearingSession);
      if (appearing === undefined) throw new Error('expected the session');
      await appendSteeringLogEvent(
        kv,
        appearingSession,
        appearing.incarnation,
        await readSteeringLogHead(kv, appearingSession, appearing.incarnation),
        { type: 'promoted', runId: 'appearing', now: new Date().toISOString() },
      );
      const appearingTag = steeringSessionRunTag(appearingSession, appearing.incarnation);
      engineGet.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'appearing' ? { type: 'agentRun', status: 'running', tags: [appearingTag] } : null,
        ),
      );
      const bound = await reader.submitSteeringCommand(appearingSession, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(bound.outcome).toBe('accepted');
      if (bound.outcome !== 'accepted') throw new Error('expected accepted');
      expect(bound.command.runId).toBe('appearing');

      // A workflow of another type that happens to carry the tag is not a
      // run of the session, whichever way it is read.
      const foreignSession = 'session-foreign';
      await store.save(
        createAgentSession({
          id: foreignSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: foreignSession }),
          metadata: { lastRunId: 'older', lastRunStatus: 'completed' },
        }),
      );
      const foreign = await store.load(foreignSession);
      if (foreign === undefined) throw new Error('expected the session');
      await appendSteeringLogEvent(
        kv,
        foreignSession,
        foreign.incarnation,
        await readSteeringLogHead(kv, foreignSession, foreign.incarnation),
        { type: 'promoted', runId: 'foreign', now: new Date().toISOString() },
      );
      const foreignTag = steeringSessionRunTag(foreignSession, foreign.incarnation);
      engineGet.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'foreign' ? { type: 'goalRun', status: 'running', tags: [foreignTag] } : null,
        ),
      );
      const notARun = await reader.submitSteeringCommand(foreignSession, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(notARun.outcome).toBe('session-terminal');

      // A named run its own read finds live needs no listing, so a listing
      // outage does not block it; and once decided, an exact retry is
      // answered from the log with the engine unreachable altogether.
      const outageSession = 'session-listing-outage';
      await store.save(
        createAgentSession({
          id: outageSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: outageSession }),
          metadata: { lastRunId: 'named-run', lastRunStatus: 'running' },
        }),
      );
      const outage = await store.load(outageSession);
      if (outage === undefined) throw new Error('expected the session');
      const outageTag = steeringSessionRunTag(outageSession, outage.incarnation);
      engineGet.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'named-run' ? { type: 'agentRun', status: 'running', tags: [outageTag] } : null,
        ),
      );
      engineList.mockImplementation(() => Promise.reject(new Error('listing unavailable')));
      const namedPause = {
        id: 'k-named',
        principal: 'alice',
        runId: 'named-run',
        requestedValue: { target: 'pause' },
      } as const;
      const decided = await reader.submitSteeringCommand(outageSession, namedPause);
      expect(decided.outcome).toBe('accepted');
      engineGet.mockImplementation(() => Promise.reject(new Error('backend unavailable')));
      const retried = await reader.submitSteeringCommand(outageSession, namedPause);
      expect(retried.outcome).toBe('replayed');

      // An unscoped request whose liveness query fails is masked against the
      // session as it stands after the failure: here another process handed
      // the default run to bob while the query was failing.
      const revokedSession = 'session-revoked';
      await store.save(
        createAgentSession({
          id: revokedSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: revokedSession }),
          metadata: {
            lastRunId: 'older',
            lastRunStatus: 'running',
            lastRequestAuthorities: { older: { principalId: 'alice' } },
          },
        }),
      );
      engineGet.mockImplementation(() => Promise.resolve(null));
      engineList.mockImplementation(async () => {
        await store.update(revokedSession, (current) =>
          current === undefined
            ? undefined
            : {
                ...current,
                metadata: {
                  ...current.metadata,
                  lastRequestAuthorities: { older: { principalId: 'bob' } },
                },
              },
        );
        throw new Error('backend unavailable');
      });
      expect(
        await reader.submitSteeringCommand(revokedSession, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        }),
      ).toEqual({ outcome: 'not-found' });
    } finally {
      engineGet.mockRestore();
      engineList.mockRestore();
      await writer.dispose();
      await reader?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("counts only the current session incarnation's runs as live, and handles any session id", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-incarnation-liveness-'));
    const path = join(directory, 'bureau.sqlite');
    const bureauA = await openBureau(path);
    const bureauB = await openBureau(path);
    try {
      // A's run keeps going after B deletes its session and recreates the
      // id with a run of its own; only B's run belongs to the new session.
      const sessionId = await startRunningSession(bureauA);
      await bureauB.deleteSession(sessionId);
      await startRunningSession(bureauB, sessionId);
      const recreated = await bureauB.getSession(sessionId);
      const pause = await bureauB.submitSteeringCommand(sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pause.outcome).toBe('accepted');
      if (pause.outcome !== 'accepted') throw new Error('expected accepted');
      const recreatedRunId = recreated?.metadata['lastRunId'];
      if (typeof recreatedRunId !== 'string') throw new Error('expected a run id');
      expect(pause.command.runId).toBe(recreatedRunId);
      // A still runs the deleted incarnation's run, but it is not live for
      // the recreated session, so A binds an unscoped pause the same way.
      const pauseFromA = await bureauA.submitSteeringCommand(sessionId, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(pauseFromA.outcome).toBe('accepted');
      if (pauseFromA.outcome !== 'accepted') throw new Error('expected accepted');
      expect(pauseFromA.command.runId).toBe(recreatedRunId);

      // When A's backend query fails, the failure is masked against A's runs
      // of the recreated session, which A has none of, not against the old
      // run it still holds: alice, authorized for the new run, sees the error.
      const engineList = spyOn(await durableEnginePrototype(), 'list').mockImplementation(() =>
        Promise.reject(new Error('backend unavailable')),
      );
      try {
        await expect(
          bureauA.submitSteeringCommand(sessionId, {
            principal: 'alice',
            requestedValue: { target: 'pause' },
          }),
        ).rejects.toThrow('backend unavailable');
      } finally {
        engineList.mockRestore();
      }

      // A session id far beyond Weft's per-tag size still starts and steers.
      const longId = `session-${'x'.repeat(300)}`;
      await startRunningSession(bureauA, longId);
      const steered = await bureauA.submitSteeringCommand(longId, {
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(steered.outcome).toBe('accepted');

      // A revision JSON cannot represent is answered without being logged,
      // so the session's log stays foldable everywhere.
      const unrepresentable = await bureauA.submitSteeringCommand(longId, {
        id: 'nan-revision',
        principal: 'alice',
        expectedRevision: Number.NaN,
        requestedValue: { target: 'model', override: 'claude-opus-4-8' },
      });
      expect(unrepresentable.outcome).toBe('rejected');
      expect(
        versionOf(
          await bureauB.submitSteeringCommand(longId, {
            principal: 'alice',
            requestedValue: { target: 'provider', override: 'anthropic' },
          }),
        ),
      ).toBe(2);
      // Its id is decided all the same: an exact retry replays the refusal,
      // and the id cannot be reused for a different command.
      expect(
        await bureauB.submitSteeringCommand(longId, {
          id: 'nan-revision',
          principal: 'alice',
          expectedRevision: Number.NaN,
          requestedValue: { target: 'model', override: 'claude-opus-4-8' },
        }),
      ).toEqual(unrepresentable);
      const reused = await bureauB.submitSteeringCommand(longId, {
        id: 'nan-revision',
        principal: 'alice',
        requestedValue: { target: 'provider', override: 'anthropic' },
      });
      expect(reused.outcome).toBe('conflict');

      // A run control with such a revision is refused the same way, and the
      // log stays foldable: a later admission and a fresh process both read it.
      const pauseRevision = await bureauA.submitSteeringCommand(longId, {
        id: 'nan-pause',
        principal: 'alice',
        expectedRevision: Number.NaN,
        requestedValue: { target: 'pause' },
      });
      expect(pauseRevision.outcome).toBe('rejected');
      const pauseRevisionElsewhere = await bureauB.submitSteeringCommand(longId, {
        id: 'nan-pause',
        principal: 'alice',
        expectedRevision: Number.NaN,
        requestedValue: { target: 'pause' },
      });
      expect(pauseRevisionElsewhere).toEqual(pauseRevision);

      // A malformed command from an untyped caller is refused without
      // reaching the log, which every process can still fold.
      const malformed = await bureauA.submitSteeringCommand(longId, {
        id: 'malformed',
        principal: 'alice',
        requestedValue: { target: 'model' } as never,
      });
      expect(malformed.outcome).toBe('rejected');
      expect(
        versionOf(
          await bureauB.submitSteeringCommand(longId, {
            principal: 'alice',
            requestedValue: { target: 'effort', override: 'high' },
          }),
        ),
      ).toBe(3);
    } finally {
      await bureauA.dispose();
      await bureauB.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('answers a reused key only to a caller still authorized for the command it discloses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-reauthorize-'));
    const path = join(directory, 'bureau.sqlite');
    const bureau = await openBureau(path);
    try {
      const kv = bureau.kv;
      if (kv === undefined) throw new Error('expected a durable store');
      const store = createSessionStore(kv);
      const handAuthorityToBob = (sessionId: string, runId: string) =>
        store.update(sessionId, (current) => {
          if (current === undefined) return undefined;
          const authorities = current.metadata['lastRequestAuthorities'] as Record<
            string,
            JSONValue
          >;
          return {
            ...current,
            metadata: {
              ...current.metadata,
              lastRequestAuthorities: { ...authorities, [runId]: { principalId: 'bob' } },
            },
          };
        });

      // Two live runs of alice's on one session; a pause bound to the first.
      const sessionId = await startRunningSession(bureau);
      const lastRunIdOf = async (id: string) => {
        const session = await bureau.getSession(id);
        return session?.metadata['lastRunId'];
      };
      const first = await lastRunIdOf(sessionId);
      await startRunningSession(bureau, sessionId);
      const second = await lastRunIdOf(sessionId);
      if (typeof first !== 'string' || typeof second !== 'string') throw new Error('expected runs');
      const paused = await bureau.submitSteeringCommand(sessionId, {
        id: 'k-pause',
        principal: 'alice',
        runId: first,
        requestedValue: { target: 'pause' },
      });
      expect(paused.outcome).toBe('accepted');

      // Alice loses the first run. Reusing the key through the second, which
      // she still holds, must not disclose the first run's command.
      // The request is read as it was when submitted: naming a run on the
      // caller's own object afterwards cannot turn an ambiguous unscoped
      // pause into one bound to that run.
      const unscopedRequest: SteeringCommandRequest = {
        id: 'k-mutated',
        principal: 'alice',
        requestedValue: { target: 'pause' },
      };
      const submitted = bureau.submitSteeringCommand(sessionId, unscopedRequest);
      (unscopedRequest as { runId?: string }).runId = first;
      const mutated = await submitted;
      expect(mutated.outcome).toBe('rejected');
      if (mutated.outcome !== 'rejected') throw new Error('expected rejected');
      expect(mutated.failure.reason).toBe('run-ambiguous');

      // A refusal keeps the run its request named, and a conflict against it
      // discloses, and is authorized against, that run.
      const refused = await bureau.submitSteeringCommand(sessionId, {
        id: 'k-refused',
        principal: 'alice',
        runId: second,
        expectedRevision: 999,
        requestedValue: { target: 'pause' },
      });
      expect(refused.outcome).toBe('rejected');
      const againstRefusal = await bureau.submitSteeringCommand(sessionId, {
        id: 'k-refused',
        principal: 'alice',
        runId: second,
        requestedValue: { target: 'resume' },
      });
      expect(againstRefusal.outcome).toBe('conflict');
      if (againstRefusal.outcome !== 'conflict') throw new Error('expected conflict');
      expect(againstRefusal.conflict.original.runId).toBe(second);

      await handAuthorityToBob(sessionId, first);
      expect(
        await bureau.submitSteeringCommand(sessionId, {
          id: 'k-pause',
          principal: 'alice',
          runId: second,
          requestedValue: { target: 'resume' },
        }),
      ).toEqual({ outcome: 'not-found' });

      // A key she decided in a session she holds says nothing about a session
      // she does not: reusing it against bob's session is `not-found`, not a
      // conflict that would confirm bob's session exists.
      const bobsRun = await bureau.createRun({ message: 'Wait forever', principal: 'bob' });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const bobs = await bureau.getSession(bobsRun.sessionId);
        if (bobs?.metadata['lastRunStatus'] === 'running') break;
        await Bun.sleep(10);
      }
      const decidedHere = await bureau.submitSteeringCommand(sessionId, {
        id: 'k-mine',
        principal: 'alice',
        runId: second,
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(decidedHere.outcome).toBe('accepted');
      expect(
        await bureau.submitSteeringCommand(bobsRun.sessionId, {
          id: 'k-mine',
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        }),
      ).toEqual({ outcome: 'not-found' });

      // Nor through another session she holds, once she lost the original.
      const other = await startRunningSession(bureau);
      const otherRun = await lastRunIdOf(other);
      if (typeof otherRun !== 'string') throw new Error('expected a run');
      const modelInOther = await bureau.submitSteeringCommand(other, {
        id: 'k-model',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      });
      expect(modelInOther.outcome).toBe('accepted');
      await handAuthorityToBob(other, otherRun);
      expect(
        await bureau.submitSteeringCommand(sessionId, {
          id: 'k-model',
          principal: 'alice',
          runId: second,
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        }),
      ).toEqual({ outcome: 'not-found' });
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed on an applied version no admission before it issued', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-applied-beyond-'));
    const path = join(directory, 'bureau.sqlite');
    const writer = await openBureau(path);
    let reader: TestBureau | undefined;
    try {
      const sessionId = await startRunningSession(writer);
      const session = await writer.getSession(sessionId);
      const kv = writer.kv;
      if (session === undefined || kv === undefined) throw new Error('expected a durable session');
      await appendSteeringLogEvent(
        kv,
        sessionId,
        session.incarnation,
        await readSteeringLogHead(kv, sessionId, session.incarnation),
        {
          type: 'applied',
          // The session's own promoted run, so only the version is impossible.
          runId: session.metadata['lastRunId'] as string,
          configVersion: 99,
          now: new Date().toISOString(),
        },
      );
      reader = await openBureau(path);
      await expect(
        reader.submitSteeringCommand(sessionId, {
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        }),
      ).rejects.toThrow(/no admission before it issued/);
    } finally {
      await writer.dispose();
      await reader?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('logs a run ending once when another process holding the same run ended it first', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-ended-elsewhere-'));
    const path = join(directory, 'bureau.sqlite');
    const diagnostics: BureauDiagnostic[] = [];
    const holder = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    let reader: TestBureau | undefined;
    try {
      const sessionId = await startRunningSession(holder);
      const session = await holder.getSession(sessionId);
      const kv = holder.kv;
      const runId = session?.metadata['lastRunId'];
      if (session === undefined || kv === undefined || typeof runId !== 'string') {
        throw new Error('expected a durable session and its run');
      }
      // Without an ownership lease, another process can hold the same durable
      // run and log its end first.
      await appendSteeringLogEvent(
        kv,
        sessionId,
        session.incarnation,
        await readSteeringLogHead(kv, sessionId, session.incarnation),
        { type: 'run-ended', runId, now: new Date().toISOString() },
      );
      holder.abortRun(runId);
      // Dispose drains the steering queue the abort's end was logged through.
      await holder.dispose();
      expect(diagnostics.filter((diagnostic) => diagnostic.scope === 'steering')).toEqual([]);

      reader = await openBureau(path);
      const readerKv = reader.kv;
      if (readerKv === undefined) throw new Error('expected a durable store');
      const head = await readSteeringLogHead(readerKv, sessionId, session.incarnation);
      const entries = await readSteeringLogEntries(
        readerKv,
        sessionId,
        session.incarnation,
        0,
        head.sequence,
      );
      expect(entries.filter((event) => event.type === 'run-ended')).toHaveLength(1);
    } finally {
      await holder.dispose();
      await reader?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed on a run ending the log never promoted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-ghost-ending-'));
    const path = join(directory, 'bureau.sqlite');
    const writer = await openBureau(path);
    let reader: TestBureau | undefined;
    try {
      const sessionId = await startRunningSession(writer);
      const session = await writer.getSession(sessionId);
      const kv = writer.kv;
      if (session === undefined || kv === undefined) throw new Error('expected a durable session');
      await appendSteeringLogEvent(
        kv,
        sessionId,
        session.incarnation,
        await readSteeringLogHead(kv, sessionId, session.incarnation),
        { type: 'run-ended', runId: 'never-promoted', now: new Date().toISOString() },
      );
      reader = await openBureau(path);
      await expect(
        reader.submitSteeringCommand(sessionId, {
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        }),
      ).rejects.toThrow(/ending without a promotion/);
    } finally {
      await writer.dispose();
      await reader?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed on an applied event outside its run, and on a key decided twice', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-impossible-history-'));
    const path = join(directory, 'bureau.sqlite');
    const writer = await openBureau(path);
    const readers: TestBureau[] = [];
    try {
      const plant = async (event: Parameters<typeof appendSteeringLogEvent>[4]) => {
        const sessionId = await startRunningSession(writer);
        const session = await writer.getSession(sessionId);
        const kv = writer.kv;
        if (session === undefined || kv === undefined) throw new Error('expected a session');
        await appendSteeringLogEvent(
          kv,
          sessionId,
          session.incarnation,
          await readSteeringLogHead(kv, sessionId, session.incarnation),
          event,
        );
        return sessionId;
      };
      const model = (id: string) =>
        ({
          id,
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        }) as const;

      const ghostApplied = await plant({
        type: 'applied',
        runId: 'never-promoted',
        configVersion: 0,
        now: new Date().toISOString(),
      });
      const reader = await openBureau(path);
      readers.push(reader);
      await expect(reader.submitSteeringCommand(ghostApplied, model('k-a'))).rejects.toThrow(
        /applying a version without a promotion/,
      );

      // A second decision for one key, appended past the binding's guard.
      const twice = await startRunningSession(writer);
      const firstDecision = await writer.submitSteeringCommand(twice, model('k-twice'));
      expect(firstDecision.outcome).toBe('accepted');
      const session = await writer.getSession(twice);
      const kv = writer.kv;
      if (session === undefined || kv === undefined) throw new Error('expected a session');
      const binding = await readSteeringKeyBinding(kv, 'alice', 'k-twice');
      if (binding === undefined) throw new Error('expected k-twice bound');
      await appendSteeringLogEvent(
        kv,
        twice,
        session.incarnation,
        await readSteeringLogHead(kv, twice, session.incarnation),
        {
          type: 'admit',
          command: {
            id: 'k-twice',
            idOrigin: 'caller',
            sessionId: twice,
            principal: 'alice',
            requestedValue: { target: 'model', override: 'claude-opus-4-8' },
            requestedAt: new Date().toISOString(),
          },
          liveRunIds: [],
          now: new Date().toISOString(),
        },
        binding.raw,
      );
      const second = await openBureau(path);
      readers.push(second);
      await expect(second.submitSteeringCommand(twice, model('k-other'))).rejects.toThrow(
        /a second decision for steering key/,
      );
    } finally {
      await writer.dispose();
      for (const reader of readers) await reader.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails closed on a run applying another run's version, and counts a run saved but not yet promoted", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-visible-versions-'));
    const path = join(directory, 'bureau.sqlite');
    const writer = await openBureau(path);
    const readers: TestBureau[] = [];
    try {
      const kv = writer.kv;
      if (kv === undefined) throw new Error('expected a durable store');
      const lastRunIdOf = async (id: string) => {
        const session = await writer.getSession(id);
        return session?.metadata['lastRunId'];
      };

      // A pause bound to the first run is version 1 for that run only.
      const sessionId = await startRunningSession(writer);
      const first = await lastRunIdOf(sessionId);
      await startRunningSession(writer, sessionId);
      const second = await lastRunIdOf(sessionId);
      if (typeof first !== 'string' || typeof second !== 'string') throw new Error('expected runs');
      const paused = await writer.submitSteeringCommand(sessionId, {
        principal: 'alice',
        runId: first,
        requestedValue: { target: 'pause' },
      });
      expect(versionOf(paused)).toBe(1);
      const session = await writer.getSession(sessionId);
      if (session === undefined) throw new Error('expected the session');
      await appendSteeringLogEvent(
        kv,
        sessionId,
        session.incarnation,
        await readSteeringLogHead(kv, sessionId, session.incarnation),
        { type: 'applied', runId: second, configVersion: 1, now: new Date().toISOString() },
      );
      const reader = await openBureau(path);
      readers.push(reader);
      await expect(
        reader.submitSteeringCommand(sessionId, {
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        }),
      ).rejects.toThrow(/which no admission before it issued to that run/);

      // Saved as running a moment before its promotion is logged: steered
      // from elsewhere in that gap, the run is starting, not terminal.
      const store = createSessionStore(kv);
      const gapSession = 'session-saved-not-promoted';
      await store.save(
        createAgentSession({
          id: gapSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: gapSession }),
          metadata: {
            lastRunId: 'saved-run',
            lastRunStatus: 'running',
            steeringStartingRuns: { 'saved-run': new Date().toISOString() },
          },
        }),
      );
      const gapReader = await openBureau(path);
      readers.push(gapReader);
      const named = await gapReader.submitSteeringCommand(gapSession, {
        principal: 'alice',
        runId: 'saved-run',
        requestedValue: { target: 'pause' },
      });
      expect(named.outcome).toBe('accepted');

      // Its workflow may already be visible to a direct read while the log
      // still has no promotion: live and tagged, it still counts.
      const visibleSession = 'session-saved-and-visible';
      await store.save(
        createAgentSession({
          id: visibleSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: visibleSession }),
          metadata: {
            lastRunId: 'visible-run',
            lastRunStatus: 'running',
            steeringStartingRuns: { 'visible-run': new Date().toISOString() },
          },
        }),
      );
      const visible = await store.load(visibleSession);
      if (visible === undefined) throw new Error('expected the session');
      const visibleTag = steeringSessionRunTag(visibleSession, visible.incarnation);
      const engineGet = spyOn(await durableEnginePrototype(), 'get').mockImplementation((id) =>
        Promise.resolve(
          id === 'visible-run' ? { type: 'agentRun', status: 'running', tags: [visibleTag] } : null,
        ),
      );
      try {
        const unscoped = await gapReader.submitSteeringCommand(visibleSession, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        });
        expect(unscoped.outcome).toBe('accepted');
        if (unscoped.outcome !== 'accepted') throw new Error('expected accepted');
        expect(unscoped.command.runId).toBe('visible-run');
      } finally {
        engineGet.mockRestore();
      }

      // A run named while it is still only saved is checked as such even
      // when an older run is already live: that run says nothing about it.
      const concurrentSession = 'session-saved-beside-older';
      await store.save(
        createAgentSession({
          id: concurrentSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: concurrentSession }),
          metadata: {
            lastRunId: 'saved-named',
            lastRunStatus: 'running',
            steeringStartingRuns: { 'saved-named': new Date().toISOString() },
          },
        }),
      );
      const concurrent = await store.load(concurrentSession);
      if (concurrent === undefined) throw new Error('expected the session');
      await appendSteeringLogEvent(
        kv,
        concurrentSession,
        concurrent.incarnation,
        await readSteeringLogHead(kv, concurrentSession, concurrent.incarnation),
        { type: 'promoted', runId: 'older-run', now: new Date().toISOString() },
      );
      const namedSaved = await gapReader.submitSteeringCommand(concurrentSession, {
        principal: 'alice',
        runId: 'saved-named',
        requestedValue: { target: 'pause' },
      });
      expect(namedSaved.outcome).toBe('accepted');

      // The sole live run can change while liveness is read, with a new
      // run saved under its own authority: the caller is checked against
      // the session as it stands after the read, not before it.
      const changingSession = 'session-sole-run-changes';
      await store.save(
        createAgentSession({
          id: changingSession,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: changingSession }),
          metadata: {
            lastRunId: 'run-b',
            lastRunStatus: 'running',
            lastRequestAuthorities: { 'run-b': { principalId: 'bob' } },
          },
        }),
      );
      const changing = await store.load(changingSession);
      if (changing === undefined) throw new Error('expected the session');
      const changingTag = steeringSessionRunTag(changingSession, changing.incarnation);
      const prototype = await durableEnginePrototype();
      const changingGet = spyOn(prototype, 'get').mockImplementation(() => Promise.resolve(null));
      const changingList = spyOn(prototype, 'list').mockImplementation(async () => {
        await store.update(changingSession, (current) =>
          current === undefined
            ? undefined
            : {
                ...current,
                metadata: {
                  ...current.metadata,
                  lastRunId: 'run-a',
                  lastRequestAuthorities: {
                    'run-b': { principalId: 'bob' },
                    'run-a': { principalId: 'alice' },
                  },
                },
              },
        );
        return {
          items: [{ id: 'run-a', type: 'agentRun', status: 'running', tags: [changingTag] }],
        };
      });
      try {
        const sole = await gapReader.submitSteeringCommand(changingSession, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        });
        expect(sole.outcome).toBe('accepted');
        if (sole.outcome !== 'accepted') throw new Error('expected accepted');
        expect(sole.command.runId).toBe('run-a');
      } finally {
        changingGet.mockRestore();
        changingList.mockRestore();
      }

      // Two runs saved as starting at once, before either is promoted: the
      // session's single latest-run field names only the second, but each
      // keeps its own starting entry, so both count.
      const twoStarts = 'session-two-saved-starts';
      const startedAt = new Date().toISOString();
      await store.save(
        createAgentSession({
          id: twoStarts,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: twoStarts }),
          metadata: {
            lastRunId: 'start-two',
            lastRunStatus: 'running',
            steeringStartingRuns: { 'start-one': startedAt, 'start-two': startedAt },
          },
        }),
      );
      const ambiguous = await gapReader.submitSteeringCommand(twoStarts, {
        principal: 'alice',
        requestedValue: { target: 'pause' },
      });
      expect(ambiguous.outcome).toBe('rejected');
      if (ambiguous.outcome !== 'rejected') throw new Error('expected rejected');
      expect(ambiguous.failure.reason).toBe('run-ambiguous');
      const namedFirst = await gapReader.submitSteeringCommand(twoStarts, {
        principal: 'alice',
        runId: 'start-one',
        requestedValue: { target: 'pause' },
      });
      expect(namedFirst.outcome).toBe('accepted');

      // A run the log has ended stays ended while the engine still reports
      // it running: its terminal state lags the event.
      const lagging = 'session-ended-run-lags';
      await store.save(
        createAgentSession({
          id: lagging,
          agentName: 'bureau',
          conversationHistory: createConversationHistory({ id: lagging }),
          metadata: { lastRunId: 'ended-run', lastRunStatus: 'running' },
        }),
      );
      const laggingSession = await store.load(lagging);
      if (laggingSession === undefined) throw new Error('expected the session');
      for (const event of [
        { type: 'promoted', runId: 'ended-run', now: new Date().toISOString() },
        { type: 'run-ended', runId: 'ended-run', now: new Date().toISOString() },
      ] as const) {
        await appendSteeringLogEvent(
          kv,
          lagging,
          laggingSession.incarnation,
          await readSteeringLogHead(kv, lagging, laggingSession.incarnation),
          event,
        );
      }
      const laggingTag = steeringSessionRunTag(lagging, laggingSession.incarnation);
      const stillRunning = {
        id: 'ended-run',
        type: 'agentRun',
        status: 'running',
        tags: [laggingTag],
      };
      const laggingPrototype = await durableEnginePrototype();
      const laggingGet = spyOn(laggingPrototype, 'get').mockImplementation((id) =>
        Promise.resolve(id === 'ended-run' ? stillRunning : null),
      );
      const laggingList = spyOn(laggingPrototype, 'list').mockImplementation(() =>
        Promise.resolve({ items: [stillRunning] }),
      );
      try {
        const endedPause = await gapReader.submitSteeringCommand(lagging, {
          principal: 'alice',
          runId: 'ended-run',
          requestedValue: { target: 'pause' },
        });
        expect(endedPause.outcome).toBe('rejected');
        if (endedPause.outcome !== 'rejected') throw new Error('expected rejected');
        expect(endedPause.failure.reason).toBe('run-terminal');

        // Nor does the lagging run count toward a conclusive listing: with
        // it, one live workflow and one run still starting, two runs are
        // live and an unscoped pause is ambiguous.
        await appendSteeringLogEvent(
          kv,
          lagging,
          laggingSession.incarnation,
          await readSteeringLogHead(kv, lagging, laggingSession.incarnation),
          { type: 'promoted', runId: 'still-starting', now: new Date().toISOString() },
        );
        const otherLive = { ...stillRunning, id: 'other-live' };
        laggingList.mockImplementation(() => Promise.resolve({ items: [stillRunning, otherLive] }));
        const mixed = await gapReader.submitSteeringCommand(lagging, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        });
        expect(mixed.outcome).toBe('rejected');
        if (mixed.outcome !== 'rejected') throw new Error('expected rejected');
        expect(mixed.failure.reason).toBe('run-ambiguous');
      } finally {
        laggingGet.mockRestore();
        laggingList.mockRestore();
      }

      // An applied version below anything the run can report is corrupt.
      const belowFloor = await startRunningSession(writer);
      const belowSession = await writer.getSession(belowFloor);
      if (belowSession === undefined) throw new Error('expected the session');
      await appendSteeringLogEvent(
        kv,
        belowFloor,
        belowSession.incarnation,
        await readSteeringLogHead(kv, belowFloor, belowSession.incarnation),
        {
          type: 'applied',
          runId: belowSession.metadata['lastRunId'] as string,
          configVersion: 0,
          now: new Date().toISOString(),
        },
      );
      const belowReader = await openBureau(path);
      readers.push(belowReader);
      await expect(
        belowReader.submitSteeringCommand(belowFloor, {
          principal: 'alice',
          requestedValue: { target: 'model', override: 'claude-sonnet-5' },
        }),
      ).rejects.toThrow(/which no admission before it issued to that run/);
    } finally {
      await writer.dispose();
      for (const reader of readers) await reader.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('reports a committed deletion as done even when its steering log cannot be removed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-delete-cleanup-'));
    const path = join(directory, 'bureau.sqlite');
    const diagnostics: string[] = [];
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path },
      durableExecution: true,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic.message);
      },
    });
    try {
      const sessionId = await startRunningSession(bureau);
      const kv = bureau.kv;
      if (kv === undefined) throw new Error('expected a durable store');
      const listing = spyOn(kv, 'list').mockImplementation(() =>
        Promise.reject(new Error('listing unavailable')),
      );
      try {
        await bureau.deleteSession(sessionId);
      } finally {
        listing.mockRestore();
      }
      expect(await bureau.getSession(sessionId)).toBeUndefined();
      expect(
        diagnostics.some((message) => message.includes('its steering log could not be removed')),
      ).toBe(true);
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('answers a failed log read only to a caller still authorized for the session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-fold-failure-authority-'));
    const path = join(directory, 'bureau.sqlite');
    const writer = await openBureau(path);
    let reader: TestBureau | undefined;
    try {
      const sessionId = await startRunningSession(writer);
      const model = {
        id: 'k-bound',
        principal: 'alice',
        requestedValue: { target: 'model', override: 'claude-sonnet-5' },
      } as const;
      const decided = await writer.submitSteeringCommand(sessionId, model);
      expect(decided.outcome).toBe('accepted');
      const session = await writer.getSession(sessionId);
      const kv = writer.kv;
      if (session === undefined || kv === undefined) throw new Error('expected a session');
      // The log can no longer be folded, and alice no longer holds the run.
      await appendSteeringLogEvent(
        kv,
        sessionId,
        session.incarnation,
        await readSteeringLogHead(kv, sessionId, session.incarnation),
        { type: 'run-ended', runId: 'never-promoted', now: new Date().toISOString() },
      );
      const runId = session.metadata['lastRunId'] as string;
      await createSessionStore(kv).update(sessionId, (current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              metadata: {
                ...current.metadata,
                lastRequestAuthorities: { [runId]: { principalId: 'bob' } },
              },
            },
      );
      // Her retry of a key bound here skips the up-front checks, so the
      // failed fold is where she must be turned away.
      reader = await openBureau(path);
      expect(await reader.submitSteeringCommand(sessionId, model)).toEqual({
        outcome: 'not-found',
      });
    } finally {
      await writer.dispose();
      await reader?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('records starting entries only where durable steering runs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-non-durable-start-'));
    const bureau = await createBureau({
      agents: {},
      generate: () => new Promise<never>(() => {}),
      toolbox: createToolbox([]),
      storage: { type: 'sqlite', path: join(directory, 'bureau.sqlite') },
      durableExecution: false,
    });
    try {
      const sessionId = await startRunningSession(bureau);
      const session = await bureau.getSession(sessionId);
      expect(session?.metadata['steeringStartingRuns']).toBeUndefined();
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps failing on a live session whose log lost entries, rather than refolding it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-shortened-log-'));
    const path = join(directory, 'bureau.sqlite');
    const bureau = await openBureau(path);
    try {
      const sessionId = await startRunningSession(bureau);
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;
      expect(
        versionOf(await bureau.submitSteeringCommand(sessionId, model('s1', 'claude-sonnet-5'))),
      ).toBe(1);
      expect(
        versionOf(await bureau.submitSteeringCommand(sessionId, model('s2', 'claude-opus-4-8'))),
      ).toBe(2);
      const session = await bureau.getSession(sessionId);
      const kv = bureau.kv;
      if (session === undefined || kv === undefined) throw new Error('expected a session');
      // The head now claims fewer entries than this process already folded.
      const logKeys = await kv.list('steering-log:v1:');
      const headKey = logKeys.find((key) => key.endsWith(':head'));
      if (headKey === undefined) throw new Error('expected a head');
      await kv.set(headKey, JSON.stringify({ sequence: 1 }));
      for (const id of ['s3', 's4']) {
        await expect(
          bureau.submitSteeringCommand(sessionId, model(id, 'claude-sonnet-5')),
        ).rejects.toThrow(/shorter than the 3 entries already folded/);
      }
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed on a key binding that does not name its own admission', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-bad-binding-'));
    const path = join(directory, 'bureau.sqlite');
    const bureau = await openBureau(path);
    try {
      const first = await startRunningSession(bureau);
      const model = (id: string, override: string) =>
        ({ id, principal: 'alice', requestedValue: { target: 'model', override } }) as const;
      expect(
        versionOf(await bureau.submitSteeringCommand(first, model('k1', 'claude-sonnet-5'))),
      ).toBe(1);
      expect(
        versionOf(await bureau.submitSteeringCommand(first, model('k2', 'claude-opus-4-8'))),
      ).toBe(2);

      // Point k1's binding at k2's admission (sequence 3: promoted, k1, k2).
      const kv = bureau.kv;
      if (kv === undefined) throw new Error('expected a durable store');
      const bindingKeys = await kv.list('steering-key:v1:');
      const k1Binding = bindingKeys.find((key) => key.endsWith(':k1'));
      if (k1Binding === undefined) throw new Error('expected k1 bound');
      const binding = JSON.parse((await kv.get(k1Binding)) ?? '{}') as Record<string, unknown>;
      await kv.set(k1Binding, JSON.stringify({ ...binding, sequence: 3 }));

      // An exact retry in the session that decided k1 fails closed too,
      // rather than replaying its folded answer past the bad binding.
      await expect(
        bureau.submitSteeringCommand(first, model('k1', 'claude-sonnet-5')),
      ).rejects.toThrow(/does not name that decision/);
      // ...but only to a caller still authorized there.
      const firstSession = await bureau.getSession(first);
      const firstRun = firstSession?.metadata['lastRunId'];
      if (typeof firstRun !== 'string') throw new Error('expected a run');
      await createSessionStore(kv).update(first, (current) =>
        current === undefined
          ? undefined
          : {
              ...current,
              metadata: {
                ...current.metadata,
                lastRequestAuthorities: { [firstRun]: { principalId: 'bob' } },
              },
            },
      );
      expect(await bureau.submitSteeringCommand(first, model('k1', 'claude-sonnet-5'))).toEqual({
        outcome: 'not-found',
      });

      const other = await startRunningSession(bureau);
      await expect(
        bureau.submitSteeringCommand(other, model('k1', 'claude-sonnet-5')),
      ).rejects.toThrow(/does not admit it/);
    } finally {
      await bureau.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
