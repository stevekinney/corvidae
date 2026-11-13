/**
 * COR-2230 — a pin belongs to the run that wrote it, and a parked run or a recovered schedule fire
 * compares like any other recovered run.
 *
 * A session's metadata names its latest run's pin only, and a session holds runs of several
 * origins: a chat's runs and a schedule fire's approvals are stored under the same session keys
 * and restored at boot together. Each row restarts a Bureau over the same SQLite file under a
 * plugin or overrides that moved, or did not.
 */
import { type GenerateFunction } from '@lostgradient/operative';
import type { AgentOverrides } from './agent-override-store';
import { afterEach, describe, expect, it } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import type { Bureau } from './bureau-types/facade';
import {
  approvalToolbox,
  askingGenerate,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';
import { versionedPlugin } from './testing/versioned-plugin-agent.test-support';

const harness = createScheduleFireHarness();
afterEach(() => harness.dispose());

const SESSION = 'pinned-session';
const AGENT = 'p:echo';

/** A model that never answers its step, until the run is aborted. */
const hanging: GenerateFunction = (context) =>
  new Promise((_resolve, reject) => {
    context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/**
 * Answers its first run (a chat's) plainly, then asks for a charge at step 0 of every run after
 * it (a fire's), and says `done` once a step has a result.
 */
function chatThenCharge(): GenerateFunction {
  let runs = 0;
  return async ({ step }) => {
    if (step > 0) return { content: 'done', toolCalls: [] };
    runs += 1;
    return runs === 1
      ? { content: 'hello', toolCalls: [] }
      : {
          content: '',
          toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
        };
  };
}

/**
 * A Bureau over the SQLite file at `path`, with plugin `p` at `version`. The agent's tool is
 * `charge-card`, which parks on approval, when `charges` is given; else the plugin's own `next`.
 */
async function bureauOver(
  path: string,
  version: string,
  generate: GenerateFunction,
  charges?: number[],
  diagnostics?: string[],
): Promise<Bureau> {
  return harness.open({
    storage: await harness.sqliteStorage(path),
    plugins: [
      versionedPlugin({
        version,
        generate,
        ...(charges === undefined ? {} : { toolbox: approvalToolbox(charges) }),
      }),
    ],
    ...(diagnostics === undefined
      ? {}
      : { onDiagnostic: (event: { message: string }) => void diagnostics.push(event.message) }),
  });
}

async function setOverrides(bureau: Bureau, overrides: AgentOverrides): Promise<void> {
  const state = await bureau.agents.overrides.get(AGENT);
  if (state === undefined) throw new Error(`Expected "${AGENT}" to take overrides.`);
  await bureau.agents.overrides.save(AGENT, overrides, { expectedHash: state.hash });
}

const approve = (bureau: Bureau, id: string) =>
  bureau.reviews.resolve({ id, decision: 'approve', principal: OWNER.alice });

describe('COR-2230 row F1: a new message in an existing chat after the plugin or its overrides moved', () => {
  const plain: GenerateFunction = async () => ({ content: 'hello', toolCalls: [] });

  /** Finishes a chat message at `version` over the file at `path`, and returns the Bureau. */
  async function finishedChatAt(path: string, version: string, overrides?: AgentOverrides) {
    const bureau = await bureauOver(path, version, plain);
    if (overrides !== undefined) await setOverrides(bureau, overrides);
    const run = await bureau.tasks.start(AGENT, 'hello', {
      contextId: SESSION,
      principal: OWNER.alice,
    });
    await pollUntil(async () => {
      const detail = await bureau.tasks.detail(run.id);
      return detail?.status === 'completed' ? true : undefined;
    }, 'the chat run to finish');
    return { bureau, runId: run.id };
  }

  it.each([
    ['the plugin version was bumped', '1.1.0', undefined, '1.1.0'],
    ['the overrides were saved', '1.0.0', { instructions: 'Saved between the messages.' }, '1.0.0'],
  ] as const)(
    'completes, pins the values now in force and is compared with none, when %s',
    async (_label, secondVersion, secondOverrides, pinnedVersion) => {
      const path = harness.nextDatabasePath();
      const { runId: firstRunId, bureau: first } = await finishedChatAt(path, '1.0.0');
      const firstSession = await first.contexts.get(SESSION);
      const firstPin = firstSession?.metadata;
      expect(firstPin).toMatchObject({
        lastAgentPinRunId: firstRunId,
        lastAgentPluginVersion: '1.0.0',
      });

      const second = await finishedChatAt(path, secondVersion, secondOverrides);

      const secondSession = await second.bureau.contexts.get(SESSION);
      const pinned = secondSession?.metadata;
      expect(second.runId).not.toBe(firstRunId);
      expect(pinned).toMatchObject({
        lastRunStatus: 'completed',
        lastAgentPinRunId: second.runId,
        lastAgentPluginVersion: pinnedVersion,
        lastAgentOverrideHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(pinned?.['lastError']).toBeUndefined();
      // The overrides in force when the second message started are the pin, never the first's.
      if (secondOverrides !== undefined) {
        expect(pinned?.['lastAgentOverrideHash']).not.toBe(firstPin?.['lastAgentOverrideHash']);
      }
    },
  );
});

describe('a pin belongs to the run that wrote it', () => {
  it('is not compared with the approval of a schedule fire in the session of a chat run that wrote it', async () => {
    const path = harness.nextDatabasePath();
    const charges: number[] = [];
    const generate = chatThenCharge();
    const first = await bureauOver(path, '1.0.0', generate, charges);
    // A chat run pins version 1.0.0 and the overrides in force (none) in the session.
    const chat = await first.tasks.start(AGENT, 'hello', {
      contextId: SESSION,
      principal: OWNER.alice,
    });
    await pollUntil(async () => {
      const run = await first.tasks.detail(chat.id);
      return run?.status === 'completed' ? true : undefined;
    }, 'the chat run to finish');
    // Nothing changes after the fire starts: the override is saved before it.
    await setOverrides(first, { instructions: 'Saved after the chat.' });
    const { fireId } = await fireOnce(first, OWNER.alice, SESSION, AGENT);
    await reviewOf(first, fireId);

    const restarted = await bureauOver(path, '1.0.0', chatThenCharge(), charges);
    const restored = await reviewOf(restarted, fireId);
    await approve(restarted, restored.id);

    await pollUntil(() => (charges.length > 0 ? true : undefined), 'the approved charge to run');
    expect(charges).toEqual([4242]);
  });
});

describe('a run parked on a human wait or a tool approval when the plugin moves across a restart', () => {
  it('settles failed with definition-drifted, and never runs a step under the new version (a human wait)', async () => {
    const path = harness.nextDatabasePath();
    const first = await bureauOver(path, '1.0.0', askingGenerate());
    const run = await first.tasks.start(AGENT, 'which environment?', { principal: OWNER.alice });
    await reviewOf(first, run.id);

    const seen: string[] = [];
    const restarted = await bureauOver(path, '1.1.0', askingGenerate('answer', seen));
    const status = await pollUntil(async () => {
      const session = await restarted.contexts.get(run.contextId);
      const state = session?.metadata['lastRunStatus'];
      return state === 'running' || state === undefined ? undefined : state;
    }, 'the parked run to settle');

    expect(status).toBe('error');
    const session = await restarted.contexts.get(run.contextId);
    expect(session?.metadata['lastError']).toContain('definition-drifted');
    expect(session?.metadata['lastError']).toMatch(/version was 1\.0\.0 and is now 1\.1\.0/);
    expect(seen).toEqual([]);
  });

  // The run that raised a tool approval has already ended; its approval is what waits. So the
  // approval is what a drifted agent refuses: it is not restored, and the charge never runs.
  it('is restored and runs its charge when the plugin did not move (a tool approval)', async () => {
    const path = harness.nextDatabasePath();
    const first = await bureauOver(path, '1.0.0', chargesAtStepZero(), []);
    const run = await first.tasks.start(AGENT, 'charge', { principal: OWNER.alice });
    await reviewOf(first, run.id);

    const charges: number[] = [];
    const restarted = await bureauOver(path, '1.0.0', chargesAtStepZero(), charges);
    const restored = await reviewOf(restarted, run.id);
    await approve(restarted, restored.id);

    await pollUntil(() => (charges.length > 0 ? true : undefined), 'the approved charge to run');
    expect(charges).toEqual([4242]);
  });

  it('is not restored, naming definition-drifted, and runs no charge (a tool approval)', async () => {
    const path = harness.nextDatabasePath();
    const first = await bureauOver(path, '1.0.0', chargesAtStepZero(), []);
    const run = await first.tasks.start(AGENT, 'charge', { principal: OWNER.alice });
    await reviewOf(first, run.id);

    const charges: number[] = [];
    const diagnostics: string[] = [];
    const restarted = await bureauOver(path, '1.1.0', chargesAtStepZero(), charges, diagnostics);
    await pollUntil(
      () => diagnostics.find((message) => message.includes(run.id)),
      'the restore to report the run',
    );

    expect(diagnostics.join('\n')).toContain('definition-drifted');
    expect(diagnostics.join('\n')).toMatch(/version was 1\.0\.0 and is now 1\.1\.0/);
    expect(restarted.reviews.list().filter((review) => review.runId === run.id)).toEqual([]);
    expect(charges).toEqual([]);
  });
});

/** Asks for a charge at step 0, which parks on approval. */
function chargesAtStepZero(): GenerateFunction {
  return async ({ step }) =>
    step === 0
      ? {
          content: '',
          toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
        }
      : { content: 'charged', toolCalls: [] };
}

describe('a schedule fire recovered after the plugin or its overrides moved', () => {
  /** A fire that takes step 0 (writing its pin), then dies in step 1. */
  async function fireDyingInStepOne() {
    const path = harness.nextDatabasePath();
    const dying: GenerateFunction = async (context) =>
      context.step === 0
        ? { content: 'step 0', toolCalls: [{ id: 'next-1', name: 'next', arguments: {} }] }
        : hanging(context);
    const first = await bureauOver(path, '1.0.0', dying);
    const { fireId } = await fireOnce(first, OWNER.alice, SESSION, AGENT);
    await pollUntil(async () => {
      const session = await first.contexts.get(SESSION);
      return session?.metadata['lastScheduledFireRunId'] === fireId ? true : undefined;
    }, 'the fire to write its first step');
    return { path, fireId, first };
  }

  const resumed: GenerateFunction = async ({ step }) => ({
    content: `resumed at step ${step}`,
    toolCalls: [],
  });

  const restartedAs = (path: string, version: string) => bureauOver(path, version, resumed);

  it('resumes and completes when nothing moved', async () => {
    const { path, fireId } = await fireDyingInStepOne();
    const restarted = await restartedAs(path, '1.0.0');
    await pollUntil(async () => {
      const status = await durableStatus(restarted, fireId);
      return status === 'completed' ? true : undefined;
    }, 'the recovered fire to complete');
  });

  it('is refused when the plugin version moved: the fire fails and runs nothing under the new version', async () => {
    const { path, fireId } = await fireDyingInStepOne();
    const restarted = await restartedAs(path, '1.1.0');
    const status = await pollUntil(async () => {
      const state = await durableStatus(restarted, fireId);
      return state === 'failed' || state === 'completed' ? state : undefined;
    }, 'the recovered fire to settle');
    expect(status).toBe('failed');
    const session = await restarted.contexts.get(SESSION);
    expect(JSON.stringify(session?.conversationHistory)).not.toContain('resumed at step');
  });

  it('is refused when its overrides moved', async () => {
    const { path, fireId, first } = await fireDyingInStepOne();
    // Saved after the fire took its first step, and before the restart.
    await setOverrides(first, { instructions: 'B.' });
    const restarted = await restartedAs(path, '1.0.0');
    const status = await pollUntil(async () => {
      const state = await durableStatus(restarted, fireId);
      return state === 'failed' || state === 'completed' ? state : undefined;
    }, 'the recovered fire to settle');
    expect(status).toBe('failed');
  });
});
