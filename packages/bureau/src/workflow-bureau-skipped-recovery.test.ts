/**
 * COR-1583 — a run whose workflow type is not registered must never stop the other runs in the
 * store from recovering, and Bureau must say which runs it left behind. Two stores reach that
 * state: one whose last trace of a workflow is gone, and one opened by a Bureau that has no
 * `workflowDirectory` at all.
 */
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import { pollUntil } from './testing/goal-fixtures.test-support';
import { scriptedAgents, startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import type { AgentDefinitions } from './agent-catalog';
import type { BureauDiagnostic } from './types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const parked = (question: string) => ({
  trigger: { kind: 'schedule', spec: '1h' },
  steps: [
    { kind: 'await-signal', signal: 'go' },
    { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: question } },
  ],
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-skipped-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

const recoveryDiagnostics = (diagnostics: readonly BureauDiagnostic[]) =>
  diagnostics.filter((diagnostic) => diagnostic.scope === 'recovery');

describe('a Bureau over a store with a run of a workflow type it has no trace of', () => {
  it('recovers the registered run, reports exactly the skipped run, and recovers it on a later boot once its type is registered', async () => {
    const root = await temporaryRoot();
    const workflows = join(root, 'workflows');
    const diagnostics: BureauDiagnostic[] = [];
    const overrides = {
      storage: { type: 'sqlite', path: join(root, 'bureau.sqlite') },
      durableOwnership: { ownership: 'none' },
      onDiagnostic: (diagnostic: BureauDiagnostic) => diagnostics.push(diagnostic),
    } as const;
    const strandedText = workflowFileText('stranded', parked('stranded question'));

    const first = await startWorkflowBureau({ directory: workflows, overrides });
    await first.put('stranded.json', strandedText);
    await first.put('healthy.json', workflowFileText('healthy', parked('healthy question')));
    await first.bureau.workflows?.refresh();
    const engine = first.bureau.durableEngine()!;
    await engine.start('stranded', null, { id: 'stranded-run' });
    await engine.start('healthy', null, { id: 'healthy-run' });
    // The last trace of `stranded` goes: its stored revisions, with its file.
    for (const key of await first.bureau.kv!.list('bureau-workflow-snapshot:v1:stranded:')) {
      await first.bureau.kv!.delete(key);
    }
    await first.dispose();
    await unlink(join(workflows, 'stranded.json'));
    diagnostics.length = 0;

    const second = await startWorkflowBureau({ directory: workflows, overrides });
    const report = await second.bureau.waitForRecovery?.();
    expect(report?.outcome).toBe('partial');
    expect(report?.skippedRuns).toEqual([{ runId: 'stranded-run', type: 'stranded' }]);
    expect(report?.perRunFailures).toEqual([]);
    expect(report?.batchFailure).toBeUndefined();
    const skipped = recoveryDiagnostics(diagnostics).filter((diagnostic) =>
      diagnostic.message.includes('stranded-run'),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.message).toContain('"stranded"');
    expect(recoveryDiagnostics(diagnostics)).toHaveLength(1);

    await second.bureau.durableEngine()!.signal('healthy-run', 'go', null);
    const healthy = await second.bureau.waitForDurableRun('healthy-run');
    expect(healthy?.status).toBe('completed');
    expect(second.calls.map((call) => call.message)).toEqual(['healthy question']);
    // The skipped run is untouched in storage.
    const untouched = await second.bureau.durableEngine()!.get('stranded-run');
    expect(untouched?.status).toBe('running');
    await second.dispose();

    // Its file is back: the type is registered and the run resumes where it parked.
    diagnostics.length = 0;
    await writeFile(join(workflows, 'stranded.json'), strandedText);
    const third = await startWorkflowBureau({ directory: workflows, overrides });
    cleanups.push(() => third.dispose());
    expect(await third.bureau.waitForRecovery?.()).toEqual({
      outcome: 'clean',
      perRunFailures: [],
      skippedRuns: [],
    });
    expect(recoveryDiagnostics(diagnostics)).toEqual([]);
    await third.bureau.durableEngine()!.signal('stranded-run', 'go', null);
    const resumed = await third.bureau.waitForDurableRun('stranded-run');
    expect(resumed?.status).toBe('completed');
    expect(third.calls.map((call) => call.message)).toEqual(['stranded question']);
  });
});

describe('a Bureau started without workflowDirectory over a store with workflow instances in flight', () => {
  it('boots, recovers every other run, and reports the workflow instances it left behind', async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, 'bureau.sqlite');
    const diagnostics: BureauDiagnostic[] = [];
    const nextTool = createTool({
      name: 'next',
      description: 'continue',
      input: z.object({}),
      execute: async () => 'ok',
    });

    // The first Bureau has a workflow file, an instance of it parked on a signal, and an agent run
    // that is mid-flight. It is never disposed, which is what a crash looks like to the store.
    const workflowDirectory = join(root, 'workflows');
    await mkdir(workflowDirectory, { recursive: true });
    await writeFile(
      join(workflowDirectory, 'digest.json'),
      workflowFileText('digest', parked('digest question')),
    );
    let reachedSecondStep = false;
    const crashed = await createBureau<AgentDefinitions>({
      agents: scriptedAgents(['writer'], {}, []),
      generate: async ({ step }) => {
        if (step === 0) return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
        reachedSecondStep = true;
        return new Promise<never>(() => {});
      },
      toolbox: createToolbox([nextTool]),
      workflowDirectory,
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      stopWhen: stopWhen.noToolCalls(),
      onDiagnostic: () => undefined,
    });
    cleanups.push(() => crashed.dispose());
    await crashed.durableEngine()!.start('digest', null, { id: 'digest-run' });
    const agentRun = await crashed.createRun({ message: 'Recover me' });
    expect(await pollUntil(() => reachedSecondStep)).toBe(true);

    const steps: number[] = [];
    const recovering = await createBureau<AgentDefinitions>({
      agents: {},
      generate: async ({ step }) => {
        steps.push(step);
        return { content: `recovered step ${step}`, toolCalls: [] };
      },
      toolbox: createToolbox([nextTool]),
      storage: { type: 'sqlite', path: databasePath },
      durableExecution: true,
      durableOwnership: { ownership: 'none' },
      stopWhen: stopWhen.noToolCalls(),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    cleanups.push(() => recovering.dispose());

    const report = await recovering.waitForRecovery?.();
    expect(report?.outcome).toBe('partial');
    expect(report?.batchFailure).toBeUndefined();
    expect(report?.skippedRuns).toEqual([{ runId: 'digest-run', type: 'digest' }]);
    expect(report?.perRunFailures).toEqual([]);
    expect(recoveryDiagnostics(diagnostics)).toHaveLength(1);
    expect(recoveryDiagnostics(diagnostics)[0]?.level).toBe('warn');
    expect(recoveryDiagnostics(diagnostics)[0]?.message).toContain('digest-run');

    // The agent run that was in flight beside it recovers and carries on.
    expect(await pollUntil(() => steps.includes(1))).toBe(true);
    expect(recovering.getRun(agentRun.id)).toBeDefined();
  });
});
