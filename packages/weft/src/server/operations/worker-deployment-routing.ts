import { z } from 'zod';
import type {
  WorkerDeploymentCatalog,
  WorkerDeploymentRouting,
} from '../../worker/deployment-routing.ts';
import { shapeOperationFaultAsJson, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestTextBody } from '../rest-body.ts';
import { invalidParamsFault } from './operation-helpers.ts';

const routingInput = z.object({
  deploymentName: z.string().min(1),
  currentBuildId: z.string().min(1),
  rampingBuildId: z.string().min(1).optional(),
  rampBasisPoints: z.number().int().min(0).max(10_000),
  expectedGeneration: z.number().int().min(0).optional(),
});
const deploymentInput = z.object({ deploymentName: z.string().min(1), buildId: z.string().min(1) });
// Promote and rollback read the current generation themselves; a caller that previewed the change
// passes the generation the preview reported, and a move past it is a Conflict, not a silent overwrite.
const moveBuildInput = deploymentInput.extend({
  expectedGeneration: z.number().int().min(0).optional(),
});
const routingFaults = ['Conflict', 'InvalidParams', 'NotFound'] as const;
const diagnosticsInput = z.object({ deploymentName: z.string().min(1).optional() });
const access = {
  kind: 'scoped' as const,
  scopes: { kind: 'anyOf' as const, scopes: ['system:admin'] as const },
};
type Options = { catalog?: WorkerDeploymentCatalog };
type RoutingInput = z.infer<typeof routingInput>;

function unavailable(name: string): Error {
  return new Error(`${name} requires a live worker deployment catalog.`);
}

const operationTransports = {
  http: true,
  jsonRpcHttp: true,
  jsonRpcWebSocket: true,
  jsonRpcStdio: true,
} as const;

const routingResultSchema = z.object({
  deploymentName: z.string(),
  currentBuildId: z.string(),
  rampingBuildId: z.string().optional(),
  rampBasisPoints: z.number(),
  generation: z.number(),
  updatedAt: z.number(),
});

function versionNotFoundFault(deploymentName: string, buildId: string): OperationFault {
  return {
    code: 'NotFound',
    message: `Deployment build ${deploymentName}/${buildId} does not exist.`,
    data: { resource: 'workerDeploymentVersion', identifier: `${deploymentName}/${buildId}` },
  };
}

/** A routing change lost to another writer, or based on a generation the pointer has moved past. */
function staleGenerationFault(
  deploymentName: string,
  currentGeneration: number,
  expectedGeneration: number | undefined,
): OperationFault {
  const expected =
    expectedGeneration === undefined ? '' : ` (expected generation ${expectedGeneration})`;
  return {
    code: 'Conflict',
    message: `Routing generation for deployment "${deploymentName}" changed concurrently${expected}; retry with generation ${currentGeneration}.`,
    data: { reason: 'stale-generation', currentGeneration },
  };
}

function versionNotReadyFault(
  deploymentName: string,
  buildId: string,
  state: string,
): OperationFault {
  return {
    code: 'Conflict',
    message: `Deployment build ${deploymentName}/${buildId} is ${state}, so it is not eligible for routing.`,
    data: { reason: 'version-not-ready' },
  };
}

async function currentGenerationOf(
  catalog: WorkerDeploymentCatalog,
  deploymentName: string,
): Promise<number> {
  const routing = await catalog.getRouting(deploymentName);
  return routing?.generation ?? 0;
}

/** Fails a stale `expectedGeneration` before any write, so a preview and a mutation agree. */
async function assertExpectedGeneration(
  catalog: WorkerDeploymentCatalog,
  deploymentName: string,
  expectedGeneration: number | undefined,
): Promise<void> {
  if (expectedGeneration === undefined) return;
  const current = await currentGenerationOf(catalog, deploymentName);
  if (current !== expectedGeneration) {
    throw staleGenerationFault(deploymentName, current, expectedGeneration);
  }
}

export function createSetWorkerDeploymentRoutingOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.setrouting',
    mcpExposable: false,
    summary: 'Set a deployment routing pointer',
    description:
      'Set the current build, the optional ramping build, and the ramp share (basis points) of a ' +
      "deployment's routing pointer. Pass `expectedGeneration` to apply the change only if the " +
      'pointer is still at that generation; a pointer that has moved faults with Conflict ' +
      '(`reason: "stale-generation"`, `currentGeneration`). A build that does not exist faults with ' +
      'NotFound; one that is not ready faults with Conflict.',
    destructive: true,
    tags: ['System'],
    inputSchema: routingInput,
    outputSchema: routingResultSchema,
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('setRouting');
      const target = await validateRoutingTargets(options.catalog, input);
      return setRoutingOrThrow(options.catalog, target);
    },
  });
}

async function moveToBuild(
  catalog: WorkerDeploymentCatalog,
  input: z.infer<typeof moveBuildInput>,
): Promise<WorkerDeploymentRouting> {
  const target = await validateRoutingTargets(catalog, {
    deploymentName: input.deploymentName,
    currentBuildId: input.buildId,
    rampBasisPoints: 10_000,
  });
  // Without an `expectedGeneration` the move is conditional on the generation just read, which
  // still refuses a pointer that moves between the read and the write.
  const expectedGeneration =
    input.expectedGeneration ?? (await currentGenerationOf(catalog, input.deploymentName));
  return setRoutingOrThrow(catalog, { ...target, expectedGeneration });
}

export function createPromoteWorkerDeploymentOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.promote',
    mcpExposable: false,
    summary: 'Promote a deployment build',
    description:
      "Route all of a deployment's new unpinned traffic to one build. Pass `expectedGeneration` " +
      '(for example from `weft.worker.deployments.preview`) to apply the change only if the ' +
      'pointer is still at that generation; otherwise it applies against the generation current ' +
      'at the time of the call. A moved pointer faults with Conflict (`reason: "stale-generation"`).',
    destructive: true,
    tags: ['System'],
    inputSchema: moveBuildInput,
    outputSchema: routingResultSchema.omit({ rampingBuildId: true }),
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('promote');
      return moveToBuild(options.catalog, input);
    },
  });
}

export function createRollbackWorkerDeploymentOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.rollback',
    mcpExposable: false,
    summary: 'Rollback a deployment to a build',
    description:
      'Route all new unpinned traffic of a deployment back to a previously registered build. ' +
      'Takes the same `expectedGeneration` precondition and faults as promote.',
    destructive: true,
    tags: ['System'],
    inputSchema: moveBuildInput,
    outputSchema: routingResultSchema.omit({ rampingBuildId: true }),
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('rollback');
      return moveToBuild(options.catalog, input);
    },
  });
}

export function createRemoveWorkerDeploymentVersionOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.remove',
    mcpExposable: false,
    summary: 'Remove a deployment build that nothing references',
    description:
      'Mark one deployment build removed so it can no longer be routed to. A build that does ' +
      'not exist, or was already removed, faults with NotFound. A build that a pinned run, ' +
      'schedule, pending requirement, attempt, or realm still references (`executionReferences` ' +
      'above zero) faults with Conflict (`reason: "version-referenced"`) and is left as it was.',
    destructive: true,
    tags: ['System'],
    inputSchema: deploymentInput,
    outputSchema: z.object({
      deploymentName: z.string(),
      buildId: z.string(),
      removed: z.literal(true),
    }),
    access,
    producibleFaults: ['Conflict', 'NotFound'],
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      const catalog = options.catalog;
      if (catalog === undefined) throw unavailable('remove');
      const version = await catalog.getVersion(input.deploymentName, input.buildId);
      if (version === null || version.state === 'removed') {
        throw versionNotFoundFault(input.deploymentName, input.buildId);
      }
      if (!(await catalog.removeVersion(input.deploymentName, input.buildId))) {
        // Either a reference was taken since the read, or the record changed under it. Read again
        // so the fault reports what is true now.
        const now = await catalog.getVersion(input.deploymentName, input.buildId);
        if (now === null || now.state === 'removed') {
          throw versionNotFoundFault(input.deploymentName, input.buildId);
        }
        const referenced: OperationFault = {
          code: 'Conflict',
          message: `Deployment build ${input.deploymentName}/${input.buildId} is still referenced by ${now.executionReferences} execution${now.executionReferences === 1 ? '' : 's'} and cannot be removed.`,
          data: { reason: 'version-referenced' },
        };
        throw referenced;
      }
      return {
        deploymentName: input.deploymentName,
        buildId: input.buildId,
        removed: true as const,
      };
    },
  });
}

export function createWorkerDeploymentDiagnosticsOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.diagnostics',
    mcpExposable: false,
    summary: 'List deployment versions and routing pointers',
    destructive: false,
    tags: ['System'],
    inputSchema: diagnosticsInput,
    outputSchema: z.object({ versions: z.array(z.any()), routing: z.any() }),
    access: {
      kind: 'scoped' as const,
      scopes: { kind: 'anyOf' as const, scopes: ['system:read'] as const },
    },
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('diagnostics');
      return {
        versions: [...(await options.catalog.diagnostics(input.deploymentName))],
        routing:
          input.deploymentName === undefined
            ? null
            : await options.catalog.getRouting(input.deploymentName),
      };
    },
  });
}

export function createPreviewWorkerDeploymentRoutingOperation(options: Options = {}) {
  return defineOperation({
    name: 'weft.worker.deployments.preview',
    mcpExposable: false,
    summary: 'Validate a deployment routing change without mutating it',
    description:
      'Check that a routing change would be accepted, without applying it: the builds exist, ' +
      'are ready, and the ramp is valid. Returns the routing generation as it stands, ' +
      '`currentGeneration` (`0` before the first routing change), to pass as ' +
      '`expectedGeneration` to the change itself. When `expectedGeneration` is given and the ' +
      'pointer has moved past it, faults with Conflict (`reason: "stale-generation"`).',
    destructive: false,
    tags: ['System'],
    inputSchema: routingInput,
    outputSchema: z.object({
      valid: z.boolean(),
      message: z.string(),
      currentGeneration: z.number().int().min(0),
    }),
    access,
    producibleFaults: routingFaults,
    transports: operationTransports,
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      if (options.catalog === undefined) throw unavailable('preview');
      await validateRoutingTargets(options.catalog, input);
      await assertExpectedGeneration(
        options.catalog,
        input.deploymentName,
        input.expectedGeneration,
      );
      return {
        valid: true,
        message: 'Routing targets are available and immutable identities agree.',
        currentGeneration: await currentGenerationOf(options.catalog, input.deploymentName),
      };
    },
  });
}

async function requireReadyVersion(
  catalog: WorkerDeploymentCatalog,
  deploymentName: string,
  buildId: string,
): Promise<void> {
  const version = await catalog.getVersion(deploymentName, buildId);
  if (version === null || version.state === 'removed') {
    throw versionNotFoundFault(deploymentName, buildId);
  }
  if (version.state !== 'ready') throw versionNotReadyFault(deploymentName, buildId, version.state);
}

async function validateRoutingTargets(
  catalog: WorkerDeploymentCatalog,
  input: RoutingInput,
): Promise<Omit<WorkerDeploymentRouting, 'generation'> & { expectedGeneration?: number }> {
  if (input.rampingBuildId === input.currentBuildId) {
    throw invalidParamsFault('Ramping deployment build must differ from the current build.');
  }
  await requireReadyVersion(catalog, input.deploymentName, input.currentBuildId);
  if (input.rampingBuildId !== undefined) {
    await requireReadyVersion(catalog, input.deploymentName, input.rampingBuildId);
  }
  return {
    deploymentName: input.deploymentName,
    currentBuildId: input.currentBuildId,
    rampBasisPoints: input.rampBasisPoints,
    updatedAt: Date.now(),
    ...(input.rampingBuildId === undefined ? {} : { rampingBuildId: input.rampingBuildId }),
    ...(input.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: input.expectedGeneration }),
  };
}

async function setRoutingOrThrow(
  catalog: WorkerDeploymentCatalog,
  input: Omit<WorkerDeploymentRouting, 'generation'> & { expectedGeneration?: number },
): Promise<WorkerDeploymentRouting> {
  const result = await catalog.setRouting(input);
  if (result === null) {
    throw staleGenerationFault(
      input.deploymentName,
      await currentGenerationOf(catalog, input.deploymentName),
      input.expectedGeneration,
    );
  }
  return result;
}

export const setWorkerDeploymentRoutingOperation = createSetWorkerDeploymentRoutingOperation();
export const promoteWorkerDeploymentOperation = createPromoteWorkerDeploymentOperation();
export const rollbackWorkerDeploymentOperation = createRollbackWorkerDeploymentOperation();
export const workerDeploymentDiagnosticsOperation = createWorkerDeploymentDiagnosticsOperation();
export const previewWorkerDeploymentRoutingOperation =
  createPreviewWorkerDeploymentRoutingOperation();
export const removeWorkerDeploymentVersionOperation =
  createRemoveWorkerDeploymentVersionOperation();

function binding(method: 'GET' | 'POST', path: string, operationName: string): UnknownRestBinding {
  return {
    method,
    path,
    pathParamNames: [],
    operationName,
    inputSources: { body: { kind: 'body', mediaType: 'application/json' } },
    extractInput: async (request, _path, context) =>
      JSON.parse(await readRestTextBody(request, context)),
    success: { kind: 'json', status: 200 },
    shapeFault: shapeOperationFaultAsJson,
  };
}
export const workerDeploymentRoutingRestBinding = binding(
  'POST',
  '/v1/worker-deployments/routing',
  'weft.worker.deployments.setrouting',
);
export const workerDeploymentDiagnosticsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/worker-deployments/diagnostics',
  pathParamNames: [],
  operationName: 'weft.worker.deployments.diagnostics',
  inputSources: { deploymentName: { kind: 'query', queryParam: 'deploymentName' } },
  extractInput: async (request) => {
    const deploymentName = new URL(request.url).searchParams.get('deploymentName');
    return deploymentName === null ? {} : { deploymentName };
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeOperationFaultAsJson,
};
export const workerDeploymentPromoteRestBinding = binding(
  'POST',
  '/v1/worker-deployments/promote',
  'weft.worker.deployments.promote',
);
export const workerDeploymentRollbackRestBinding = binding(
  'POST',
  '/v1/worker-deployments/rollback',
  'weft.worker.deployments.rollback',
);
export const workerDeploymentPreviewRestBinding = binding(
  'POST',
  '/v1/worker-deployments/preview',
  'weft.worker.deployments.preview',
);
export const workerDeploymentRemoveRestBinding = binding(
  'POST',
  '/v1/worker-deployments/remove',
  'weft.worker.deployments.remove',
);
