import { classifyEngineError } from './pipeline-helpers.ts';
import {
  checkAccess,
  checkAuthorization,
  checkTransport,
  parseAndApplyUnknownKeyPolicy,
  tracePipeline,
} from './pipeline-stages.ts';
import type {
  DispatchContext,
  DispatchResult,
  OperationContext,
  OperationMetadata,
  StreamOperationDefinition,
  StreamOperationInvocation,
  SubscriptionOperationDefinition,
  SubscriptionOperationInvocation,
  UnaryOperationDefinition,
} from './types.ts';

type DispatchableOperation<Host> = {
  readonly rawInput: unknown;
  readonly context: DispatchContext<Host>;
};

export async function dispatchUnary<Input, InvokeOutput, SchemaOutput, Host>(
  operation: UnaryOperationDefinition<Input, InvokeOutput, SchemaOutput, Host>,
  { rawInput, context }: DispatchableOperation<Host>,
): Promise<DispatchResult<InvokeOutput>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  try {
    const output = await operation.invoke(operationContext(prepared.value.input, context));
    tracePipeline(context.pipelineTrace, 'invoked');
    return { ok: true, value: output };
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation) };
  }
}

export async function dispatchStream<
  Input,
  InvokeOutput,
  SchemaOutput,
  InvokeElement,
  Element,
  Host,
>(
  operation: StreamOperationDefinition<
    Input,
    InvokeOutput,
    SchemaOutput,
    InvokeElement,
    Element,
    Host
  >,
  { rawInput, context }: DispatchableOperation<Host>,
): Promise<DispatchResult<InvokeOutput | StreamOperationInvocation<InvokeElement>>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  try {
    const output = await operation.invoke(operationContext(prepared.value.input, context));
    tracePipeline(context.pipelineTrace, 'invoked');
    return { ok: true, value: output };
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation) };
  }
}

export async function dispatchSubscription<
  Input,
  InvokeOutput,
  SchemaOutput,
  InvokeElement,
  Element,
  Host,
>(
  operation: SubscriptionOperationDefinition<
    Input,
    InvokeOutput,
    SchemaOutput,
    InvokeElement,
    Element,
    Host
  >,
  { rawInput, context }: DispatchableOperation<Host>,
): Promise<DispatchResult<SubscriptionOperationInvocation<InvokeElement, InvokeOutput>>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  try {
    const output = await operation.invoke(operationContext(prepared.value.input, context));
    tracePipeline(context.pipelineTrace, 'invoked');
    return { ok: true, value: output };
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation) };
  }
}

async function prepareTypedInput<Input, SchemaOutput, Host>(
  operation: OperationMetadata<Input, SchemaOutput, Host>,
  rawInput: unknown,
  context: DispatchContext<Host>,
): Promise<DispatchResult<{ input: Input }>> {
  const transportFailure = checkTransport(operation, context);
  if (transportFailure !== null) return transportFailure;
  tracePipeline(context.pipelineTrace, 'transport-checked');

  const accessFailure = checkAccess(operation, context);
  if (accessFailure !== null) return accessFailure;
  tracePipeline(context.pipelineTrace, 'access-checked');

  const parseOutcome = parseAndApplyUnknownKeyPolicy(
    operation,
    rawInput,
    context.transport === 'http-rest' ? 'http' : 'jsonRpc',
    context.pipelineTrace,
  );
  if (parseOutcome.kind === 'failure') return { ok: false, fault: parseOutcome.fault };

  const authorizationFailure = await checkAuthorization(operation, parseOutcome.input, context);
  if (authorizationFailure !== null) return authorizationFailure;
  tracePipeline(context.pipelineTrace, 'authorized');
  return { ok: true, value: { input: parseOutcome.input } };
}

function operationContext<Input, Host>(
  input: Input,
  context: DispatchContext<Host>,
): OperationContext<Input, Host> {
  return {
    input,
    principal: context.principal,
    host: context.host,
    transport: context.transport,
  };
}
