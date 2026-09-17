import { isToolError } from './core/errors';
import { policyAuthorizationOnlySymbol } from './internal/approval-resume';
import type { ToolExecuteOptions } from './is-tool';
import type { InternalToolExecuteOptionsWithMirror } from './toolbox-contracts';
import { admitToolCall, createDeadlineResult } from './toolbox-execution-admission';
import { processPendingApproval } from './toolbox-execution-approval';
import { bindPendingApproval } from './toolbox-execution-approval-binding';
import { createChildExecution } from './toolbox-execution-child';
import { subscribeToolEvents } from './toolbox-execution-events';
import { normalizeToolCall } from './toolbox-execution-helpers';
import { createToolExecuteOptions } from './toolbox-execution-options';
import { settleToolResult } from './toolbox-execution-settlement';
import { isRecord } from './toolbox-policy-primitives';
import type { ToolCall, ToolCallInput, ToolExecutionResult } from './types';

import type { ExecutionTaskContext } from './toolbox-execution-task-contract';

export function createExecutionTask(
  context: ExecutionTaskContext,
  call: ToolCallInput,
): () => Promise<ToolExecutionResult> {
  const {
    runtime,
    executionLifecycle,
    toolsByName,
    getTool,
    resolutionEnabled,
    emit,
    storedConfigurations,
    onDeprecatedToolCalled,
    loopDetectors,
    autoLoopDetector,
    budget,
    budgetStart,
    budgetCalls,
    createEffectiveExecutionContext,
    createToolError,
    createToolboxBudgetExceededToolError,
    isToolAvailable,
    options,
    hasSingleChild,
    nowFunction,
    executionHandle,
    errorMode,
    callIndex,
  } = context;
  return async () => {
    let toolCall = normalizeToolCall(call);
    if (executionHandle.snapshot().abortSource === 'deadline') {
      return createDeadlineResult(toolCall, createToolError);
    }
    const admission = await admitToolCall({
      toolCall,
      toolsByName,
      getTool,
      resolutionEnabled,
      emit,
      isToolAvailable,
      signal: executionHandle.signal,
      deadlineAborted: () => executionHandle.snapshot().abortSource === 'deadline',
      parentContext: options?.parentContext,
      spanLinks: options?.spanLinks,
      storedConfigurations,
      onDeprecatedToolCalled,
      loopDetectors,
      autoLoopDetector,
      budget,
      budgetStart,
      budgetCalls,
      runtime,
      errorMode,
      policyAuthorizationOnly: options[policyAuthorizationOnlySymbol] === true,
      createToolError,
      createBudgetError: createToolboxBudgetExceededToolError,
    });
    if (!('tool' in admission)) return admission;
    const { tool } = admission;
    toolCall = admission.toolCall;

    const initialEffectiveContext = options?.requestContext
      ? createEffectiveExecutionContext(options.requestContext, tool.id)
      : undefined;
    const child = createChildExecution({
      executionLifecycle,
      options,
      hasSingleChild,
      nowFunction,
      executionHandle,
      callIndex,
      tool,
      toolCall,
      initialEffectiveContext,
    });
    const { cleanup, childExecutionId } = child;
    subscribeToolEvents(tool, childExecutionId, toolCall, emit, cleanup);

    return runToolInvocation(context, tool, toolCall, child, initialEffectiveContext);
  };
}

async function runToolInvocation(
  context: ExecutionTaskContext,
  tool: import('./is-tool').Tool,
  toolCall: ToolCall,
  child: import('./toolbox-execution-child').ChildExecution,
  initialEffectiveContext: import('./execution-context').EffectiveToolExecutionContext | undefined,
): Promise<ToolExecutionResult> {
  const {
    runtime,
    baseContext,
    emit,
    approvalSecret,
    approvalStateStore,
    approvalNow,
    approvalBindingTtlMs,
    approvalNonce,
    toolboxRevision,
    policyRevision,
    approvalRevision,
    createInterruptedResumeApprovalValidationResult,
    options,
    hasSingleChild,
    executionHandle,
    errorMode,
    callIndex,
    suppliedOwnerId,
    setChildCallbackPending,
    incrementLiveStreams,
    finalizeParentStream,
  } = context;
  const {
    cleanup,
    childExecutionHandle,
    privilegedContextMirrorHandle,
    childExecutionId,
    settleChildExecution,
  } = child;
  try {
    const durableOperationKey = resolveDurableOperationKey(options, toolCall, callIndex);
    const resolvedTraceContext =
      options?.traceContext !== undefined ? options.traceContext : baseContext['traceContext'];
    const resolvedExecutionContext = resolveExecutionContext(options, baseContext);
    const executeOptions: InternalToolExecuteOptionsWithMirror = createToolExecuteOptions({
      options,
      suppliedOwnerId,
      durableOperationKey,
      resolvedTraceContext,
      resolvedExecutionContext,
      parentExecutionId: executionHandle.id,
      privilegedContextMirrorHandle,
      requestContext: options?.requestContext,
      initialEffectiveContext,
      hasSingleChild,
      executionHandle,
      onParentCompletionPending: (pending) => {
        setChildCallbackPending(pending);
      },
    });

    const { durableOperationKey: _durableOperationKey, ...baseInvocationOptions } = executeOptions;
    const invocationOptions: ToolExecuteOptions =
      durableOperationKey === undefined
        ? { ...baseInvocationOptions, executionId: childExecutionId }
        : { ...baseInvocationOptions, durableOperationKey, executionId: childExecutionId };
    const result = await tool.execute(toolCall, invocationOptions);
    bindPendingApproval({
      result,
      tool,
      options,
      approvalSecret,
      approvalStateStore,
      approvalNow,
      approvalBindingTtlMs,
      approvalNonce,
      toolboxRevision,
      policyRevision,
      approvalRevision,
    });
    const interruptedApproval = await processPendingApproval({
      result,
      executeOptions,
      approvalSecret,
      approvalStateStore,
      runtime,
      interruptedResult: createInterruptedResumeApprovalValidationResult,
    });
    if (interruptedApproval) return interruptedApproval;
    settleToolResult({
      result,
      tool,
      call: toolCall,
      executionId: childExecutionId,
      ownerId: suppliedOwnerId,
      executionHandle,
      childExecutionHandle,
      cleanup,
      settleChildExecution,
      finalizeParentStream,
      onLiveStream: () => {
        incrementLiveStreams();
      },
      emit,
      failFast: errorMode === 'failFast',
    });
    return result;
  } catch (error) {
    return handleInvocationError(error, context, tool, toolCall, child);
  }
}

function handleInvocationError(
  error: unknown,
  context: ExecutionTaskContext,
  tool: import('./is-tool').Tool,
  toolCall: ToolCall,
  child: import('./toolbox-execution-child').ChildExecution,
): ToolExecutionResult {
  const { cleanup, childExecutionId, settleChildExecution } = child;
  cleanup.forEach((fn) => fn());
  if (context.errorMode === 'failFast') {
    settleChildExecution(error);
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const toolError = isToolError(error)
    ? error
    : context.createToolError(
        'internal',
        message,
        context.extractErrorCode(error) ?? 'EXECUTION_ERROR',
        false,
      );
  const errResult: ToolExecutionResult = {
    callId: toolCall.id,
    outcome: 'error',
    content: toolError.message,
    toolCallId: toolCall.id,
    toolName: tool.name,
    result: undefined,
    error: toolError,
    errorMessage: toolError.message,
    errorCategory: toolError.category,
  };
  context.emit('error', {
    tool,
    result: errResult,
    executionId: childExecutionId,
    ...(context.suppliedOwnerId !== undefined ? { ownerId: context.suppliedOwnerId } : {}),
  });
  settleChildExecution(errResult);
  return errResult;
}

function resolveExecutionContext(
  options: ExecutionTaskContext['options'],
  baseContext: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (options.executionContext !== undefined) return options.executionContext;
  const value = baseContext['executionContext'];
  return isRecord(value) ? value : undefined;
}

function resolveDurableOperationKey(
  options: ExecutionTaskContext['options'],
  toolCall: ToolCall,
  callIndex: number,
): string | undefined {
  const configured = options.durableOperationKey;
  return typeof configured === 'function' ? configured(toolCall, callIndex) : configured;
}
