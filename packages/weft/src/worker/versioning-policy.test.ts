import { describe, expect, it } from 'bun:test';
import { MemoryStorage } from '../storage/memory.ts';
import { KEYS } from '../storage/interface.ts';
import { encode } from '../core/codec.ts';
import {
  DEFAULT_WORKFLOW_WORKER_VERSIONING_POLICY,
  bindingFromExecution,
  bindWorkflowWorkerAtStart,
  consumeWorkflowWorkerStartOverridePreview,
  evaluateWorkflowWorkerUpgrade,
  inheritWorkflowWorkerBinding,
  issueWorkflowWorkerStartOverridePreview,
  readWorkflowWorkerBinding,
  recordWorkflowWorkerUpgrade,
  selectWorkflowActivityBinding,
  verifyWorkflowWorkerStartOverridePreview,
  type WorkflowWorkerBinding,
} from './versioning-policy.ts';

const binding = (buildId: string, revision = 'workflow-revision'): WorkflowWorkerBinding => ({
  workflowId: 'workflow-1',
  workflowType: 'orders',
  deploymentName: 'orders',
  buildId,
  artifactDigest: `sha256:${buildId}`,
  manifestDigest: `sha256:manifest-${buildId}`,
  workflowRevision: revision,
  activityName: 'charge',
  activityContractHash: 'sha256:charge-contract',
  boundAt: 1,
  checkpointId: `checkpoint-${buildId}`,
});

async function seedWorkflow(storage: MemoryStorage): Promise<void> {
  await storage.put(
    KEYS.workflow('workflow-1'),
    encode({ id: 'workflow-1', type: 'orders', status: 'running', input: null, versionTuple: { workflowVersion: '1' }, createdAt: 1, updatedAt: 1 }),
  );
}

describe('workflow worker versioning policy', () => {
  it('defaults to pinned and binds start atomically and idempotently', async () => {
    expect(DEFAULT_WORKFLOW_WORKER_VERSIONING_POLICY.mode).toBe('pinned');
    using storage = new MemoryStorage();
    await seedWorkflow(storage);
    const first = await bindWorkflowWorkerAtStart(storage, binding('build-1'));
    const retry = await bindWorkflowWorkerAtStart(storage, binding('build-1'));
    expect(retry).toEqual(first);
    await expect(bindWorkflowWorkerAtStart(storage, binding('build-2'))).rejects.toThrow(
      'already has a different worker binding',
    );
  });

  it('rejects a lost concurrent start binding CAS', async () => {
    class LostCasStorage extends MemoryStorage {
      override async conditionalBatch(): Promise<boolean> {
        return false;
      }
    }
    using storage = new LostCasStorage();
    await seedWorkflow(storage);
    await expect(bindWorkflowWorkerAtStart(storage, binding('build-1'))).rejects.toThrow(
      'Concurrent worker binding changed workflow',
    );
  });

  it('records bounded upgrades only under the exact contract at a checkpoint boundary', async () => {
    using storage = new MemoryStorage();
    await seedWorkflow(storage);
    const first = binding('build-1');
    await bindWorkflowWorkerAtStart(storage, first);
    const candidate = binding('build-2');
    const evaluation = evaluateWorkflowWorkerUpgrade({
      policy: {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: candidate.deploymentName,
          buildId: candidate.buildId,
          artifactDigest: candidate.artifactDigest,
          manifestDigest: candidate.manifestDigest,
          workflowRevision: first.workflowRevision,
          activityContractHash: first.activityContractHash,
        },
      },
      current: first,
      candidate,
      checkpointCommitted: true,
      realmAcquired: false,
    });
    expect(evaluation.allowed).toBe(true);
    const upgraded = await recordWorkflowWorkerUpgrade(
      storage,
      {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: candidate.deploymentName,
          buildId: candidate.buildId,
          artifactDigest: candidate.artifactDigest,
          manifestDigest: candidate.manifestDigest,
          workflowRevision: first.workflowRevision,
          activityContractHash: first.activityContractHash,
        },
        maxBindingHistory: 1,
      },
      first,
      candidate,
    );
    expect(upgraded.current.buildId).toBe('build-2');
    expect(upgraded.history).toHaveLength(1);
    const stored = await readWorkflowWorkerBinding(storage, first.workflowId);
    expect(stored?.current.buildId).toBe('build-2');
    await expect(
      recordWorkflowWorkerUpgrade(
        storage,
        { mode: 'auto-upgrade', maxBindingHistory: 0, compatibility: {
          deploymentName: candidate.deploymentName,
          buildId: candidate.buildId,
          artifactDigest: candidate.artifactDigest,
          manifestDigest: candidate.manifestDigest,
          workflowRevision: first.workflowRevision,
          activityContractHash: first.activityContractHash,
        } },
        candidate,
        binding('build-3'),
      ),
    ).rejects.toThrow('maxBindingHistory');
  });

  it('derives a complete binding from an accepted worker execution identity', () => {
    expect(bindingFromExecution({
      workerId: 'worker-1',
      deploymentName: 'orders',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact',
      manifestDigest: 'sha256:manifest',
      protocolVersion: 1,
      sdkVersion: 'weft-test',
      runtimeName: 'bun',
      runtimeVersion: '1.4.2',
      workflowType: 'orders',
      activityName: 'charge',
      workflowRevision: 'revision-1',
      activityContractHash: 'sha256:contract',
    }, 'workflow-1', 'orders', 'charge', 'checkpoint-1', 42)).toMatchObject({
      workflowId: 'workflow-1', workflowType: 'orders', deploymentName: 'orders', buildId: 'build-1',
      artifactDigest: 'sha256:artifact', manifestDigest: 'sha256:manifest', workflowRevision: 'revision-1',
      activityName: 'charge', activityContractHash: 'sha256:contract', boundAt: 42, checkpointId: 'checkpoint-1',
    });
  });

  it('blocks upgrades outside a checkpoint boundary, after realm acquisition, or for a mismatch', () => {
    const current = binding('build-1');
    const policy = {
      mode: 'auto-upgrade' as const,
      compatibility: {
        deploymentName: current.deploymentName,
        buildId: 'build-2',
        artifactDigest: 'sha256:build-2',
        manifestDigest: 'sha256:manifest-build-2',
        workflowRevision: current.workflowRevision,
        activityContractHash: current.activityContractHash,
      },
    };
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: binding('build-2'),
        checkpointCommitted: false,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'not-checkpoint-boundary' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: binding('build-2'),
        checkpointCommitted: true,
        realmAcquired: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'realm-already-acquired' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: binding('build-2', 'other-revision'),
        checkpointCommitted: true,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'incompatible-contract' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy: { mode: 'pinned' },
        current,
        candidate: binding('build-2'),
        checkpointCommitted: true,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'policy-pinned' });
    expect(
      evaluateWorkflowWorkerUpgrade({
        policy,
        current,
        candidate: { ...binding('build-2'), workflowId: 'other-workflow' },
        checkpointCommitted: true,
        realmAcquired: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'stale-binding' });
  });

  it('inherits one immutable binding across derived workflow executions', () => {
    const original = binding('build-1');
    const inherited = inheritWorkflowWorkerBinding(original);
    expect(inherited).toEqual(original);
    expect(inherited).not.toBe(original);
  });

  it('couples activities to the workflow unless explicitly selected', () => {
    const workflow = binding('build-1');
    expect(selectWorkflowActivityBinding(workflow)).toBe(workflow);
    const activity = { ...workflow, activityName: 'refund' };
    expect(selectWorkflowActivityBinding(workflow, activity)).toBe(activity);
    expect(() =>
      selectWorkflowActivityBinding(workflow, { ...activity, workflowId: 'other' }),
    ).toThrow('belong to the bound workflow');
  });

  it('requires a scoped, server-issued preview token for a start override', () => {
    const preview = issueWorkflowWorkerStartOverridePreview({
      workflowId: 'workflow-1',
      serverSecret: 'secret',
      now: 1000,
      ttlMs: 100,
    });
    expect(preview.scope).toBe('destructive:workflow-worker-version-binding');
    expect(verifyWorkflowWorkerStartOverridePreview(preview, 'secret', 1050)).toBe(true);
    expect(verifyWorkflowWorkerStartOverridePreview(preview, 'wrong-secret', 1050)).toBe(false);
    expect(verifyWorkflowWorkerStartOverridePreview(preview, 'secret', 1101)).toBe(false);
  });

  it('consumes a start override once and rejects replay', async () => {
    using storage = new MemoryStorage();
    const preview = issueWorkflowWorkerStartOverridePreview({
      workflowId: 'workflow-1',
      serverSecret: 'secret',
      now: 10,
    });
    expect(await consumeWorkflowWorkerStartOverridePreview(storage, preview, 'secret', 20)).toBe(
      true,
    );
    expect(await consumeWorkflowWorkerStartOverridePreview(storage, preview, 'secret', 20)).toBe(
      false,
    );
  });
});
