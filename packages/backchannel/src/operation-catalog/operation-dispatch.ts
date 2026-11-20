import type { OperationHostFactory } from './operation-interceptors.ts';
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
  OperationKind,
  OperationMetadata,
} from './types.ts';

type DispatchableOperation<Host> = {
  readonly rawInput: unknown;
  readonly context: DispatchContext<Host>;
};

type InvokableOperation<Input, SchemaOutput, Host> = OperationMetadata<
  Input,
  SchemaOutput,
  Host
> & {
  readonly kind?: OperationKind;
  readonly invoke: (context: OperationContext<Input, Host>) => Promise<unknown>;
};

/** Run the common pipeline before any unary, stream, or subscription invocation. */
export async function dispatchOperation<Input, SchemaOutput, Host>(
  operation: InvokableOperation<Input, SchemaOutput, Host>,
  { rawInput, context }: DispatchableOperation<Host>,
): Promise<DispatchResult<unknown>> {
  const prepared = await prepareTypedInput(operation, rawInput, context);
  if (!prepared.ok) return prepared;
  const operationContext = prepared.value;
  try {
    const invoke = async (): Promise<DispatchResult<unknown>> => {
      const value = await operation.invoke(operationContext);
      tracePipeline(context.pipelineTrace, 'invoked');
      return { ok: true, value };
    };
    if (context.interceptors === undefined || context.interceptors.length === 0)
      return await invoke();

    const { kind, summary, tags, destructive, access } = operation;
    const { input, principal, transport, signal } = operationContext;
    const interception = {
      name: operation.name,
      metadata: { ...(kind === undefined ? {} : { kind }), summary, tags, destructive, access },
      input,
      principal,
      transport,
      ...(signal === undefined ? {} : { signal }),
    };
    const chain = context.interceptors.reduceRight<typeof invoke>((next, interceptor) => {
      let called: ReturnType<typeof invoke> | undefined;
      return () => interceptor(interception, () => (called ??= next()));
    }, invoke);
    return await chain();
  } catch (error) {
    return { ok: false, fault: classifyEngineError(error, operation, context.faultPolicy) };
  }
}

async function prepareTypedInput<Input, SchemaOutput, Host>(
  operation: OperationMetadata<Input, SchemaOutput, Host>,
  rawInput: unknown,
  context: DispatchContext<Host>,
): Promise<DispatchResult<OperationContext<Input, Host>>> {
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

  const { principal, transport, signal } = context;
  const source = context.host;
  let host: Host;
  try {
    host =
      typeof source === 'function'
        ? await (source as OperationHostFactory<Host>)({ principal, transport })
        : source;
  } catch {
    return { ok: false, fault: { code: 'EngineFailure', message: 'internal error', data: {} } };
  }
  const invocation = {
    input: parseOutcome.input,
    principal,
    host,
    transport,
    ...(signal === undefined ? {} : { signal }),
  };
  const authorizationFailure = await checkAuthorization(operation, invocation);
  if (authorizationFailure !== null) return authorizationFailure;
  tracePipeline(context.pipelineTrace, 'authorized');
  return { ok: true, value: invocation };
}
