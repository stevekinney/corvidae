/**
 * `bureau.deployments.*` (COR-1813): the routing of a worker deployment, read and moved. `get`
 * reads the pointer (the current build, the ramping build and its share, and the previous build a
 * roll back returns to), and `ramp`, `promote`, and `rollback` move it through `Bureau.deployments`,
 * which fences every move by a routing generation and audits it.
 *
 * Worker deployments belong to the deployment's owner of record, like workflow files. A caller who
 * owns the deployment reaches them without a scope; `bureau.deployments:read` grants `get` to any
 * caller and `bureau.deployments:write` grants `ramp`, `promote`, and `rollback`, and neither implies
 * the other. A caller who may not read is answered `NotFound`. A caller who may read but not write
 * is refused with `Forbidden`.
 *
 * A move is refused with a typed fault and changes nothing: `NotFound` when the deployment has no
 * routing pointer or a named build is not registered, and `Conflict` (`data.reason`) for
 * `stale-generation` (with `currentGeneration`), `build-not-ready`, `same-as-current`,
 * `no-ramping-build`, and `no-previous-build`. A Bureau without `workerDeployments` answers
 * `UnsupportedCapability`.
 *
 * @module deployments-operations
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { ownerOrLocal } from '../../owner-of-record.ts';
import {
  type BureauWorkerDeployments,
  type BureauWorkerDeploymentRouting,
  WorkerDeploymentRolloutError,
} from '../../worker-deployments.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What the deployment rollout operations read from the handler's `host`. */
export type BureauWorkerDeploymentsOperationHost = BureauOwnershipHost & {
  readonly deployments: BureauWorkerDeployments | undefined;
};

const deploymentName = z
  .string()
  .min(1)
  .max(256)
  .describe('The name of the worker deployment whose routing is read or moved.');

const expectedGeneration = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'Apply the move only if the routing is still at this `generation`, for example the one `bureau.deployments.get` returned; a routing that has moved past it is a `Conflict` (`reason: "stale-generation"`). Omitted, the move is fenced by the generation it reads itself.',
  );

const routingSchema = z.object({
  deploymentName: z.string().describe('The deployment the routing belongs to.'),
  currentBuildId: z
    .string()
    .describe('The build that takes the new unpinned work the ramp does not.'),
  rampingBuildId: z
    .string()
    .nullable()
    .describe(
      'The build taking `rampBasisPoints` of new unpinned work, or `null` when none ramps.',
    ),
  rampBasisPoints: z
    .number()
    .int()
    .describe('The ramping build’s share of new unpinned work, from 0 to 10000.'),
  previousBuildId: z
    .string()
    .nullable()
    .describe(
      'The build that was current before the latest change of `currentBuildId`, which `bureau.deployments.rollback` returns to; `null` until the current build has changed once.',
    ),
  generation: z
    .number()
    .int()
    .describe('Increases by one on every write; pass it back as `expectedGeneration`.'),
  updatedAt: z.string().describe('When the routing was last written, as an ISO-8601 timestamp.'),
});

/** The owner of every worker deployment: the deployment's owner of record. */
const DEPLOYMENT_OWNER = ownerOrLocal(undefined);

function mayAccess(
  host: BureauWorkerDeploymentsOperationHost,
  principal: Principal,
  operatorScope: BureauScope,
): boolean {
  return host.ownership.mayAccess({ principal, resourceOwner: DEPLOYMENT_OWNER, operatorScope });
}

function notFound(resource: string, identifier: string, message: string): OperationFault {
  return { code: 'NotFound', message, data: { resource, identifier } };
}

function unsupported(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau has no worker deployment catalog',
    data: { capability: 'worker-deployments' },
  };
}

/** The deployments of the Bureau, for a caller who may read them; anyone else is answered `NotFound`. */
function readable(
  host: BureauWorkerDeploymentsOperationHost,
  principal: Principal,
  name: string,
): BureauWorkerDeployments {
  if (!mayAccess(host, principal, 'bureau.deployments:read')) {
    throw notFound('workerDeployment', name, `No worker deployment named "${name}"`);
  }
  if (host.deployments === undefined) throw unsupported();
  return host.deployments;
}

/** The deployments of the Bureau, for a caller who may move them. */
function writable(
  host: BureauWorkerDeploymentsOperationHost,
  principal: Principal,
  name: string,
): BureauWorkerDeployments {
  if (!mayAccess(host, principal, 'bureau.deployments:write')) {
    if (!mayAccess(host, principal, 'bureau.deployments:read')) {
      throw notFound('workerDeployment', name, `No worker deployment named "${name}"`);
    }
    throw {
      code: 'Forbidden',
      message: 'Moving a worker deployment requires bureau.deployments:write',
      data: { reason: 'missing scope bureau.deployments:write' },
    } satisfies OperationFault;
  }
  if (host.deployments === undefined) throw unsupported();
  return host.deployments;
}

/** The fault a refused rollout move is answered with, or rethrows `error`. */
function faultOf(error: unknown): never {
  if (!(error instanceof WorkerDeploymentRolloutError)) throw error;
  if (error.reason === 'no-routing') {
    throw notFound('workerDeploymentRouting', error.deploymentName, error.message);
  }
  if (error.reason === 'build-not-found') {
    throw notFound(
      'workerDeploymentVersion',
      `${error.deploymentName}/${error.buildId ?? ''}`,
      error.message,
    );
  }
  if (error.reason === 'invalid-ramp') {
    throw {
      code: 'InvalidParams',
      message: error.message,
      data: { issues: [{ path: ['rampBasisPoints'], message: error.message, code: 'custom' }] },
    } satisfies OperationFault;
  }
  throw {
    code: 'Conflict',
    message: error.message,
    data: {
      reason: error.reason,
      ...(error.currentGeneration === undefined
        ? {}
        : { currentGeneration: error.currentGeneration }),
    },
  } satisfies OperationFault;
}

/** Run a rollout move, answering a refusal as its fault. */
async function moved(
  move: () => Promise<BureauWorkerDeploymentRouting>,
): Promise<BureauWorkerDeploymentRouting> {
  try {
    return await move();
  } catch (error) {
    return faultOf(error);
  }
}

const getInput = z.object({ deploymentName });

export const deploymentsGetOperation = defineOperation<
  typeof getInput,
  typeof routingSchema,
  BureauWorkerDeploymentsOperationHost
>({
  name: 'bureau.deployments.get',
  mcpExposable: false,
  summary: 'Read a worker deployment’s routing',
  description:
    'Returns the routing of a worker deployment: `currentBuildId`, `rampingBuildId` (or `null`) with its share `rampBasisPoints` (0 to 10000), `previousBuildId` (the build a roll back returns to, or `null` before the current build has changed), and the `generation` to pass as `expectedGeneration` to a move. A deployment with no routing pointer yet is `NotFound`. Requires `bureau.deployments:read` unless the caller owns the deployment’s worker deployments; anyone else is answered `NotFound`, and a Bureau without a worker deployment catalog answers `UnsupportedCapability`.',
  destructive: false,
  tags: ['Deployments'],
  inputSchema: getInput,
  outputSchema: routingSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const routing = await readable(host, principal, input.deploymentName).get(input.deploymentName);
    if (routing === null) {
      throw notFound(
        'workerDeploymentRouting',
        input.deploymentName,
        `Deployment "${input.deploymentName}" has no routing pointer yet.`,
      );
    }
    return routing;
  },
});

const rampInput = z.object({
  deploymentName,
  buildId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The build to ramp: registered, ready, and different from the current build. A ramp already in place is replaced.',
    ),
  rampBasisPoints: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .describe(
      'The share of new unpinned work the build takes, in basis points from 0 to 10000. 0 stages the build without sending it work.',
    ),
  expectedGeneration,
});

export const deploymentsRampOperation = defineOperation<
  typeof rampInput,
  typeof routingSchema,
  BureauWorkerDeploymentsOperationHost
>({
  name: 'bureau.deployments.ramp',
  mcpExposable: false,
  summary: 'Ramp a build of a worker deployment',
  description:
    'Sends `rampBasisPoints` (0 to 10000) of the deployment’s new unpinned work to `buildId`, and the rest to the current build, replacing any ramp already in place. Work already bound to a build stays on it. Fenced by `expectedGeneration`, else by the generation read at the call; a routing that moved is a `Conflict` (`reason: "stale-generation"`, `currentGeneration`) and nothing changes. A build that is not registered, or a deployment with no routing pointer, is `NotFound`; a build that is draining (`build-not-ready`) or is the current build (`same-as-current`) is a `Conflict`. The move is recorded in the audit trail as `deployment.ramped`. Requires `bureau.deployments:write` unless the caller owns the deployment’s worker deployments.',
  destructive: true,
  tags: ['Deployments'],
  inputSchema: rampInput,
  outputSchema: routingSchema,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound', 'Conflict', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const deployments = writable(host, principal, input.deploymentName);
    return moved(() =>
      deployments.ramp(
        {
          deploymentName: input.deploymentName,
          buildId: input.buildId,
          rampBasisPoints: input.rampBasisPoints,
          expectedGeneration: input.expectedGeneration,
        },
        { actor: ownerOfPrincipal(principal) },
      ),
    );
  },
});

const moveInput = z.object({ deploymentName, expectedGeneration });

export const deploymentsPromoteOperation = defineOperation<
  typeof moveInput,
  typeof routingSchema,
  BureauWorkerDeploymentsOperationHost
>({
  name: 'bureau.deployments.promote',
  mcpExposable: false,
  summary: 'Promote the ramping build of a worker deployment',
  description:
    'Makes the ramping build the current build and clears the ramp, so all new unpinned work goes to it; the build it replaces becomes `previousBuildId`, which `bureau.deployments.rollback` returns to. Fenced by `expectedGeneration`, else by the generation read at the call; a routing that moved is a `Conflict` (`reason: "stale-generation"`, `currentGeneration`) and nothing changes. A deployment with nothing ramping is a `Conflict` (`no-ramping-build`), a ramping build that is no longer ready a `Conflict` (`build-not-ready`), and a deployment with no routing pointer `NotFound`. The move is recorded in the audit trail as `deployment.promoted`. Requires `bureau.deployments:write` unless the caller owns the deployment’s worker deployments.',
  destructive: true,
  tags: ['Deployments'],
  inputSchema: moveInput,
  outputSchema: routingSchema,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound', 'Conflict', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const deployments = writable(host, principal, input.deploymentName);
    return moved(() =>
      deployments.promote(
        {
          deploymentName: input.deploymentName,
          expectedGeneration: input.expectedGeneration,
        },
        { actor: ownerOfPrincipal(principal) },
      ),
    );
  },
});

export const deploymentsRollBackOperation = defineOperation<
  typeof moveInput,
  typeof routingSchema,
  BureauWorkerDeploymentsOperationHost
>({
  name: 'bureau.deployments.rollback',
  mcpExposable: false,
  summary: 'Roll a worker deployment back to its previous build',
  description:
    'Returns the deployment’s new unpinned work to `previousBuildId` and clears any ramp; the build it replaces becomes the new `previousBuildId`, so rolling back twice undoes the first. Fenced by `expectedGeneration`, else by the generation read at the call; a routing that moved is a `Conflict` (`reason: "stale-generation"`, `currentGeneration`) and nothing changes. A deployment whose current build has never changed is a `Conflict` (`no-previous-build`), a previous build that was removed `NotFound`, one that is draining a `Conflict` (`build-not-ready`), and a deployment with no routing pointer `NotFound`. The move is recorded in the audit trail as `deployment.rolled-back`. Requires `bureau.deployments:write` unless the caller owns the deployment’s worker deployments.',
  destructive: true,
  tags: ['Deployments'],
  inputSchema: moveInput,
  outputSchema: routingSchema,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound', 'Conflict', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const deployments = writable(host, principal, input.deploymentName);
    return moved(() =>
      deployments.rollBack(
        {
          deploymentName: input.deploymentName,
          expectedGeneration: input.expectedGeneration,
        },
        { actor: ownerOfPrincipal(principal) },
      ),
    );
  },
});

/** The four `bureau.deployments.*` operations. */
export const bureauWorkerDeploymentsOperations = [
  deploymentsGetOperation,
  deploymentsRampOperation,
  deploymentsPromoteOperation,
  deploymentsRollBackOperation,
] as const;
