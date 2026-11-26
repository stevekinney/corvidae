import { z } from 'zod';
import { assertOperationEngineMethods } from './operation-helpers.ts';

import { type OperationFault, defineOperation } from '@lostgradient/backchannel';
import type { UnknownRestBinding } from '@lostgradient/backchannel/internals';
import type { WorkflowTimelineEntry } from '../../core/types.ts';
import { negotiatedResponse } from '../handler/response-helpers.ts';

const getWorkflowTimelineInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow whose timeline is read.'),
});
type TimelineOperationShape = {
  index: number;
  documentStep?: number | undefined;
  documentStepAddress?: string | undefined;
  key?: string | undefined;
  operationId: string;
  operationType: string;
  operationLabel: string;
  outcome: 'fulfilled' | 'rejected' | 'won' | 'lost';
  errorSummary?: string | undefined;
  branches?: TimelineOperationShape[] | undefined;
};
const timelineOperation: z.ZodType<TimelineOperationShape> = z
  .object({
    index: z.number(),
    documentStep: z.number().optional(),
    documentStepAddress: z.string().optional(),
    key: z.string().optional(),
    operationId: z.string(),
    operationType: z.string(),
    operationLabel: z.string(),
    outcome: z.enum(['fulfilled', 'rejected', 'won', 'lost']),
    errorSummary: z.string().optional(),
    branches: z.array(z.lazy(() => timelineOperation)).optional(),
  })
  .passthrough();
const getWorkflowTimelineShape = z.array(
  z
    .object({
      step: z.number(),
      stepIndex: z.number().optional(),
      documentStep: z.number().optional(),
      documentStepAddress: z.string().optional(),
      operationType: z.string(),
      operationLabel: z.string(),
      inputSummary: z.string(),
      outputSummary: z.string().optional(),
      duration: z.number().optional(),
      timestamp: z.number(),
      status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed-out']),
      versionTuple: z
        .object({
          workflowVersion: z.string(),
          agentVersion: z.string().optional(),
          toolVersions: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional(),
      branches: z.array(timelineOperation).optional(),
      branchesOmitted: z.number().optional(),
      children: z.array(timelineOperation).optional(),
      childrenOmitted: z.number().optional(),
      speculationOutcome: z.enum(['committed', 'rolled-back']).optional(),
      taskOperationId: z.string().optional(),
    })
    .passthrough(),
);
const getWorkflowTimelineOutput = getWorkflowTimelineShape;

export type GetWorkflowTimelineInput = z.infer<typeof getWorkflowTimelineInput>;
export type GetWorkflowTimelineOutput = WorkflowTimelineEntry[];

export const getWorkflowTimelineOperation = defineOperation({
  name: 'weft.workflows.timeline.get',
  mcpExposable: false,
  summary: 'Get the structured execution timeline for a workflow',
  description:
    'Read the structured execution timeline of a workflow: one chronological entry per operation the run performed (activity call, sleep, signal wait, and so on). Read-only. Faults with NotFound when the workflow is ' +
    'not visible.',
  destructive: false,
  tags: ['Checkpoints'],
  inputSchema: getWorkflowTimelineInput,
  outputSchema: getWorkflowTimelineOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } },
  discoverable: true,
  producibleFaults: ['NotFound'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  // Operation contract is transport-neutral: returns the array of
  // timeline entries directly. Accept-header negotiation between
  // json and msgpack is REST-specific and lives in the binding's
  // `shapeSuccess`, not on the operation output type.
  invoke: async ({ input, host: engine }): Promise<GetWorkflowTimelineOutput> => {
    assertOperationEngineMethods(engine, ['get', 'getTimeline']);
    const e = engine;
    const state = await e.get(input.workflowId);
    if (state === null) {
      const fault: OperationFault = {
        code: 'NotFound',
        message: `Workflow "${input.workflowId}" not found`,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw fault;
    }
    return e.getTimeline(input.workflowId);
  },
});

function shapeGetWorkflowTimelineSuccess(
  result: GetWorkflowTimelineOutput,
  request: Request,
): Response {
  return negotiatedResponse(request, result, 200);
}

export const getWorkflowTimelineRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/timeline',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.timeline.get',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
  },
  extractInput: async (_request, pathParams) => ({
    workflowId: pathParams['id'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetWorkflowTimelineOutput, request: Request) =>
    shapeGetWorkflowTimelineSuccess(output, request),
};
