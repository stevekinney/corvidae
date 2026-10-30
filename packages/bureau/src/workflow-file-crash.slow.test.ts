/**
 * COR-1527 — a workflow instance killed with its process resumes on the revision it began on, and a
 * step's agent run is started once. A child process starts instances and is killed with SIGKILL;
 * the parent then changes the files the way a person would and boots a Bureau over the child's
 * store. The scenarios boot real processes and wait out a real claim lapse, so each runs once at
 * module scope (`test/hoisted-scenario.ts`) and its tests report how it went.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { KEYS } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { unexpectedChildStderr } from './test/child-stderr';
import {
  expectScenarioPassed,
  type ScenarioScope,
  settleScenario,
  waitForBureauState,
} from './test/hoisted-scenario';
import { CLAIM_RENEW_MS, CLAIM_TTL_MS } from './test/process-crash-work-integrity-fixtures';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { workflowStepRunId } from './workflow-agent-step';
import type { Bureau } from './types';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import type { Storage } from '@lostgradient/storage';

const CHILD = join(import.meta.dir, 'test', 'workflow-file-crash-child.ts');
const runtime = createDefaultRuntimeServices();
const HANG_GUARD_MILLISECONDS = 180_000;

const agentStep = (message: string) => ({
  kind: 'activity',
  handler: 'agent',
  input: { agent: 'writer', message },
});

function openBureau(storage: Storage, workflows: string, messages: string[]): Promise<Bureau> {
  const agents: AgentDefinitions = {
    writer: createAgent({
      name: 'writer',
      generate: async ({ conversation }) => {
        const message = conversation.getMessages().findLast((entry) => entry.role === 'user');
        const text = typeof message?.content === 'string' ? message.content : '';
        messages.push(text.split('\n')[0] ?? '');
        return { content: `resumed: ${text.split('\n')[0]}`, toolCalls: [] };
      },
    }),
  };
  return createBureau<AgentDefinitions>({
    agents: { ...agents },
    workflowSource: workflowFileDirectory(workflows),
    storage,
    durable: true,
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });
}

async function killChild(
  scope: ScenarioScope,
  mode: 'parked' | 'claim',
  storagePath: string,
  workflows: string,
  markerPath: string,
): Promise<void> {
  const child = spawnWithHangGuard(['bun', CHILD, mode, storagePath, workflows, markerPath], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  scope.onHang(() => child.kill('SIGKILL'));
  await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect(child.signalCode ?? unexpectedChildStderr(stderr)).toBe('SIGKILL');
  expect(existsSync(markerPath)).toBe(true);
}

async function parkedScenario(scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-workflow-crash-'));
  const workflows = join(directory, 'workflows');
  mkdirSync(workflows);
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  // The child writes the store and is killed; this handle is opened only after it is gone.
  const store = createSqliteStorageFixture({ path: storagePath });
  let bureau: Bureau | undefined;
  scope.onHang(async () => {
    await bureau?.shutdown();
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  const trigger = { kind: 'schedule', spec: '1h' };
  try {
    writeFileSync(
      join(workflows, 'sleeper.json'),
      workflowFileText('sleeper', {
        trigger,
        steps: [{ kind: 'sleep', duration: '2s' }, agentStep('sleeper original')],
      }),
    );
    writeFileSync(
      join(workflows, 'waiter.json'),
      workflowFileText('waiter', {
        trigger,
        steps: [{ kind: 'await-signal', signal: 'go' }, agentStep('waiter original')],
      }),
    );
    writeFileSync(
      join(workflows, 'midstep.json'),
      workflowFileText('midstep', { trigger, steps: [agentStep('midstep')] }),
    );
    await killChild(scope, 'parked', storagePath, workflows, markerPath);

    // What a person does while the process is down: edit one workflow, delete another.
    writeFileSync(
      join(workflows, 'sleeper.json'),
      workflowFileText('sleeper', {
        trigger,
        steps: [{ kind: 'sleep', duration: '2s' }, agentStep('sleeper REWRITTEN')],
      }),
    );
    rmSync(join(workflows, 'waiter.json'));
    // The dead holder's claim lapses on Weft's own wall clock.
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    const messages: string[] = [];
    bureau = await openBureau(store.storage, workflows, messages);
    const report = await bureau.recovery();
    expect(report.perRunFailures).toEqual([]);
    expect(report.outcome).toBe('clean');
    // The file for `waiter` is gone, and `sleeper` is the rewritten one.
    expect(bureau.workflows?.list().map((entry) => entry.id)).toEqual(['midstep', 'sleeper']);

    const engine = bureau.durableEngine()!;
    await engine.signal('waiter-run', 'go', { resumed: true });
    for (const id of ['sleeper-run', 'waiter-run', 'midstep-run']) {
      await bureau.tasks.wait(id);
    }
    await waitForBureauState([bureau], async () => {
      const states = await Promise.all(
        ['sleeper-run', 'waiter-run', 'midstep-run'].map((id) => bureau!.tasks.workflow(id)),
      );
      return states.every((state) => state?.status === 'completed');
    });

    // Each resumed on the document it began on: the waiter's file is gone and the sleeper's was
    // rewritten, and the model was asked what the original documents said.
    expect(messages.toSorted()).toEqual(['midstep', 'sleeper original', 'waiter original']);
    const sleeper = await bureau.workflows?.getRun('sleeper-run');
    const sleeperRevisions = await bureau.workflows?.revisions('sleeper');
    expect(sleeper?.status).toBe('completed');
    expect(sleeperRevisions?.map((revision) => revision.workflowVersion)).toContain(
      sleeper?.workflowVersion,
    );
    expect(bureau.workflows?.list().find((entry) => entry.id === 'sleeper')?.version).not.toBe(
      sleeper?.workflowVersion,
    );
    // The deleted workflow keeps nothing scheduled.
    const live = await bureau.schedules.list({ status: ['active', 'paused'] });
    expect(live?.items.map((schedule) => schedule.id).toSorted()).toEqual([
      'bureau-workflow-schedule:midstep:1',
      'bureau-workflow-schedule:sleeper:1',
    ]);

    // Exactly one agent run for each step, and each is one task of its instance (COR-1868): the
    // restart wrote no second record for a run the dead process had started.
    const stepRuns = await engine.list({ type: 'agentRun', idPrefix: 'workflow-agent-' });
    expect(stepRuns.items).toHaveLength(3);
    for (const stepRun of stepRuns.items) {
      const record = await bureau.internals.taskRegistry.record(stepRun.id);
      expect(record).toMatchObject({ owner: 'anonymous:local', origin: { kind: 'parent' } });
    }
    const page = await bureau.internals.taskRegistry.enumerate({ limit: 100, offset: 0 });
    expect(page.tasks.map((task) => task.id).toSorted()).toEqual(
      stepRuns.items.map((stepRun) => stepRun.id).toSorted(),
    );
  } finally {
    const shutdown = await bureau?.shutdown();
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
    if (shutdown !== undefined) expect(shutdown.unresolved).toBe(0);
  }
}

async function claimScenario(scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'corvidae-workflow-claim-'));
  const workflows = join(directory, 'workflows');
  mkdirSync(workflows);
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  // The child writes the store and is killed; this handle is opened only after it is gone.
  const store = createSqliteStorageFixture({ path: storagePath });
  let bureau: Bureau | undefined;
  scope.onHang(async () => {
    await bureau?.shutdown();
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  try {
    writeFileSync(
      join(workflows, 'claimed.json'),
      workflowFileText('claimed', {
        trigger: { kind: 'schedule', spec: '1h' },
        steps: [agentStep('claimed step')],
      }),
    );
    await killChild(scope, 'claim', storagePath, workflows, markerPath);
    // The kill landed in the window: the step's run is claimed, and the engine has no workflow for it.
    const stepRunId = workflowStepRunId('claimed-run', 0);
    const inspected = store.storage;
    expect(await inspected.get(`bureau-catalog-run:${stepRunId}`)).not.toBeNull();
    expect(await inspected.get(KEYS.workflow(stepRunId))).toBeNull();
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    const messages: string[] = [];
    bureau = await openBureau(store.storage, workflows, messages);
    const report = await bureau.recovery();
    expect(report?.perRunFailures).toEqual([]);
    await bureau.tasks.wait('claimed-run');
    const state = await bureau.tasks.workflow('claimed-run');
    expect(state?.status).toBe('completed');
    const summary = state?.result as { content: string } | undefined;
    expect(summary?.content).toBe('resumed: claimed step');
    // The run the dead process only claimed was started once, by the step that ran again.
    expect(messages).toEqual(['claimed step']);
    const stepRuns = await bureau
      .durableEngine()!
      .list({ type: 'agentRun', idPrefix: 'workflow-agent-' });
    expect(stepRuns.items).toHaveLength(1);
    // The step that ran again continued the dead process's claim, so the task carries the origin
    // the claim stored, and there is one record for the one run (COR-1868).
    const stepTask = await bureau.internals.taskRegistry.record(stepRuns.items[0]!.id);
    expect(stepTask).toMatchObject({
      owner: 'anonymous:local',
      origin: { kind: 'parent', parentRunId: 'claimed-run' },
    });
  } finally {
    const shutdown = await bureau?.shutdown();
    await store.dispose();
    rmSync(directory, { recursive: true, force: true });
    if (shutdown !== undefined) expect(shutdown.unresolved).toBe(0);
  }
}

const parkedOutcome = await settleScenario(parkedScenario, HANG_GUARD_MILLISECONDS);
const claimOutcome = await settleScenario(claimScenario, HANG_GUARD_MILLISECONDS);

describe('workflow instances killed with their process', () => {
  it('resume on the revision they began on after a file was edited or deleted, and start each step’s agent run once', () => {
    expectScenarioPassed(parkedOutcome);
  });

  it('start the agent run of a step whose run was only claimed when the process died', () => {
    expectScenarioPassed(claimOutcome);
  });
});
