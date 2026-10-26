/**
 * Durable steering with two live Bureau processes over one backend, for the cases that wait on
 * the steering poll itself.
 *
 * Each run here learns of a command or a deletion admitted in the other Bureau only from its own
 * log poll, which runs every two seconds on real time, so each test waits out one or two polls.
 * That is real elapsed time, not redundant work, which is why these live in the `test:slow` lane
 * (COR-1576). The rest of the suite is in `steering-multi-instance.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { readSteeringLogHead } from './steering-log';
import type { AgentDefinitions } from './agent-catalog';
import { awakeTurns } from '@lostgradient/testing/wait-until';

async function openBureau(path: string) {
  return createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: () => new Promise<never>(() => {}),
        toolbox: createToolbox([]),
      }),
    },
    storage: { type: 'sqlite', path },
    durableExecution: true,
  });
}

describe('durable steering across two Bureau processes', () => {
  it('aborts a run that is not paused when another process deletes its session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-steering-remote-delete-running-'));
    const path = join(directory, 'bureau.sqlite');
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let generateCalls = 0;
    const bureauA = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
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
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'sqlite', path },
      durableExecution: true,
    });
    const bureauB = await openBureau(path);
    try {
      const run = await bureauA.createRun({
        agentName: 'default',
        message: 'go',
        principal: 'alice',
      });
      for await (const attempt of awakeTurns()) {
        if (!(generateCalls === 0)) break;
        await Bun.sleep(10);
      }
      // B deletes the session; A learns of it from its poll and aborts the
      // run as its own deletion would, rather than letting it keep working.
      await bureauB.deleteSession(run.sessionId);
      for await (const attempt of awakeTurns()) {
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
  });

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
    const bureauA = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
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
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'sqlite', path },
      durableExecution: true,
    });
    const bureauB = await openBureau(path);
    try {
      const run = await bureauA.createRun({
        agentName: 'default',
        message: 'go',
        principal: 'alice',
      });
      for await (const attempt of awakeTurns()) {
        if (!(generateCalls === 0)) break;
        await Bun.sleep(10);
      }

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
      for await (const attempt of awakeTurns()) {
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
      for await (const attempt of awakeTurns()) {
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
  });

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
    const bureauA = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
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
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: { type: 'sqlite', path },
      durableExecution: true,
    });
    const bureauB = await openBureau(path);
    try {
      const run = await bureauA.createRun({
        agentName: 'default',
        message: 'go',
        principal: 'alice',
      });
      for await (const attempt of awakeTurns()) {
        if (!(generateCalls === 0)) break;
        await Bun.sleep(10);
      }
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
      for await (const attempt of awakeTurns()) {
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
        const second = await bureauA.createRun({
          agentName: 'default',
          message: 'again',
          principal: 'alice',
        });
        for await (const attempt of awakeTurns()) {
          if (!(generateCalls < 3)) break;
          await Bun.sleep(10);
        }
        const pausedAgain = await bureauA.submitSteeringCommand(second.sessionId, {
          principal: 'alice',
          requestedValue: { target: 'pause' },
        });
        expect(pausedAgain.outcome).toBe('accepted');
        releaseSecondTool?.();
        for await (const attempt of awakeTurns()) {
          if (intervals.mock.calls.some(([, delay]) => delay === 2_000)) break;
          await Bun.sleep(10);
        }
        const watchIndex = intervals.mock.calls.findIndex(([, delay]) => delay === 2_000);
        expect(watchIndex).toBeGreaterThanOrEqual(0);
        const watch = intervals.mock.results[watchIndex]?.value;
        bureauA.abortRun(second.id);
        for await (const attempt of awakeTurns()) {
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
  });
});
