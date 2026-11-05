/**
 * COR-1717 — an approval whose resolution started but never committed is listed again after a
 * real process death, marked `interrupted`, and its tool is not run again by the restart.
 *
 * The child approves a gated tool call and SIGKILLs itself from inside the approved tool's body,
 * after the resolution-started marker is durable and before the decision commits. The parent boots
 * a Bureau over the same SQLite database and reads the review back.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { describe, expect, it } from 'bun:test';
import { createSessionStore } from '@lostgradient/operative';
import { textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { base64Of, pngBytes } from './testing/asset-fixtures.test-support';
import { KEYS } from './assets/records';

import {
  CLAIM_TTL_MS,
  createHarnessBureau,
  createInterruptedApprovalToolbox,
  createPeerApprovalToolbox,
  INTERRUPTED_APPROVAL_FILE,
} from './test/process-crash-work-integrity-fixtures';
import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import type { Bureau, RecoverableStartedApprovalInput } from './types';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { readChildJson } from './test/child-output-file';
import { reviewDecisionKey } from './review-decision-record';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');
const runtime = createDefaultRuntimeServices();

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

async function interruptedApprovalScenario(scope: ScenarioScope): Promise<void> {
  {
    const directory = createTemporaryDirectory('corvidae-interrupted-approval');
    const storagePath = join(directory, 'bureau');
    const markerPath = join(directory, 'marker.json');
    const toolFile = join(directory, INTERRUPTED_APPROVAL_FILE);
    // The child's store, opened here only once the child is gone.
    const store = createSqliteStorageFixture({ path: storagePath });
    let recoverer: Bureau | undefined;
    scope.onHang(async () => {
      await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
      await store.dispose();
      removeTemporaryPath(directory);
    });
    try {
      const child = spawnWithHangGuard(
        ['bun', CHILD, 'approve-then-crash', 'sqlite', storagePath, markerPath],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      scope.onHang(() => child.kill());
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(child.signalCode ?? stderr).toBe('SIGKILL');
      const { reviewId } = readChildJson<{ reviewId: string }>(markerPath);
      const linesBeforeRestart = lineCount(toolFile);
      expect(linesBeforeRestart).toBe(1);

      await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

      recoverer = await createHarnessBureau({
        storage: store.storage,
        generate: async () => ({ content: 'recovered', toolCalls: [] }),
        toolbox: createInterruptedApprovalToolbox(directory),
      });
      await recoverer.recovery();
      const bureau = recoverer;
      await waitUntil(() => bureau.reviews.list().some((candidate) => candidate.id === reviewId));
      const review = bureau.reviews.list().find((candidate) => candidate.id === reviewId);
      expect(review?.kind).toBe('tool-approval');
      if (review?.kind !== 'tool-approval') throw new Error('the review was not listed again');
      expect(review.interrupted).toBe(true);
      expect(typeof review.resolutionStartedAt).toBe('number');
      expect(existsSync(toolFile)).toBe(true);
      expect(lineCount(toolFile)).toBe(linesBeforeRestart);
    } finally {
      if (recoverer !== undefined) await Promise.allSettled([recoverer.shutdown()]);
      await store.dispose();
      removeTemporaryPath(directory);
    }
  }
}

type PeerRecoveryVariant =
  | 'normal'
  | 'before-marker'
  | 'missing-journal'
  | 'invalid-journal'
  | 'invalid-authority'
  | 'invalid-binding'
  | 'ordinary-error'
  | 'malformed-callback'
  | 'ordinary-media';

const PEER_RECOVERY_SCENARIOS: ReadonlyArray<{
  readonly variant: PeerRecoveryVariant;
  readonly childVariant?: string;
  readonly expectedAttach: number;
}> = [
  { variant: 'normal', expectedAttach: 1 },
  { variant: 'before-marker', childVariant: 'before-marker', expectedAttach: 0 },
  { variant: 'missing-journal', childVariant: 'missing-journal', expectedAttach: 0 },
  { variant: 'invalid-journal', childVariant: 'invalid-journal', expectedAttach: 0 },
  { variant: 'invalid-authority', expectedAttach: 0 },
  { variant: 'invalid-binding', childVariant: 'invalid-binding', expectedAttach: 0 },
  { variant: 'ordinary-error', expectedAttach: 1 },
  { variant: 'malformed-callback', expectedAttach: 1 },
  { variant: 'ordinary-media', expectedAttach: 1 },
];

const PEER_RECOVERY_COMMIT_VARIANTS = new Set<PeerRecoveryVariant>([
  'normal',
  'ordinary-error',
  'ordinary-media',
]);

async function peerApprovalRecoveryScenario(
  scope: ScenarioScope,
  scenario: (typeof PEER_RECOVERY_SCENARIOS)[number],
): Promise<void> {
  const directory = createTemporaryDirectory(`corvidae-peer-approval-${scenario.variant}`);
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const callbackPath = join(directory, 'attach-callbacks.txt');
  const toolRunsPath = join(directory, 'tool-runs.txt');
  const store = createSqliteStorageFixture({ path: storagePath });
  const secondStore = createSqliteStorageFixture({ path: storagePath });
  const assetFixture =
    scenario.variant === 'ordinary-media' ? createMemoryAssetStorageFixture() : undefined;
  let recoverer: Bureau | undefined;
  let secondRecoverer: Bureau | undefined;
  scope.onHang(async () => {
    await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
    await Promise.allSettled(secondRecoverer === undefined ? [] : [secondRecoverer.shutdown()]);
    await store.dispose();
    await secondStore.dispose();
    removeTemporaryPath(directory);
  });
  try {
    const child = spawnWithHangGuard(
      [
        'bun',
        CHILD,
        'peer-approval-then-crash',
        'sqlite',
        storagePath,
        markerPath,
        scenario.childVariant ?? '',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => child.kill());
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    if (scenario.variant === 'before-marker') {
      const toolbox = createPeerApprovalToolbox(() =>
        appendFileSync(toolRunsPath, 'ran\n', 'utf8'),
      );
      const attach = {
        version: 1 as const,
        attach: async () => {
          appendFileSync(callbackPath, 'unexpected\n', 'utf8');
          return undefined;
        },
      };
      recoverer = await createHarnessBureau({
        storage: store.storage,
        generate: async () => ({ content: 'recovered', toolCalls: [] }),
        toolbox,
        recoverableStartedApprovals: new Map([['unused', attach]]),
      });
      await recoverer.recovery();
      await quietFor(CLAIM_TTL_MS * 2);
      expect(existsSync(markerPath)).toBe(false);
      expect(existsSync(callbackPath)).toBe(false);
      expect(existsSync(toolRunsPath)).toBe(false);
      return;
    }
    const marker = readChildJson<{
      runId: string;
      sessionId: string;
      reviewId: string;
      revision: string;
    }>(markerPath);
    const toolbox = createPeerApprovalToolbox(() => appendFileSync(toolRunsPath, 'ran\n', 'utf8'));
    const attach = {
      version: 1 as const,
      attach: async (input: RecoverableStartedApprovalInput) => {
        appendFileSync(callbackPath, `${input.journalEntry.taskId}\n`, 'utf8');
        if (scenario.variant === 'malformed-callback') {
          return { callId: input.callId, toolCallId: input.callId, toolName: 'ask-peer' } as never;
        }
        const media = scenario.variant === 'ordinary-media';
        return {
          callId: input.callId,
          toolCallId: input.callId,
          toolName: 'ask-peer',
          outcome:
            scenario.variant === 'ordinary-error' ? ('error' as const) : ('success' as const),
          content: scenario.variant === 'ordinary-error' ? 'peer failed' : 'peer answer',
          result: scenario.variant === 'ordinary-error' ? 'peer failed' : 'peer answer',
          ...(media
            ? {
                parts: [
                  { type: 'text' as const, text: 'peer answer' },
                  {
                    type: 'image' as const,
                    mimeType: 'image/png',
                    source: {
                      kind: 'inline' as const,
                      data: base64Of(pngBytes(2, 2)),
                      encoding: 'base64' as const,
                    },
                  },
                ],
              }
            : {}),
        };
      },
    };
    const options = {
      generate: async () => ({ content: 'recovered', toolCalls: [] }),
      toolbox,
      recoverableStartedApprovals: new Map([[marker.revision, attach]]),
      requestAuthorityValidator:
        scenario.variant === 'invalid-authority' ? async () => false : async () => true,
      ...(assetFixture === undefined ? {} : { assets: { storage: assetFixture.storage } }),
    };
    recoverer = await createHarnessBureau({ ...options, storage: store.storage });
    if (scenario.variant === 'malformed-callback' || scenario.variant === 'ordinary-media') {
      await recoverer.recovery();
    } else {
      secondRecoverer = await createHarnessBureau({ ...options, storage: secondStore.storage });
      await Promise.all([recoverer.recovery(), secondRecoverer.recovery()]);
    }
    if (scenario.expectedAttach === 1) {
      await waitUntil(
        () =>
          existsSync(callbackPath) && readFileSync(callbackPath, 'utf8').trim() === 'peer-task-1',
      );
    } else {
      await quietFor(CLAIM_TTL_MS * 2);
    }
    const callbackCount = existsSync(callbackPath)
      ? readFileSync(callbackPath, 'utf8').split('\n').filter(Boolean).length
      : 0;
    expect(callbackCount).toBe(scenario.expectedAttach);
    expect(existsSync(toolRunsPath)).toBe(false);
    const expectedCommit = PEER_RECOVERY_COMMIT_VARIANTS.has(scenario.variant);
    expect(recoverer.reviews.list().some((review) => review.id === marker.reviewId)).toBe(
      !expectedCommit,
    );
    if (scenario.variant !== 'malformed-callback') {
      const session = await recoverer.contexts.get(marker.sessionId);
      const toolResult = session?.conversationHistory.ids
        .map((id) => session.conversationHistory.messages[id])
        .find((message) => message?.role === 'tool-result')?.toolResult;
      if (scenario.variant === 'normal' || scenario.variant === 'ordinary-error') {
        expect(toolResult?.outcome).toBe(
          scenario.variant === 'ordinary-error' ? 'error' : 'success',
        );
      }
      if (scenario.variant === 'ordinary-media') {
        const image = toolResult?.parts?.find((part) => part.type === 'image');
        expect(image).toMatchObject({ source: { kind: 'managed-asset' } });
        const assetId =
          image?.type === 'image' && image.source.kind === 'managed-asset'
            ? image.source.assetId
            : undefined;
        expect(assetId).toBeDefined();
        const rawAsset = await assetFixture?.storage.get(KEYS.record(assetId!));
        expect(rawAsset).not.toBeNull();
        const ownerId = (JSON.parse(rawAsset as string) as { ownerId: string }).ownerId;
        expect(await recoverer.assets?.inspect(assetId!, { id: ownerId })).toMatchObject({
          owner: ownerId,
          state: 'available',
        });
        const foreign = await rejectionOf(
          recoverer.assets!.inspect(assetId!, { id: 'foreign-principal' }),
        );
        expect(foreign).toBeInstanceOf(Error);
        expect(JSON.stringify(session?.conversationHistory)).not.toContain(
          base64Of(pngBytes(2, 2)),
        );
      }
      expect(JSON.stringify(session?.conversationHistory)).toContain(
        !expectedCommit
          ? 'action_required'
          : scenario.variant === 'ordinary-error'
            ? 'peer failed'
            : 'peer answer',
      );
    }
    const audit = await recoverer.internals.auditTrail?.query({ runId: marker.runId });
    expect(audit?.filter((record) => record.type === 'review.tool-approval.approved')).toHaveLength(
      expectedCommit ? 1 : 0,
    );
    const persisted = await recoverer.internals.sessionStore?.load(marker.sessionId);
    const decisions = persisted?.metadata['resolvedReviewDecisions'];
    expect(
      decisions !== null && typeof decisions === 'object' && !Array.isArray(decisions)
        ? Object.prototype.hasOwnProperty.call(decisions, marker.reviewId)
        : false,
    ).toBe(expectedCommit);
  } finally {
    if (recoverer !== undefined) await Promise.allSettled([recoverer.shutdown()]);
    if (secondRecoverer !== undefined) await Promise.allSettled([secondRecoverer.shutdown()]);
    await store.dispose();
    await secondStore.dispose();
    await assetFixture?.dispose();
    removeTemporaryPath(directory);
  }
}

async function peerRecoveryAttachCrashScenario(scope: ScenarioScope): Promise<void> {
  const directory = createTemporaryDirectory('corvidae-peer-approval-attach-crash');
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const callbackPath = join(directory, 'attach-callbacks.txt');
  const toolRunsPath = join(directory, 'tool-runs.txt');
  const store = createSqliteStorageFixture({ path: storagePath });
  let recoverer: Bureau | undefined;
  scope.onHang(async () => {
    await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
    await store.dispose();
    removeTemporaryPath(directory);
  });
  try {
    const seed = spawnWithHangGuard(
      ['bun', CHILD, 'peer-approval-then-crash', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => seed.kill());
    await seed.exited;
    expect(seed.signalCode).toBe('SIGKILL');
    const marker = readChildJson<{
      runId: string;
      sessionId: string;
      reviewId: string;
      revision: string;
    }>(markerPath);
    await quietFor(CLAIM_TTL_MS * 10);
    const attachCrash = spawnWithHangGuard(
      ['bun', CHILD, 'peer-recovery-attach-then-crash', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => attachCrash.kill());
    await attachCrash.exited;
    expect(attachCrash.signalCode).toBe('SIGKILL');
    const toolbox = createPeerApprovalToolbox(() => appendFileSync(toolRunsPath, 'ran\n', 'utf8'));
    const attach = {
      version: 1 as const,
      attach: async (input: RecoverableStartedApprovalInput) => {
        appendFileSync(callbackPath, `${input.journalEntry.taskId}\n`, 'utf8');
        return {
          callId: input.callId,
          toolCallId: input.callId,
          toolName: 'ask-peer',
          outcome: 'success' as const,
          content: 'peer answer',
          result: 'peer answer',
        };
      },
    };
    recoverer = await createHarnessBureau({
      storage: store.storage,
      generate: async () => ({ content: 'recovered', toolCalls: [] }),
      toolbox,
      recoverableStartedApprovals: new Map([[marker.revision, attach]]),
    });
    await recoverer.recovery();
    await waitUntil(() => existsSync(callbackPath));
    expect(readFileSync(callbackPath, 'utf8').trim().split('\n')).toEqual(['peer-task-1']);
    expect(existsSync(toolRunsPath)).toBe(false);
    const session = await recoverer.contexts.get(marker.sessionId);
    expect(JSON.stringify(session?.conversationHistory)).toContain('peer answer');
    const audit = await recoverer.internals.auditTrail?.query({ runId: marker.runId });
    expect(audit?.filter((record) => record.type === 'review.tool-approval.approved')).toHaveLength(
      1,
    );
    const persisted = await recoverer.internals.sessionStore?.load(marker.sessionId);
    const decisions = persisted?.metadata['resolvedReviewDecisions'];
    expect(decisions).toHaveProperty(marker.reviewId);
  } finally {
    if (recoverer !== undefined) await Promise.allSettled([recoverer.shutdown()]);
    await store.dispose();
    removeTemporaryPath(directory);
  }
}

async function peerRecoveryLeaseReplacementScenario(scope: ScenarioScope): Promise<void> {
  const directory = createTemporaryDirectory('corvidae-peer-approval-lease-replacement');
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const tracePath = join(directory, 'trace.log');
  const callbackPath = join(directory, 'attach-callbacks.txt');
  const store = createSqliteStorageFixture({ path: storagePath });
  const secondStore = createSqliteStorageFixture({ path: storagePath });
  const independentSessionStore = createSessionStore(
    textValueStore(store.storage, { disposeUnderlyingStorage: false }),
  );
  let bureau: Bureau | undefined;
  let second: Bureau | undefined;
  scope.onHang(async () => {
    await Promise.allSettled([bureau?.shutdown(), second?.shutdown()].filter(Boolean));
    await store.dispose();
    await secondStore.dispose();
    removeTemporaryPath(directory);
  });
  try {
    const child = spawnWithHangGuard(
      ['bun', CHILD, 'peer-approval-then-crash', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => child.kill());
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    const marker = readChildJson<{
      runId: string;
      sessionId: string;
      reviewId: string;
      revision: string;
    }>(markerPath);
    await quietFor(CLAIM_TTL_MS * 10);
    let stale = true;
    const toolbox = createPeerApprovalToolbox();
    const attach = {
      version: 1 as const,
      attach: async (input: RecoverableStartedApprovalInput) => {
        const staleAtEntry = stale;
        appendFileSync(tracePath, `attach:${staleAtEntry ? 'stale' : 'valid'}\n`, 'utf8');
        appendFileSync(callbackPath, `${input.journalEntry.taskId}\n`, 'utf8');
        if (staleAtEntry) {
          await independentSessionStore.update(marker.sessionId, (session) => {
            if (session === undefined) return undefined;
            return {
              ...session,
              metadata: {
                ...session.metadata,
                approvalPeerRecoveryLeases: {
                  [marker.reviewId]: {
                    token: 'replacement-token',
                    round: 0,
                    expiresAt: 0,
                    operationKey: `approval-resume:v1:${marker.reviewId}`,
                  },
                },
              },
            };
          });
          appendFileSync(tracePath, 'lease-replaced\n', 'utf8');
          stale = false;
        }
        return {
          callId: input.callId,
          toolCallId: input.callId,
          toolName: 'ask-peer',
          outcome: 'success' as const,
          content: staleAtEntry ? 'stale answer' : 'valid answer',
          result: staleAtEntry ? 'stale answer' : 'valid answer',
        };
      },
    };
    bureau = await createHarnessBureau({
      storage: store.storage,
      generate: async () => ({ content: 'recovered', toolCalls: [] }),
      toolbox,
      recoverableStartedApprovals: new Map([[marker.revision, attach]]),
    });
    await bureau.recovery();
    expect(readFileSync(tracePath, 'utf8')).toContain('lease-replaced');
    const afterStale = await bureau.internals.sessionStore?.load(marker.sessionId);
    const resolvedAfterStale = afterStale?.metadata['resolvedReviewIds'];
    expect(Array.isArray(resolvedAfterStale) ? resolvedAfterStale : []).not.toContain(
      marker.reviewId,
    );
    await independentSessionStore.update(marker.sessionId, (session) =>
      session === undefined
        ? undefined
        : { ...session, metadata: { ...session.metadata, approvalPeerRecoveryResults: {} } },
    );
    await bureau.shutdown();
    second = await createHarnessBureau({
      storage: secondStore.storage,
      generate: async () => ({ content: 'recovered', toolCalls: [] }),
      toolbox,
      recoverableStartedApprovals: new Map([[marker.revision, attach]]),
    });
    await second.recovery();
    await waitUntil(() => readFileSync(tracePath, 'utf8').includes('attach:valid'));
    const persisted = await second.internals.sessionStore?.load(marker.sessionId);
    expect(persisted?.metadata['resolvedReviewIds']).toContain(marker.reviewId);
    expect(readFileSync(callbackPath, 'utf8').split('\n').filter(Boolean)).toEqual([
      'peer-task-1',
      'peer-task-1',
    ]);
    const audit = await second.internals.auditTrail?.query({ runId: marker.runId });
    expect(audit?.filter((record) => record.type === 'review.tool-approval.approved')).toHaveLength(
      1,
    );
  } finally {
    await Promise.allSettled([bureau?.shutdown(), second?.shutdown()].filter(Boolean));
    await store.dispose();
    await secondStore.dispose();
    removeTemporaryPath(directory);
  }
}

async function peerRecoveryPostCommitCrashScenario(scope: ScenarioScope): Promise<void> {
  const directory = createTemporaryDirectory('corvidae-peer-approval-post-commit');
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const postCommitPath = `${markerPath}.postcommit`;
  const callbackPath = join(directory, 'attach-callbacks.txt');
  const store = createSqliteStorageFixture({ path: storagePath });
  let recoverer: Bureau | undefined;
  scope.onHang(async () => {
    await Promise.allSettled(recoverer === undefined ? [] : [recoverer.shutdown()]);
    await store.dispose();
    removeTemporaryPath(directory);
  });
  try {
    const seed = spawnWithHangGuard(
      ['bun', CHILD, 'peer-approval-then-crash', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => seed.kill());
    await seed.exited;
    expect(seed.signalCode).toBe('SIGKILL');
    const marker = readChildJson<{
      runId: string;
      sessionId: string;
      reviewId: string;
      revision: string;
    }>(markerPath);
    await quietFor(CLAIM_TTL_MS * 10);
    const postCommit = spawnWithHangGuard(
      ['bun', CHILD, 'peer-recovery-post-commit-then-crash', 'sqlite', storagePath, markerPath],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    scope.onHang(() => postCommit.kill());
    await postCommit.exited;
    expect(postCommit.signalCode).toBe('SIGKILL');
    expect(readFileSync(postCommitPath, 'utf8')).toContain('"recorded":false');
    const attach = {
      version: 1 as const,
      attach: async (input: RecoverableStartedApprovalInput) => {
        appendFileSync(callbackPath, `${input.journalEntry.taskId}\n`, 'utf8');
        return {
          callId: input.callId,
          toolCallId: input.callId,
          toolName: 'ask-peer',
          outcome: 'success' as const,
          content: 'peer answer',
          result: 'peer answer',
        };
      },
    };
    const recoveryRuntime = createManualRuntimeServices({ origin: new Date().toISOString() });
    recoverer = await createHarnessBureau({
      storage: store.storage,
      runtime: recoveryRuntime,
      generate: async () => ({ content: 'recovered', toolCalls: [] }),
      toolbox: createPeerApprovalToolbox(),
      recoverableStartedApprovals: new Map([[marker.revision, attach]]),
    });
    const pendingBeforeRecovery = await recoverer.internals.sessionStore?.outbox.pending();
    expect(pendingBeforeRecovery).toHaveLength(1);
    expect(pendingBeforeRecovery?.[0]?.claim).toBeDefined();
    await recoverer.recovery();
    expect(existsSync(callbackPath)).toBe(false);
    const audit = await recoverer.internals.auditTrail?.query({ runId: marker.runId });
    expect(audit?.filter((record) => record.type === 'review.tool-approval.approved')).toHaveLength(
      1,
    );
    const persisted = await recoverer.internals.sessionStore?.load(marker.sessionId);
    expect(persisted?.metadata['resolvedReviewIds']).toContain(marker.reviewId);
    await recoveryRuntime.advance(31_000);
    await recoverer.maintain();
    const finalAudit = await recoverer.internals.auditTrail?.query({ runId: marker.runId });
    await recoverer.shutdown();
    recoverer = undefined;
    const recorded = await store.storage.get(reviewDecisionKey(marker.reviewId, 0));
    expect(recorded).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(recorded as Uint8Array))).toMatchObject({
      recorded: true,
    });
    expect(
      finalAudit?.filter((record) => record.type === 'review.tool-approval.approved'),
    ).toHaveLength(1);
  } finally {
    if (recoverer !== undefined) await Promise.allSettled([recoverer.shutdown()]);
    await store.dispose();
    removeTemporaryPath(directory);
  }
}

// A real SIGKILLed child and a claim-lapse wait: run whole, once, at module scope.
const outcome = await settleScenario(interruptedApprovalScenario, 120_000);
const peerRecoveryOutcomes = await Promise.all(
  PEER_RECOVERY_SCENARIOS.map((scenario) =>
    settleScenario((scope) => peerApprovalRecoveryScenario(scope, scenario), 120_000),
  ),
);
const peerRecoveryAttachCrashOutcome = await settleScenario(
  peerRecoveryAttachCrashScenario,
  120_000,
);
const peerRecoveryLeaseReplacementOutcome = await settleScenario(
  peerRecoveryLeaseReplacementScenario,
  120_000,
);
const peerRecoveryPostCommitCrashOutcome = await settleScenario(
  peerRecoveryPostCommitCrashScenario,
  120_000,
);

describe('an approval interrupted mid-resolution (COR-1717)', () => {
  it('is listed again as interrupted after SIGKILL and does not re-run its tool', () => {
    expectScenarioPassed(outcome);
  });
});

describe('a journaled peer approval interrupted mid-resolution (COR-2051)', () => {
  it('attaches once after SIGKILL and commits the peer result without executing a tool', async () => {
    expectScenarioPassed(peerRecoveryOutcomes[0]);
  });

  for (const [index, scenario] of PEER_RECOVERY_SCENARIOS.entries()) {
    if (index === 0) continue;
    it(`${scenario.expectedAttach === 0 ? 'does not attach for' : 'handles'} ${scenario.variant}`, () => {
      expectScenarioPassed(peerRecoveryOutcomes[index]);
    });
  }

  it('recovers exactly once after a recovery process dies inside attach', () => {
    expectScenarioPassed(peerRecoveryAttachCrashOutcome);
  });

  it('rejects a stale result after the attach callback replaces its lease', () => {
    expectScenarioPassed(peerRecoveryLeaseReplacementOutcome);
  });

  it('replays the recorded decision after a post-session-commit SIGKILL', () => {
    expectScenarioPassed(peerRecoveryPostCommitCrashOutcome);
  });
});
