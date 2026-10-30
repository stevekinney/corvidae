/**
 * AB-359 — the LMDB variant of "bureau.eventHistory run ownership survives a
 * process restart" (the SQLite variant lives in `create-bureau.test.ts`,
 * alongside the rest of that suite's recovery tests). Bureau A runs in a real
 * child process that is killed with SIGKILL (COR-1767).
 *
 * It lives in its own file because it needs a real per-iteration poll delay.
 * A zero-delay macrotask poll (the kind `create-bureau.test.ts` uses) starves
 * LMDB's async completion callbacks, so this test polls with a tiny real
 * delay instead (see `pollUntilWithRealDelay` below).
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { stopWhen, createAgent } from '@lostgradient/operative';
import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import type { AgentDefinitions } from './agent-catalog';
import { expectScenarioPassed, settleScenario } from './test/hoisted-scenario';
import { createLmdbStorageFixture } from './test/storage-fixtures';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { readChildJson } from './test/child-output-file';

const CHILD = join(import.meta.dir, 'test', 'event-history-owner-crash-child.ts');

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

/**
 * A zero-delay macrotask poll starves LMDB's own async completion callbacks
 * under this suite's load — see this file's own doc comment. A bounded,
 * condition-checked poll with a real (tiny) per-iteration delay, never a
 * blind sleep-then-assume.
 */
async function pollUntilWithRealDelay(check: () => boolean | Promise<boolean>): Promise<true> {
  await waitUntil(check, { message: 'pollUntilWithRealDelay' });
  return true;
}

function recoveredToolCallId(page: { events: readonly { payload?: unknown }[] }): string {
  const payload = page.events[0]?.payload as
    { steps?: { toolCalls?: { id?: string }[] }[] } | undefined;
  const id = payload?.steps?.[0]?.toolCalls?.[0]?.id;
  if (typeof id !== 'string') throw new Error('recovered page carries no step-0 tool-call id');
  return id;
}

/**
 * The exact page bureau B must reconstruct: bureau A's durable step 0 plus
 * B's own step 1, so the step contents prove recovery resumed from A's saved
 * cursor rather than re-running from step 0. Only the emission time and the
 * generated tool-call id are left loose; the id is checked for internal
 * consistency by the caller.
 */
function expectedRecoveredPage(runId: string, toolCallId: string): unknown {
  // COR-1810: an agent that names its model and runs with no selection plan reads `pinned`.
  const planReason = {
    code: 'pinned',
    detail: 'The agent names its model; no selection plan ran',
    rejected: [],
  };
  const stepZero = {
    step: 0,
    content: 'A step 0',
    parts: [{ type: 'text', text: 'A step 0' }],
    messageId: expect.any(String),
    planReason,
    toolCalls: [{ id: toolCallId, name: 'next', arguments: {} }],
    results: [
      {
        callId: toolCallId,
        outcome: 'success',
        content: 'ok',
        toolCallId,
        toolName: 'next',
        result: 'ok',
        executedArgumentsEdited: false,
      },
    ],
    final: false,
  };
  const stepOne = {
    step: 1,
    content: 'B recovered step 1',
    parts: [{ type: 'text', text: 'B recovered step 1' }],
    messageId: expect.any(String),
    planReason,
    toolCalls: [],
    results: [],
    metadata: { __bureauActiveSkills: { version: 2, entries: [] } },
    final: true,
  };
  const usage = { prompt: 0, completion: 0, total: 0 };
  // COR-713: the run-wide parts, step by step, in the event's payload and in its result.
  const parts = [
    { type: 'text', text: 'A step 0' },
    { type: 'text', text: 'B recovered step 1' },
  ];
  return {
    events: [
      {
        kind: 'run.completed',
        owner: { kind: 'run', id: runId },
        sequence: 1,
        cursor: '1',
        emittedAtMs: expect.any(Number),
        schemaVersion: 1,
        payload: {
          isTrusted: false,
          result: {
            steps: [stepZero, stepOne],
            content: 'B recovered step 1',
            parts,
            usage,
            finishReason: 'stop-condition',
          },
          steps: [stepZero, stepOne],
          content: 'B recovered step 1',
          parts,
          usage,
          finishReason: 'stop-condition',
          costEstimate: undefined,
          error: undefined,
          output: undefined,
          schemaValidation: undefined,
        },
      },
      {
        kind: 'run.settled',
        owner: { kind: 'run', id: runId },
        sequence: 2,
        cursor: '2',
        emittedAtMs: expect.any(Number),
        schemaVersion: 1,
        payload: { runId },
      },
    ],
    hasMore: false,
    nextCursor: '2',
  };
}

/** What the crash child wrote once bureau A's run had durably committed step 0. */
interface Marker {
  readonly runId: string;
  readonly contextId: string;
}

/**
 * Bureau A runs in a child process the test kills with SIGKILL once step 0 is durably committed,
 * so the store holds a genuinely non-terminal workflow and no live engine (COR-1767). Bureau B
 * then opens the store through the fixture, whose handle is opened only after the child is gone:
 * LMDB's single writer is never shared within one process.
 */
const outcome = await settleScenario(async (scope) => {
  await using database = createLmdbStorageFixture();
  const markerPath = `${database.path}-marker.json`;
  const child = spawnWithHangGuard(['bun', CHILD, database.path, markerPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  scope.onHang(() => child.kill('SIGKILL'));
  try {
    await waitUntil(() => existsSync(markerPath) || child.exitCode !== null, {
      message: 'the crash child to commit step 0',
    });
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
  const stderr = await new Response(child.stderr).text();
  // The test kills the child, so any other exit means bureau A never reached its crash point.
  expect(child.signalCode ?? stderr).toBe('SIGKILL');
  const run = readChildJson<Marker>(markerPath);
  rmSync(markerPath, { force: true });

  const bureauB = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => ({ content: `B recovered step ${step}`, toolCalls: [] }),
        toolbox: createToolbox([createNextTool()]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: database.storage,
    durable: true,
    durableOwnership: { ownership: 'none' },
  });

  try {
    // `undefined` (not yet registered by `reattachRecoveredRun`) is NOT
    // a terminal status — keep polling for it exactly like `'running'`,
    // rather than a bare `!== 'running'` check that would read
    // "not yet recovered" as "already done" (copilot review, PR #564).
    await pollUntilWithRealDelay(() => {
      const status = bureauB.tasks.detail(run.runId)?.status;
      return status !== undefined && status !== 'running';
    });

    const recovered = bureauB.tasks.detail(run.runId);
    expect(recovered).toMatchObject({
      id: run.runId,
      sessionId: run.contextId,
      status: 'completed',
      principal: 'alice',
      steps: 1,
      finishReason: 'stop-condition',
      usage: { prompt: 0, completion: 0, total: 0 },
    });

    const asOwner = await bureauB.tasks.events(run.runId, { principal: 'alice' });
    if ('outcome' in asOwner) {
      throw new Error(`expected a page for the owning principal, got ${JSON.stringify(asOwner)}`);
    }
    const toolCallId = recoveredToolCallId(asOwner);
    expect(toolCallId).toMatch(/^tool-call-/);
    expect(asOwner as unknown).toEqual(expectedRecoveredPage(run.runId, toolCallId));

    const asStranger = await bureauB.tasks.events(run.runId, { principal: 'mallory' });
    expect(asStranger).toEqual({ outcome: 'not-found' });

    // A trusted caller that omits `principal` entirely still bypasses
    // the check, exactly as it does for a never-restarted run.
    const trusted = await bureauB.tasks.events(run.runId);
    if ('outcome' in trusted) {
      throw new Error(`expected a page for a trusted caller, got ${JSON.stringify(trusted)}`);
    }
    expect(trusted as unknown).toEqual(expectedRecoveredPage(run.runId, toolCallId));

    // A run id the recovered bureau never registered has no status;
    // a trusted caller reading it gets an empty page, not another run's
    // events.
    expect(bureauB.tasks.detail('run-that-never-existed')).toBeUndefined();
    expect(await bureauB.tasks.events('run-that-never-existed')).toEqual({
      events: [],
      hasMore: false,
    });
  } finally {
    await bureauB.dispose();
  }
}, HANG_GUARD_MILLISECONDS);

describe('bureau.eventHistory run ownership survives a process restart over LMDB (AB-359)', () => {
  it('a run dispatched with a principal, recovered over LMDB in a fresh process, is readable by that principal and denied to another', () => {
    expectScenarioPassed(outcome);
  });
});
