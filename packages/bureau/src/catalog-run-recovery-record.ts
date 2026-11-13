import type { AgentInput } from '@lostgradient/operative';
import { isSessionInputPayload } from '@lostgradient/operative';
import { type StoredTaskOrigin, isStoredTaskOrigin } from './task-origin';
import type { TaskToolGrant } from './task-registry';
import { readRunWorkspaceAuthority } from 'armorer';
import {
  type GoalAttemptCostEstimation,
  isGoalAttemptCostEstimation,
} from './goal-cost-estimation';
import { isRecord } from './schedule-run-marker';

/**
 * AB-240: the recovery record `bureau.run()`'s durable catalog dispatch
 * persists BEFORE starting the durable engine, keyed by the run's workflow
 * id — a marker entirely separate from (and never correlated with)
 * `sessionStore`'s `lastRunId`/`lastRunStatus`, because a catalog run never
 * owns a bureau session. `definitionRevision` is `AgentGenerationProfile.revision`
 * (operative's existing per-agent stable-revision field, read via
 * `readGenerationProfile`) at dispatch time — the closest existing "has this
 * catalog agent's definition changed" signal, reused rather than inventing a
 * new one. `input` is the ORIGINAL `AgentInput` `bureau.run(name, input)` was
 * called with: `AgentRunWorkflowInput.prompt` is NOT a substitute (it is a
 * seed-only field the durable workflow itself ignores on resume — see its own
 * doc comment), and `OPERATIVE_RESOLVE_RUN_OPTIONS` must be re-invoked with the
 * real input to rebuild `RunOptions` fresh each boot, the same way
 * `buildRunDepsFromSession` rebuilds session-owned deps from config rather
 * than a stored blob.
 */
export type CatalogRunRecoveryLoad =
  | { status: 'found'; record: CatalogRunRecoveryRecord }
  | { status: 'missing' }
  /**
   * A value is stored at the key but is not a recovery record (it does not
   * decodes but fails shape validation). It is present, so goal ownership must
   * never read it as absent; every other consumer treats it as it always did,
   * as `missing`.
   */
  | { status: 'corrupt' }
  | { status: 'read-error'; error: unknown };
/** Who a goal attempt's claim must belong to for the goal to tombstone it. */
export interface GoalAttemptClaimOwner {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly agentName: string;
  readonly principal: string | undefined;
}
export type GoalAttemptClaimFence = 'fenced' | 'foreign';
export interface CatalogRunRecoveryRecord {
  /** Original authorizing actor; never reconstructed from historic owner on recovery. */
  readonly workspaceAuthority?: import('armorer').RunWorkspaceAuthority;
  readonly schemaVersion: 1;
  /**
   * COR-1710 — the tools the task was granted when it started, so its recovery offers the same
   * ones. Absent in a record written before grants were recorded.
   */
  readonly tools?: TaskToolGrant | undefined;
  readonly agentName: string;
  readonly definitionRevision: number;
  readonly input: AgentInput;
  /**
   * AB-241 review finding: the attributing principal `bureau.run(name, input,
   * { principal })` recorded in the live, pre-crash `runAttribution` map —
   * persisted here too so a durable catalog run that crosses a process
   * restart keeps its attribution. Without this, a resumed run's rebuilt
   * `AgentRunContext` carried no `principal` at all, so `eventHistory`'s
   * principal gate would fail closed for a run recovery re-resolves.
   * Absent when the original dispatch supplied no principal.
   */
  readonly principal?: string;
  /**
   * COR-851 — set only on the run a durable goal started for one of its
   * attempts: which goal and which attempt it was started for. A goal's run id
   * is a deterministic function of the goal, so the id alone does not prove the
   * run is the goal's; this marker, written by the goal's own start, does. A
   * goal adopts or stops an existing run only when it carries its own marker.
   */
  readonly goalAttempt?: {
    readonly goalRunId: string;
    readonly attemptIndex: number;
    /**
     * COR-851 — set when the goal ended, closed, or was canceled over this
     * attempt: the claim is tombstoned and no run may start from it or take a
     * step under it. Written only by compare-and-swap from the claim's exact
     * bytes (or created whole, where no claim existed), so a start that races
     * the tombstone either wins the claim first, and is stopped by the run's own
     * fence, or finds the tombstone and starts nothing. See `goal-attempt-fence.ts`.
     */
    readonly tombstonedAt?: string;
  };
  /**
   * COR-851 — set with `goalAttempt` and only then: the cost estimator the
   * attempt's run was started with (`null` when it declared none), written in
   * the same conditional batch as the claim. A completed attempt is priced from
   * this alone, never by resolving the agent again, so a catalog that has since
   * moved to another revision or dropped the agent cannot change what the run
   * cost. See `goal-cost-estimation.ts`.
   */
  readonly costEstimation?: GoalAttemptCostEstimation;
  /**
   * COR-1527 — set only on the run an `agent` step of a workflow file started: which instance and
   * which step it was started for. The run's id is a function of the pair, so the id alone does
   * not prove the run is the step's; this marker, written by the step's own start, does.
   */
  readonly workflowStep?: {
    readonly workflowId: string;
    readonly step: number;
    readonly stepAddress?: string;
  };
  /**
   * COR-1524 — set only when the run is of a file-based agent: the SHA-256 of the agent file's
   * bytes the run started with. Recovery builds the agent from the snapshot stored under that
   * hash (`agent-snapshot-store.ts`), never from the file, so a run resumed after the file was
   * edited or deleted is the run that began. Absent for a code-defined agent.
   *
   * The record stays at `schemaVersion` 1, the way COR-716 widened its input: the field is
   * additive, a reader that predates it ignores it, and nothing is deployed.
   */
  readonly agentDefinitionHash?: string;
  /**
   * COR-2230 — set only when the run is of a plugin's code agent: the version the agent had when
   * the run started or its claim was written (the agent's own `version`, else its plugin's).
   * Recovery and a second execution of the claim compare it with the agent now, and a difference
   * settles the run failed with `definition-drifted`. Absent for a built-in or file agent and for
   * a record written before it, which recovers as it always did. Additive at `schemaVersion` 1,
   * as `agentDefinitionHash` was.
   */
  readonly agentPluginVersion?: string;
  /**
   * COR-2230 — set for a code agent: the hash of the overrides in force when the run started
   * (the empty set's hash when none was saved), compared as {@link agentPluginVersion} is.
   */
  readonly agentOverrideHash?: string;
  /**
   * COR-1481 — set only when the dispatch named a context (`bureau.run(..., { sessionId })`): the
   * task's `contextId`, so a task rebuilt from this record after a crash that lost its admission
   * write is in the context the live admission would have put it in. Absent for a dispatch that
   * named none, and for a record written before the field existed; the task is then in its own
   * run's context.
   *
   * The record stays at `schemaVersion` 1, as `agentDefinitionHash` did: additive, and a reader
   * that predates it ignores it.
   */
  readonly contextId?: string;
  /**
   * COR-1868 — set only on the run a child dispatch, a goal attempt, or a workflow `agent` step
   * started, by that start and by nothing else: the origin its task record carries. The run is a
   * task exactly when its claim holds this, so a task record lost in a crash is rebuilt from it
   * rather than from a recomputation, and a run claimed before the field existed stays a non-task
   * for its whole life. Read with {@link isStoredTaskOrigin}, not {@link isTaskOrigin}: a claim a
   * newer release wrote with a kind this one does not know must stay readable, or that run could
   * never be recovered or adopted. Admission stores such an origin as written, and the view shows
   * it as `null`.
   *
   * The record stays at `schemaVersion` 1, as `contextId` did: additive, and a reader that
   * predates it ignores it.
   */
  readonly taskOrigin?: StoredTaskOrigin;
}
// Exported for tests only — lets `runtime-composition.test.ts` construct the
// exact storage key to exercise `loadCatalogRunRecoveryRecord`'s read-error
// branch by writing malformed raw bytes directly through the durable engine's
// own `Storage` (`runtime.durable.engine.storage`), the only way to inject a
// genuine decode failure rather than a merely-absent or malformed-but-decodable
// record.
export const CATALOG_RUN_RECOVERY_KEY_PREFIX = 'bureau-catalog-run:';
export function catalogRunRecoveryKey(runId: string): string {
  return `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`;
}
/**
 * The input a catalog run's recovery record may hold: text, a non-empty list of
 * user text and media parts (checked with the media schemas), or `{ conversation }`.
 *
 * COR-716 widened this from text and `{ conversation }` without changing the
 * record's `schemaVersion`. The decision is that the record stays at version 1: its
 * writer and reader ship together, nothing is deployed, the project is pre-release,
 * and a widened input is additive for a reader (every record an earlier writer made
 * still passes).
 */
function isCatalogAgentInput(value: unknown): value is AgentInput {
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return isSessionInputPayload(value);
  return isRecord(value) && isRecord(value['conversation']);
}
export function isCatalogRunRecoveryRecord(value: unknown): value is CatalogRunRecoveryRecord {
  if (!isRecord(value)) return false;
  if (value['schemaVersion'] !== 1) return false;
  if (
    value['workspaceAuthority'] !== undefined &&
    readRunWorkspaceAuthority(value['workspaceAuthority']) === undefined
  )
    return false;
  const agentName = value['agentName'];
  if (typeof agentName !== 'string' || agentName.length === 0) return false;
  if (typeof value['definitionRevision'] !== 'number') return false;
  const principal = value['principal'];
  if (principal !== undefined && typeof principal !== 'string') return false;
  const agentDefinitionHash = value['agentDefinitionHash'];
  if (agentDefinitionHash !== undefined && typeof agentDefinitionHash !== 'string') return false;
  // A mistyped pin invalidates the record, as a mistyped sibling field does.
  const agentPluginVersion = value['agentPluginVersion'];
  if (agentPluginVersion !== undefined && typeof agentPluginVersion !== 'string') return false;
  const agentOverrideHash = value['agentOverrideHash'];
  if (agentOverrideHash !== undefined && typeof agentOverrideHash !== 'string') return false;
  const contextId = value['contextId'];
  if (contextId !== undefined && typeof contextId !== 'string') return false;
  const taskOrigin = value['taskOrigin'];
  if (taskOrigin !== undefined && !isStoredTaskOrigin(taskOrigin)) return false;
  const goalAttempt = value['goalAttempt'];
  if (
    goalAttempt !== undefined &&
    !(
      isRecord(goalAttempt) &&
      typeof goalAttempt['goalRunId'] === 'string' &&
      typeof goalAttempt['attemptIndex'] === 'number' &&
      Number.isSafeInteger(goalAttempt['attemptIndex']) &&
      goalAttempt['attemptIndex'] >= 0 &&
      (goalAttempt['tombstonedAt'] === undefined || typeof goalAttempt['tombstonedAt'] === 'string')
    )
  ) {
    return false;
  }
  const workflowStep = value['workflowStep'];
  if (
    workflowStep !== undefined &&
    !(
      isRecord(workflowStep) &&
      typeof workflowStep['workflowId'] === 'string' &&
      typeof workflowStep['step'] === 'number' &&
      Number.isSafeInteger(workflowStep['step']) &&
      workflowStep['step'] >= 0 &&
      (workflowStep['stepAddress'] === undefined || typeof workflowStep['stepAddress'] === 'string')
    )
  ) {
    return false;
  }
  // The estimator selection belongs to a goal attempt's record and to nothing
  // else; a goal attempt's record without one cannot be priced, so it is not valid.
  const costEstimation = value['costEstimation'];
  if (
    goalAttempt === undefined
      ? costEstimation !== undefined
      : !isGoalAttemptCostEstimation(costEstimation)
  ) {
    return false;
  }
  return isCatalogAgentInput(value['input']);
}
