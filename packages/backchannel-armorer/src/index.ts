import {
  defineOperation,
  type FaultCode,
  type OperationBehavior,
  type OperationFault,
  type Principal,
} from '@lostgradient/backchannel';
import {
  assertJsonValue,
  toolboxProjectionInterruption,
  type Toolbox,
  type ToolError,
  type ToolRequestContext,
} from 'armorer';
import type { z } from 'zod';
import { projectedInputSchema } from './input-schema.ts';

export type ToolboxSelection = {
  readonly tool: string;
  readonly name: string;
  readonly scopes: readonly [string, ...string[]];
  readonly outputSchema: z.ZodType;
  readonly mcpExposable: boolean;
  readonly behavior: OperationBehavior;
  readonly producibleFaults?: readonly FaultCode[];
  readonly fault?: (error: ToolError) => OperationFault;
};

export function operationsFromToolbox(
  toolbox: Pick<Toolbox, 'getTool' | 'execute' | 'toJSON'>,
  selections: readonly ToolboxSelection[],
  options: { readonly requestContext: (principal: Principal) => ToolRequestContext },
) {
  const names = new Set<string>();
  return selections.map((selection) => {
    if (names.has(selection.name)) throw new Error(`duplicate selection "${selection.name}"`);
    names.add(selection.name);
    const tool = toolbox.getTool(selection.tool);
    if (!tool || tool.id !== selection.tool || !tool.identity.version) {
      throw new Error(
        `selection "${selection.name}" requires an exact pinned tool: ${selection.tool}`,
      );
    }
    if (
      !Array.isArray(selection.scopes) ||
      selection.scopes.length === 0 ||
      selection.scopes.some((scope) => typeof scope !== 'string' || scope.length === 0)
    ) {
      throw new Error(`selection "${selection.name}" requires scopes`);
    }
    const metadata = tool.configuration.metadata;
    if (
      (selection.behavior.kind === 'read' && (metadata?.mutates || metadata?.dangerous)) ||
      (selection.behavior.kind === 'command' && metadata?.readOnly)
    ) {
      throw new Error(`selection "${selection.name}" conflicts with tool effects`);
    }
    const toolId = tool.id;
    const interruption = toolboxProjectionInterruption(toolbox, toolId);
    if (interruption)
      throw new Error(
        `selection "${selection.name}" cannot project ${interruption} interruption behavior`,
      );
    const fault = selection.fault;
    const inputSchema = projectedInputSchema(
      tool.configuration.input,
      tool.configuration.inputJsonSchema,
      selection.name,
    );
    return defineOperation({
      name: selection.name,
      summary: tool.description,
      description: tool.description,
      mcpExposable: selection.mcpExposable,
      behavior: selection.behavior,
      destructive: tool.configuration.metadata?.dangerous === true,
      inputSchema,
      outputSchema: selection.outputSchema,
      access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: selection.scopes } },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      ...(selection.producibleFaults === undefined
        ? {}
        : { producibleFaults: selection.producibleFaults }),
      invoke: async ({ input, principal, signal }) => {
        if (toolbox.getTool(toolId) !== tool || toolboxProjectionInterruption(toolbox, toolId)) {
          throw {
            code: 'EngineFailure',
            message: 'Selected tool changed',
            data: {},
          } satisfies OperationFault;
        }
        const result = await toolbox.execute(
          { name: toolId, arguments: input },
          { requestContext: options.requestContext(principal), ...(signal ? { signal } : {}) },
        );
        if (result.outcome !== 'success') {
          if (result.outcome === 'action_required')
            throw {
              code: 'EngineFailure',
              message: 'Tool requires an unsupported interruption',
              data: {},
            } satisfies OperationFault;
          if (result.error && fault) throw fault(result.error);
          throw {
            code: 'EngineFailure',
            message: 'Tool execution failed',
            data: {},
          } satisfies OperationFault;
        }
        if (result.parts || result.stream) {
          throw {
            code: 'EngineFailure',
            message: 'Unsupported tool result',
            data: {},
          } satisfies OperationFault;
        }
        try {
          assertJsonValue(result.result);
        } catch {
          throw {
            code: 'EngineFailure',
            message: 'Unsupported tool result',
            data: {},
          } satisfies OperationFault;
        }
        return result.result;
      },
    });
  });
}
