import type { z } from 'zod';
import type { RpcContract } from './rpc-contract';

export type RpcValidationFailure = {
  direction: 'input' | 'output';
  issues: readonly z.core.$ZodIssue[];
  /** The contract request that failed. Never contains payload values. */
  request: string;
};

export type RpcValidationReporter = (failure: RpcValidationFailure) => void;

const validationError = (
  request: string,
  direction: 'input' | 'output',
  issues: readonly z.core.$ZodIssue[],
  reportValidationFailure?: RpcValidationReporter,
) => {
  reportValidationFailure?.({ direction, issues, request });
  return new Error(`Invalid RPC ${direction} for "${request}"`);
};

export type ValidatedHandlers<T extends RpcContract> = {
  [K in keyof T['requests']]: (
    params: z.input<T['requests'][K]['input']>,
  ) => Promise<z.output<T['requests'][K]['output']>>;
};

export type RequestImplementations<T extends RpcContract> = {
  [K in keyof T['requests']]: (
    params: z.output<T['requests'][K]['input']>,
  ) => z.input<T['requests'][K]['output']> | Promise<z.input<T['requests'][K]['output']>>;
};

export type MessageImplementations<T extends RpcContract> = {
  [K in keyof NonNullable<T['messages']>]: (
    payload: z.output<NonNullable<T['messages']>[K]>,
  ) => void | Promise<void>;
};

export const createValidatedMessageHandlers = <T extends RpcContract>(
  contract: T,
  handlers: MessageImplementations<T>,
  reportValidationFailure?: RpcValidationReporter,
): Partial<MessageImplementations<T>> => {
  const result: Record<string, (payload: unknown) => Promise<void>> = {};
  for (const [untypedName, schema] of Object.entries(contract.messages ?? {})) {
    // Object.entries erases the literal key; restore it at this registry boundary.
    const name = untypedName as keyof NonNullable<T['messages']>;
    result[untypedName] = async (payload: unknown) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        reportValidationFailure?.({
          direction: 'input',
          issues: parsed.error.issues,
          request: untypedName,
        });
        return;
      }
      const handler = handlers[name];
      await handler(parsed.data as never);
    };
  }
  return result as Partial<MessageImplementations<T>>;
};

export type ValidatedHandlerOptions<T extends RpcContract> = {
  /**
   * Request names to register. Anything omitted is never registered, so a
   * caller reaches a missing handler rather than a permission check that a
   * renderer could be trusted to respect. Defaults to the whole contract.
   */
  allowedRequests?: readonly Extract<keyof T['requests'], string>[];
  reportValidationFailure?: RpcValidationReporter;
};

export const createValidatedRequestHandlers = <T extends RpcContract>(
  contract: T,
  handlers: RequestImplementations<T>,
  { allowedRequests, reportValidationFailure }: ValidatedHandlerOptions<T> = {},
): Partial<ValidatedHandlers<T>> => {
  const allowed = allowedRequests === undefined ? undefined : new Set<string>(allowedRequests);
  const result: Partial<ValidatedHandlers<T>> = {};

  for (const [untypedName, definition] of Object.entries(contract.requests)) {
    if (allowed !== undefined && !allowed.has(untypedName)) continue;

    const name = untypedName as Extract<keyof T['requests'], string>;
    result[name] = (async (params: unknown) => {
      const parsedInput = definition.input.safeParse(params);
      if (!parsedInput.success)
        throw validationError(name, 'input', parsedInput.error.issues, reportValidationFailure);
      /*
       * The handler's declared parameter type is keyed to `name`, which a loop
       * cannot correlate with a literal key. Assert the erased signature here
       * rather than routing through `Reflect.apply`, whose `any` return would
       * launder the same unsoundness without being greppable.
       */
      const handler = handlers[name] as (params: unknown) => unknown;
      const value: unknown = await handler(parsedInput.data);
      const parsedOutput = definition.output.safeParse(value);
      if (!parsedOutput.success) {
        throw validationError(name, 'output', parsedOutput.error.issues, reportValidationFailure);
      }
      return parsedOutput.data;
    }) as ValidatedHandlers<T>[typeof name];
  }
  return result;
};
