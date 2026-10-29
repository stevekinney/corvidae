/**
 * Data layer for deployment versions and routing (COR-277): runtime guards for
 * `weft.worker.deployments.diagnostics`, whose output the generated client
 * types as `unknown`, and the mutations behind routing, promote, rollback,
 * version drain, and removal.
 *
 * The guards build on Weft's own exported `WorkerDeploymentVersionReport` and
 * `WorkerDeploymentRouting`, so a change to either surfaces here as a type
 * error. Nothing in this module chooses a build or validates a routing change:
 * both stay with the server, and the UI only forwards what the operator asked
 * for and reports the typed fault it gets back.
 *
 * @module
 */
import type {
  HttpClient,
  WorkerDeploymentRouting,
  WorkerDeploymentVersionReport,
} from '@lostgradient/weft';
import { HttpClientError } from '@lostgradient/weft';
import {
  createMutation,
  createQuery,
  type CreateMutationResult,
  type QueryClient,
} from '@tanstack/svelte-query';

import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
import { queryKeys } from '../../lib/query.ts';
import { invalidateWorkerSurfaceQueries } from './workers-data.ts';

type DeploymentOperations = Pick<HttpClient, 'operations'>;

const REFETCH_INTERVAL_MS = 30_000;

/** A deployment diagnostics response the dashboard refuses to render. */
export class MalformedDeploymentsError extends Error {
  constructor(what: string) {
    super(`Weft returned malformed deployment diagnostics: ${what}.`);
    this.name = 'MalformedDeploymentsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VERSION_STATES: ReadonlySet<unknown> = new Set(['ready', 'draining', 'removed']);

function isDeploymentVersion(value: unknown): value is WorkerDeploymentVersionReport {
  return (
    isRecord(value) &&
    typeof value['deploymentName'] === 'string' &&
    typeof value['buildId'] === 'string' &&
    typeof value['artifactDigest'] === 'string' &&
    typeof value['manifestDigest'] === 'string' &&
    VERSION_STATES.has(value['state']) &&
    typeof value['firstSeenAt'] === 'number' &&
    Number.isFinite(value['firstSeenAt']) &&
    typeof value['executionReferences'] === 'number' &&
    Number.isInteger(value['executionReferences']) &&
    value['executionReferences'] >= 0 &&
    isRecord(value['manifest']) &&
    isRecord(value['manifest']['deployment']) &&
    isRecord(value['manifest']['workflows'])
  );
}

function isDeploymentRouting(value: unknown): value is WorkerDeploymentRouting {
  return (
    isRecord(value) &&
    typeof value['deploymentName'] === 'string' &&
    typeof value['currentBuildId'] === 'string' &&
    (value['rampingBuildId'] === undefined || typeof value['rampingBuildId'] === 'string') &&
    typeof value['rampBasisPoints'] === 'number' &&
    Number.isInteger(value['rampBasisPoints']) &&
    value['rampBasisPoints'] >= 0 &&
    value['rampBasisPoints'] <= 10_000 &&
    typeof value['generation'] === 'number' &&
    Number.isInteger(value['generation']) &&
    value['generation'] >= 1 &&
    typeof value['updatedAt'] === 'number'
  );
}

export interface DeploymentOverview {
  readonly deploymentName: string;
  /** Every retained version, `removed` ones included, ordered by build id. */
  readonly versions: readonly WorkerDeploymentVersionReport[];
  /** The routing pointer, or `null` before the first routing change. */
  readonly routing: WorkerDeploymentRouting | null;
}

/** Validates a `{ versions, routing }` diagnostics response at the trust boundary. */
export function parseDeploymentDiagnostics(value: unknown): {
  versions: readonly WorkerDeploymentVersionReport[];
  routing: WorkerDeploymentRouting | null;
} {
  if (!isRecord(value) || !Array.isArray(value['versions'])) {
    throw new MalformedDeploymentsError('no versions list');
  }
  const versions: unknown[] = value['versions'];
  if (!versions.every(isDeploymentVersion)) throw new MalformedDeploymentsError('a version record');
  const routing = value['routing'];
  if (routing !== null && routing !== undefined && !isDeploymentRouting(routing)) {
    throw new MalformedDeploymentsError('the routing pointer');
  }
  return { versions, routing: routing ?? null };
}

/**
 * One overview per deployment: the unscoped read names the deployments, then
 * each is read by name, because the server returns a routing pointer only for
 * a named deployment.
 */
export async function loadDeploymentOverviews(
  client: DeploymentOperations,
): Promise<readonly DeploymentOverview[]> {
  const all = parseDeploymentDiagnostics(
    await client.operations['weft.worker.deployments.diagnostics']({}),
  );
  const names = [...new Set(all.versions.map((version) => version.deploymentName))].toSorted();
  return Promise.all(
    names.map(async (deploymentName) => {
      const named = parseDeploymentDiagnostics(
        await client.operations['weft.worker.deployments.diagnostics']({ deploymentName }),
      );
      return {
        deploymentName,
        versions: named.versions.toSorted((left, right) =>
          left.buildId.localeCompare(right.buildId),
        ),
        routing: named.routing,
      };
    }),
  );
}

export function deploymentOverviewsQuery(client: DeploymentOperations) {
  // `worker:deployment-changed` asks for the overviews again; the timer runs only while the fleet
  // feed is not live.
  const fleetLive = useFleetEventsLive();
  return createQuery(() => {
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.workers.deployments(),
      queryFn: () => loadDeploymentOverviews(client),
      // A malformed response is deterministic; the poll recovers a transient fault.
      retry: false,
      // poll-reason: fallback
      refetchInterval: polling ? REFETCH_INTERVAL_MS : false,
    };
  });
}

/** The routing generation a Conflict reported, when the fault is a stale-generation Conflict. */
export function staleGenerationOf(error: unknown): number | undefined {
  if (!(error instanceof HttpClientError) || error.status !== 409) return undefined;
  const generation = error.data?.['currentGeneration'];
  return typeof generation === 'number' && Number.isInteger(generation) ? generation : undefined;
}

/** Whether a Conflict names why: `version-not-draining`, `version-referenced`, `version-routed`, `version-not-ready`, or `stale-generation`. */
export function conflictReasonOf(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError) || error.status !== 409) return undefined;
  const reason = error.data?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** Invalidates everything a routing, drain, or removal change makes stale. */
export function invalidateDeploymentQueries(queryClient: Pick<QueryClient, 'invalidateQueries'>) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.workers.deployments() });
  invalidateWorkerSurfaceQueries(queryClient);
}

export interface RoutingChange {
  readonly deploymentName: string;
  readonly currentBuildId: string;
  readonly rampingBuildId?: string;
  readonly rampBasisPoints: number;
}

export interface PreviewResult {
  readonly valid: boolean;
  readonly message: string;
  /** The routing generation to pass as `expectedGeneration`. */
  readonly currentGeneration: number;
}

function isPreviewResult(value: unknown): value is PreviewResult {
  return (
    isRecord(value) &&
    typeof value['valid'] === 'boolean' &&
    typeof value['message'] === 'string' &&
    typeof value['currentGeneration'] === 'number' &&
    Number.isInteger(value['currentGeneration']) &&
    value['currentGeneration'] >= 0
  );
}

/** Validates a routing change without applying it (`weft.worker.deployments.preview`, `system:admin`). */
export async function previewRoutingChange(
  client: DeploymentOperations,
  change: RoutingChange,
): Promise<PreviewResult> {
  const result: unknown = await client.operations['weft.worker.deployments.preview'](change);
  if (!isPreviewResult(result)) throw new MalformedDeploymentsError('the preview result');
  return result;
}

export type RoutingAction =
  | {
      readonly kind: 'setrouting';
      readonly change: RoutingChange;
    }
  | {
      readonly kind: 'promote' | 'rollback';
      readonly deploymentName: string;
      readonly buildId: string;
    };

export interface ApplyRoutingVariables {
  readonly action: RoutingAction;
  /** The generation the preview reported; the server refuses the change if the pointer has moved past it. */
  readonly expectedGeneration: number;
}

/** Applies a previewed routing change with its generation precondition. */
export function applyRoutingMutation(
  client: DeploymentOperations,
  onSettled: () => void,
): CreateMutationResult<unknown, Error, ApplyRoutingVariables> {
  return createMutation(() => ({
    mutationFn: ({ action, expectedGeneration }: ApplyRoutingVariables) => {
      switch (action.kind) {
        case 'setrouting':
          return client.operations['weft.worker.deployments.setrouting']({
            ...action.change,
            expectedGeneration,
          });
        case 'promote':
          return client.operations['weft.worker.deployments.promote']({
            deploymentName: action.deploymentName,
            buildId: action.buildId,
            expectedGeneration,
          });
        case 'rollback':
          return client.operations['weft.worker.deployments.rollback']({
            deploymentName: action.deploymentName,
            buildId: action.buildId,
            expectedGeneration,
          });
      }
    },
    onSettled,
  }));
}

export interface VersionVariables {
  readonly deploymentName: string;
  readonly buildId: string;
}

/**
 * `weft.worker.deployments.remove` (`system:admin`). `onFailure` is an options-level callback: it
 * fires for every failed call, where a callback passed to `mutate()` fires only for the latest one,
 * so overlapping actions each report their own fault.
 */
export function removeVersionMutation(
  client: DeploymentOperations,
  onSettled: () => void,
  onFailure: (error: unknown) => void,
): CreateMutationResult<unknown, unknown, VersionVariables> {
  return createMutation(() => ({
    mutationFn: (variables: VersionVariables) =>
      client.operations['weft.worker.deployments.remove'](variables),
    onSettled,
    onError: onFailure,
  }));
}

/** `weft.worker.deployments.drain` scoped to one build (`system:admin`). */
export function drainVersionMutation(
  client: DeploymentOperations,
  onSettled: () => void,
  onFailure: (error: unknown) => void,
): CreateMutationResult<unknown, unknown, VersionVariables & { readonly reason?: string }> {
  return createMutation(() => ({
    mutationFn: (variables: VersionVariables & { readonly reason?: string }) =>
      client.operations['weft.worker.deployments.drain'](variables),
    onSettled,
    onError: onFailure,
  }));
}

/** `weft.worker.deployments.resume` scoped to one build (`system:admin`). */
export function resumeVersionMutation(
  client: DeploymentOperations,
  onSettled: () => void,
  onFailure: (error: unknown) => void,
): CreateMutationResult<unknown, unknown, VersionVariables> {
  return createMutation(() => ({
    mutationFn: (variables: VersionVariables) =>
      client.operations['weft.worker.deployments.resume'](variables),
    onSettled,
    onError: onFailure,
  }));
}
