import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { SearchAttributeValue } from '../../core/types.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { readRestJsonBody } from '../rest-body.ts';
import {
  assertOperationEngineMethods,
  invalidParamsFault,
  isOperationFault,
} from './operation-helpers.ts';
import { normalizeDateTimeSearchAttributes } from './start-workflow-options.ts';

const setWorkflowAttributesInput = z.object({
  workflowId: z.string().min(1),
  attributes: z.unknown().optional(),
});
const setWorkflowAttributesOutput = z.object({
  ok: z.literal(true),
});

export type SetWorkflowAttributesInput = z.infer<typeof setWorkflowAttributesInput>;
export type SetWorkflowAttributesOutput = z.infer<typeof setWorkflowAttributesOutput>;

export const setWorkflowAttributesOperation = defineOperation({
  name: 'weft.workflows.attributes.set',
  mcpExposable: false,
  summary: 'Update search attributes for a workflow',
  // Not destructive: search attributes are operational metadata, not execution
  // state, and an overwrite is trivially reversible by setting them again. It
  // does not advance or terminate the workflow. Consistent with tags.add/remove.
  destructive: false,
  tags: ['Attributes'],
  inputSchema: setWorkflowAttributesInput,
  outputSchema: setWorkflowAttributesOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['attributes:write'] } },
  discoverable: true,
  producibleFaults: ['InvalidParams'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<SetWorkflowAttributesOutput> => {
    assertOperationEngineMethods(engine, ['setAttributes', 'get', 'getWorkflowDefinition']);
    const e = engine;

    try {
      // REST forwards whatever lived under `attributes`
      // directly into `engine.setAttributes`, defaulting only on
      // null/undefined. Keep that contract intact here, except for the ISO strings a JSON
      // transport carries for `date-time` attributes: they become `Date`s the way a start's do.
      await e.setAttributes(
        input.workflowId,
        (await normalizeAttributeDates(e, input.workflowId, input.attributes ?? {})) as Record<
          string,
          SearchAttributeValue
        >,
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof StartWorkflowValidationError) {
        throw invalidParamsFault(error.message);
      }
      if (isOperationFault(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    }
  },
});

/**
 * Look up the schema the workflow's type declares (the registered definition, which is what a start
 * validates against) and convert the `date-time` strings in `attributes`. A workflow the engine does
 * not hold, a type with no schema, or an `attributes` value that is not an object passes through,
 * leaving the engine to validate or reject it exactly as before.
 */
async function normalizeAttributeDates(
  engine: Pick<Engine, 'get' | 'getWorkflowDefinition'>,
  workflowId: string,
  attributes: unknown,
): Promise<unknown> {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return attributes;
  }
  const state = await engine.get(workflowId);
  if (state === null) return attributes;
  return normalizeDateTimeSearchAttributes(
    attributes as Record<string, unknown>,
    'Field "attributes"',
    engine.getWorkflowDefinition(state.type)?.searchAttributes,
  );
}

export const setWorkflowAttributesRestBinding: UnknownRestBinding = {
  method: 'PATCH',
  path: '/v1/workflows/:id/attributes',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.attributes.set',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    attributes: { kind: 'body-field', bodyField: 'attributes' },
  },
  extractInput: async (request, pathParams, context) => {
    const body = await readRestJsonBody(request, context).catch((error) => {
      if (isOperationFault(error)) throw error;
      throw new Error('Invalid JSON body');
    });

    if (body === null) {
      throw new Error('Invalid JSON body');
    }

    return {
      workflowId: pathParams['id'] ?? '',
      attributes:
        typeof body === 'object' ? (body as Record<string, unknown>)['attributes'] : undefined,
    };
  },
  success: { kind: 'json', status: 200 },
};
