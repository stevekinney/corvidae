import { KEYS } from '../../../storage/keys.ts';
import { deserializeCheckpoint } from '../../checkpoint.ts';
import { encode } from '../../codec.ts';
import type { StartWorkflowOptions, WorkflowState } from '../../types.ts';
import { releaseLaunchCheckpoint } from '../checkpoint-commit-snapshots.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import type { EngineInternals } from '../internals.ts';
import { decodeEpoch } from '../lease-codec.ts';
import { WorkflowClaimUnavailableError } from '../lease-errors.ts';
import { loadWorkflowState } from '../storage-io.ts';
import {
  releasePreparedWorkflowReservation,
  type PrepareWorkflowResult,
  type PreparedWorkflowContext,
} from './prepare-and-launch.ts';
import {
  createWorkflowHandle,
  normalizeStartWorkflowTags,
  type LifecycleCallbacks,
} from './shared.ts';
import {
  acquireStandaloneClaimBeforeResume,
  releaseFreshlyAcquiredResumeClaim,
} from './standalone-claim-acquire.ts';
import { createLaunchAdoption } from './start-transient-state.ts';

export async function acquireReservedWorkflowClaim(
  internals: EngineInternals,
  workflowId: string,
): Promise<Awaited<ReturnType<typeof acquireStandaloneClaimBeforeResume>>> {
  try {
    return await acquireStandaloneClaimBeforeResume(internals, workflowId);
  } catch (error) {
    if (!(error instanceof WorkflowClaimUnavailableError) || !internals.workflowClaimRegistry)
      throw error;
    const takeover = await internals.workflowClaimRegistry.takeover(workflowId);
    if (takeover.status !== 'acquired') throw error;
    return { freshlyAcquired: true, epoch: takeover.epoch };
  }
}

function matchesPrepared(
  state: WorkflowState | null,
  type: string,
  expectedInput: Uint8Array,
  expectedTags: string,
): boolean {
  if (!state || state.status !== 'pending' || state.type !== type) return false;
  const actual = encode(state.input);
  return (
    expectedInput.length === actual.length &&
    expectedInput.every((byte, index) => byte === actual[index]) &&
    JSON.stringify(state.tags ?? []) === expectedTags
  );
}

function assertAdoptionAllowed(
  internals: EngineInternals,
  options: StartWorkflowOptions & { id: string },
): void {
  if (internals.options.ownershipMode !== 'workflow-lease')
    throw new Error('Prepared adoption requires workflow-lease ownership.');
  if (!options.tags?.includes('weft:reserved-start'))
    throw new Error('Prepared adoption requires a reserved-start marker.');
  if (internals.pendingStarts.has(options.id)) throw new WorkflowAlreadyExistsError(options.id);
}

function adoptedContext(
  internals: EngineInternals,
  type: string,
  options: StartWorkflowOptions & { id: string },
): PreparedWorkflowContext {
  return {
    workflowId: options.id,
    type,
    options,
    claimEpoch: internals.workflowClaimRegistry?.currentEpochBytes(options.id) ?? undefined,
    inFlightRevision: undefined,
    phase: 'prepared',
    reservationReleased: false,
  };
}

/** Reacquire an exact pending workflow without repeating its initial durable write. */
export async function adoptPreparedWorkflow(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartWorkflowOptions & { id: string },
  callbacks: LifecycleCallbacks,
): Promise<PrepareWorkflowResult> {
  const workflowId = options.id;
  assertAdoptionAllowed(internals, options);
  const expectedInput = encode(input);
  const expectedTags = JSON.stringify(
    normalizeStartWorkflowTags(internals, options.tags, 'options.tags', callbacks) ?? [],
  );
  internals.pendingStarts.add(workflowId);
  let acquired: Awaited<ReturnType<typeof acquireStandaloneClaimBeforeResume>> | undefined;
  try {
    if (
      !matchesPrepared(
        await loadWorkflowState(internals, workflowId),
        type,
        expectedInput,
        expectedTags,
      )
    )
      throw new WorkflowAlreadyExistsError(workflowId);
    acquired = await acquireReservedWorkflowClaim(internals, workflowId);
    const state = await loadWorkflowState(internals, workflowId);
    if (!matchesPrepared(state, type, expectedInput, expectedTags))
      throw new WorkflowAlreadyExistsError(workflowId);
    const checkpointBytes = await internals.storage.get(KEYS.checkpoint(workflowId));
    if (!checkpointBytes)
      throw new Error(`Cannot adopt workflow "${workflowId}": its checkpoint is missing.`);
    const registration = await callbacks.resolveExecutableRegistrationForRevision(
      type,
      state!.revision,
    );
    const launch = createLaunchAdoption(internals, workflowId);
    launch.adopt(deserializeCheckpoint(checkpointBytes), checkpointBytes, {
      options,
      limitsConcurrency: registration.entry.concurrency !== undefined,
    });
    return {
      handle: createWorkflowHandle(internals, workflowId, callbacks),
      context: adoptedContext(internals, type, options),
    };
  } catch (error) {
    internals.pendingStarts.delete(workflowId);
    if (acquired?.freshlyAcquired)
      await releaseFreshlyAcquiredResumeClaim(internals, workflowId, acquired.epoch);
    throw error;
  }
}

export async function releasePreparedWorkflow(
  internals: EngineInternals,
  context: PreparedWorkflowContext,
): Promise<void> {
  if (context.phase !== 'prepared')
    throw new Error(
      `Cannot release workflow "${context.workflowId}": it was already ${context.phase}.`,
    );
  if (!context.options?.tags?.includes('weft:reserved-start'))
    throw new Error('Only a reserved prepared start may be released.');
  context.phase = 'released';
  try {
    releaseLaunchCheckpoint(internals, context.workflowId);
    internals.workflowServices.delete(context.workflowId);
    internals.workflowHeaders.delete(context.workflowId);
    internals.workflowVersionTuples.delete(context.workflowId);
    internals.workflowsNeedingTerminalCleanup.delete(context.workflowId);
    const epoch = context.claimEpoch === undefined ? null : decodeEpoch(context.claimEpoch);
    if (epoch !== null)
      await releaseFreshlyAcquiredResumeClaim(internals, context.workflowId, epoch);
  } finally {
    releasePreparedWorkflowReservation(internals, context);
  }
}
