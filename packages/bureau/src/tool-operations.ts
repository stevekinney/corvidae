import { defineOperation, type Principal } from '@lostgradient/backchannel';
import { projectedInputSchema } from '@lostgradient/backchannel-armorer';
import { createAgent, stopWhen } from '@lostgradient/operative';
import {
  assertJsonValue,
  hasSignedApprovalState,
  toolboxProjectionInterruption,
  verifyToolboxPendingApproval,
  type ApprovalStateStore,
  type AnyToolbox,
  type ToolRequestContext,
  type ToolCallInput,
  type ToolboxExecuteOptions,
  type ToolExecutionResult,
} from 'armorer';
import { z } from 'zod';
import type { BureauHandlerHost } from './http/create-bureau-handler.ts';
import { ownerOfPrincipal } from './http/owner-predicate.ts';
import type { PendingToolApprovalReview, ReviewPolicy } from './bureau-types/reviews.ts';
import { reviewedToolOrigin } from './task-origin.ts';
import { withToolboxLayer } from './toolbox-additions.ts';
const reviewedLayerMarker = Symbol('reviewed-tool-layer');

/** Domain-owned durable intents. Admission must be idempotent for a run and command. */
export interface ReviewedToolIntents {
  prepare(input: {
    runId: string;
    commandId: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  readRun(input: { runId: string; principal: Principal }): Promise<unknown>;
  read(input: { identifier: string; principal: Principal }): Promise<unknown>;
  effect(review: PendingToolApprovalReview): Promise<unknown>;
}

export interface ReviewedToolSelection {
  readonly tool: string;
  readonly agent: string;
  readonly request: string;
  readonly get: string;
  readonly intentId: string;
  readonly outputSchema: z.ZodObject;
  readonly effectSchema: z.ZodObject;
  readonly intents: ReviewedToolIntents;
  readonly access: {
    readonly requestScopes: readonly [string, ...string[]];
    readonly readScopes: readonly [string, ...string[]];
    readonly mayRead: (
      review: PendingToolApprovalReview,
      principal: Principal,
    ) => boolean | Promise<boolean>;
    readonly mayDecide: (
      review: PendingToolApprovalReview,
      principal: Principal,
    ) => boolean | Promise<boolean>;
  };
  readonly mcpExposable: boolean;
}

/** Select pinned tools and retain their toolbox as the one that resumes each signed call. */
export function reviewedToolOperations(
  toolbox: AnyToolbox,
  selections: readonly ReviewedToolSelection[],
  options: {
    readonly approvalStateStore: ApprovalStateStore;
    readonly requestContext: (principal: Principal) => ToolRequestContext;
  },
) {
  if (!hasSignedApprovalState(toolbox, options.approvalStateStore))
    throw new Error('Reviewed tools require the original signed, state-backed toolbox');
  const names = new Set<string>();
  const agents: Record<string, ReturnType<typeof createAgent>> = Object.create(null);
  const operations = [];
  const selected = new Map<
    string,
    { selection: ReviewedToolSelection; publicSchema: z.ZodObject; toolName: string }
  >();
  const toolIds = new Set<string>();
  for (const selection of selections) {
    if (toolIds.has(selection.tool)) throw new Error(`Duplicate reviewed tool: ${selection.tool}`);
    toolIds.add(selection.tool);
    for (const name of [selection.agent, selection.request, selection.get]) {
      if (!name || names.has(name))
        throw new Error(`Duplicate or empty reviewed selection name: ${name}`);
      names.add(name);
    }
    const tool = toolbox.getTool(selection.tool);
    if (!tool || tool.id !== selection.tool || !tool.identity.version)
      throw new Error(`Reviewed selection requires an exact pinned tool: ${selection.tool}`);
    const interruption = toolboxProjectionInterruption(toolbox, tool.id);
    if (interruption !== 'policy' && interruption !== 'approval')
      throw new Error(
        `Reviewed selection has unsupported interruption behavior: ${String(interruption)}`,
      );
    const input = projectedInputSchema(
      tool.configuration.input,
      tool.configuration.inputJsonSchema,
      selection.request,
    );
    if (!Object.hasOwn(input.shape, selection.intentId) || Object.hasOwn(input.shape, 'commandId'))
      throw new Error(
        'Reviewed tool input must contain its server-owned identifier and no commandId',
      );
    const publicShape = Object.fromEntries(
      Object.entries(input.shape).filter(([key]) => key !== selection.intentId),
    );
    const publicSchema = z.strictObject(publicShape);
    const requestSchema = publicSchema.extend({ commandId: z.string().min(1).max(200) });
    const readSchema = z.strictObject({ [selection.intentId]: z.string().min(1) });
    const commandInput = requestSchema;
    const toolId = tool.id;
    const agentName = `reviewed:${selection.agent}`;
    const publicOutput = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid reviewed output');
      return selection.outputSchema.parse(
        Object.fromEntries(
          Object.entries(value).filter(([key]) => Object.hasOwn(selection.outputSchema.shape, key)),
        ),
      );
    };
    selected.set(agentName, { selection, publicSchema, toolName: tool.name });
    const reviewedToolbox = withToolboxLayer(toolbox, (inner) => {
      const publicResult = (result: ToolExecutionResult): ToolExecutionResult => {
        if (result.outcome === 'action_required') {
          if (!result.pendingApproval || result.pendingApproval.action.type !== 'approval')
            throw new Error('Reviewed tool requires an unsupported interruption');
          const {
            action: _action,
            error: _error,
            errorMessage: _errorMessage,
            result: _result,
            ...privateApproval
          } = result;
          return { ...privateApproval, result: undefined, content: 'Approval required' };
        }
        if (result.outcome === 'success') {
          if (result.stream || result.parts)
            throw new Error('Reviewed tool returned an unsupported result');
          const output = publicOutput(result.result);
          assertJsonValue(output);
          const { parts: _parts, stream: _stream, ...rest } = result;
          return { ...rest, result: output, content: output };
        }
        const {
          error: _error,
          errorMessage: _errorMessage,
          action: _action,
          result: _result,
          parts: _parts,
          stream: _stream,
          ...rest
        } = result;
        return { ...rest, result: undefined, content: 'Reviewed tool execution failed' };
      };
      const execute = (async (
        call: ToolCallInput | ToolCallInput[],
        executeOptions?: ToolboxExecuteOptions,
      ) => {
        const isBatch = Array.isArray(call);
        if (isBatch && call.length !== 1) throw new Error('Reviewed calls cannot be batched');
        const selectedCall = isBatch ? call[0]! : call;
        const resolved = inner.resolveTool(selectedCall.name);
        if (!resolved.ok || resolved.tool.id !== toolId)
          throw new Error('Unexpected reviewed tool call');
        const runId = executeOptions?.requestContext?.runId;
        if (!runId) throw new Error('Reviewed tool admission requires a durable run');
        const command = commandInput.parse(selectedCall.arguments) as {
          commandId: string;
        } & Record<string, unknown>;
        const { commandId, ...arguments_ } = command;
        let args: Record<string, unknown>;
        try {
          args = await selection.intents.prepare({ runId, commandId, arguments: arguments_ });
          input.parse(args);
        } catch {
          throw new Error('Reviewed intent could not be prepared');
        }
        if (toolbox.getTool(toolId) !== tool) throw new Error('Selected tool changed');
        const safe = publicResult(
          await inner.execute({ ...selectedCall, arguments: args }, executeOptions),
        );
        return isBatch ? [safe] : safe;
      }) as AnyToolbox['execute'];
      return new Proxy(inner, {
        get(target, property, receiver) {
          if (property === reviewedLayerMarker) return true;
          // Armorer's lifecycle events contain the original private arguments and
          // policy results. They must never enter Operative's generic event feeds.
          if (property === 'addEventListener') return () => () => {};
          if (property === 'toObservable')
            return () => ({
              subscribe: () => ({ closed: true, unsubscribe() {} }),
            });
          if (property === 'resumeApproval')
            return async (...args: Parameters<AnyToolbox['resumeApproval']>) =>
              publicResult(await target.resumeApproval(...args));
          return property === 'execute' ? execute : Reflect.get(target, property, receiver);
        },
      });
    });
    agents[agentName] = createAgent({
      toolbox: reviewedToolbox,
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      generate: async ({ conversation, runId, toolbox: effectiveToolbox }) => {
        if (!Reflect.get(effectiveToolbox, reviewedLayerMarker))
          throw new Error('Reviewed tool layer missing at generation');
        if (conversation.getMessages().some((message) => message.role === 'tool-result'))
          return { content: '', toolCalls: [] };
        if (!runId) throw new Error('Reviewed tool admission requires a durable run');
        const message = conversation.getMessages().findLast((entry) => entry.role === 'user');
        if (typeof message?.content !== 'string') throw new Error('Missing reviewed command');
        const command = commandInput.parse(JSON.parse(message.content));
        return {
          content: '',
          toolCalls: [{ id: 'reviewed-call', name: toolId, arguments: command }],
        };
      },
    });
    const common = {
      mcpExposable: selection.mcpExposable,
      destructive: tool.configuration.metadata?.dangerous === true,
      tags: [toolId],
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' } as const,
    };
    operations.push(
      defineOperation({
        ...common,
        name: selection.request,
        summary: tool.description,
        behavior: { kind: 'command' },
        inputSchema: requestSchema,
        outputSchema: selection.outputSchema,
        access: {
          kind: 'scoped',
          scopes: { kind: 'allOf', scopes: selection.access.requestScopes },
        },
        invoke: async ({
          input: command,
          host,
          principal,
        }: {
          input: z.infer<typeof requestSchema>;
          host: BureauHandlerHost;
          principal: Principal;
        }) => {
          const owner = ownerOfPrincipal(principal);
          if (!owner)
            throw { code: 'Forbidden', message: 'Caller cannot own a reviewed request', data: {} };
          const task = await host.reviewedTasks.start(agentName, JSON.stringify(command), {
            principal: owner,
            commandId: command['commandId'] as string,
            requestContext: options.requestContext(principal),
            origin: reviewedToolOrigin({
              agent: agentName,
              tool: toolId,
              step: 0,
              result: 0,
              callId: 'reviewed-call',
            }),
          });
          const outcome = await task.result();
          const toolResult = outcome.steps[0]?.results[0];
          if (
            outcome.error ||
            !toolResult ||
            (toolResult.outcome !== 'success' && toolResult.outcome !== 'action_required')
          )
            throw { code: 'EngineFailure', message: 'Reviewed tool was not admitted', data: {} };
          return publicOutput(await selection.intents.readRun({ runId: task.id, principal }));
        },
      }),
    );
    operations.push(
      defineOperation({
        ...common,
        name: selection.get,
        summary: `Read ${tool.description}`,
        behavior: { kind: 'read' },
        inputSchema: readSchema,
        outputSchema: selection.outputSchema,
        access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: selection.access.readScopes } },
        invoke: async ({ input: record, principal }) => {
          const identifier = Object.entries(record).find(
            ([key]) => key === selection.intentId,
          )?.[1];
          if (typeof identifier !== 'string') throw new Error('Missing reviewed identifier');
          return publicOutput(await selection.intents.read({ identifier, principal }));
        },
      }),
    );
  }
  const find = (review: PendingToolApprovalReview) => {
    try {
      const verified = verifyToolboxPendingApproval(toolbox, review.approval);
      const binding = verified.approvalBinding;
      if (!binding || binding.runId !== review.runId) return undefined;
      const entry = selected.get(binding.agentId);
      return entry?.selection.tool === binding.toolDefinitionRevision ? entry : undefined;
    } catch {
      return undefined;
    }
  };
  const reviewPolicy: ReviewPolicy = {
    matches: (review) => review.kind === 'tool-approval' && find(review) !== undefined,
    mayRead: (review, principal) =>
      review.kind === 'tool-approval' &&
      (find(review)?.selection.access.mayRead(review, principal) ?? false),
    mayDecide: (review, principal) =>
      review.kind === 'tool-approval' &&
      (find(review)?.selection.access.mayDecide(review, principal) ?? false),
    verifyReviewed: (review, original, provenance) => {
      try {
        const current = verifyToolboxPendingApproval(toolbox, review.approval);
        const committed = verifyToolboxPendingApproval(toolbox, original);
        const binding = current.approvalBinding;
        const firstBinding = committed.approvalBinding;
        return (
          selected.has(provenance.agent) &&
          selected.get(provenance.agent)?.selection.tool === provenance.tool &&
          binding?.agentId === provenance.agent &&
          binding.runId === review.runId &&
          binding.toolDefinitionRevision === provenance.tool &&
          firstBinding?.agentId === provenance.agent &&
          firstBinding.runId === review.runId &&
          firstBinding.toolDefinitionRevision === provenance.tool &&
          committed.callId === provenance.callId &&
          current.callId === provenance.callId &&
          JSON.stringify(committed.arguments) === JSON.stringify(current.arguments)
        );
      } catch {
        return false;
      }
    },
    publicArguments: (review) => {
      const entry = find(review);
      if (!entry) throw new Error('Unknown reviewed tool');
      const args = review.approval.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Invalid reviewed arguments');
      return entry.publicSchema.parse(
        Object.fromEntries(
          Object.entries(args).filter(([key]) => Object.hasOwn(entry.publicSchema.shape, key)),
        ),
      );
    },
    effect: async (review) => {
      if (review.kind !== 'tool-approval') return undefined;
      const entry = find(review);
      if (!entry) return undefined;
      return entry.selection.effectSchema.parse(await entry.selection.intents.effect(review)) as {
        kind: string;
      } & Record<string, unknown>;
    },
  };
  return {
    agents,
    operations,
    reviewPolicy,
    reviewEffects: selections.map((selection) => selection.effectSchema),
  };
}
