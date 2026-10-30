import type { ToolErrorCategory } from './core/errors';
import type { ToolRequestContext } from './execution-context';
import type { MinimalAbortSignal, ToolConfiguration, ToolSecretResolver } from './is-tool';

/** The error code of a call that carried or asked for a secret the tool did not declare. */
export const secretNotAcceptedCode = 'secret-not-accepted';

/** The error code of a secret that could not be resolved to plaintext. */
export const secretUnavailableCode = 'secret-unavailable';

/** The two error codes a secret failure carries. */
export type ToolSecretErrorCode = typeof secretNotAcceptedCode | typeof secretUnavailableCode;

/**
 * A reference to a secret held by the host, in place of the secret itself. Anything that records a
 * tool call (events, transcripts, approvals) shows this shape; only a tool that declares
 * `acceptsSecrets` ever sees the plaintext it stands for.
 */
export interface SecretReference {
  /** The host's identifier for the secret, such as `<reviewId>/<field>`. */
  readonly secretRef: string;
}

/**
 * The failure of a secret request. It satisfies the `ToolError` shape, so a tool call that throws
 * one settles with `error.code` set to {@link ToolSecretErrorCode}: `secret-not-accepted` is a
 * `permission` failure and `secret-unavailable` an `unavailable` one. Neither is retryable. The
 * message names the reference and never the secret.
 */
export class ToolSecretError extends Error {
  /** `secret-not-accepted` or `secret-unavailable`. */
  readonly code: ToolSecretErrorCode;
  /** `permission` for `secret-not-accepted`, `unavailable` for `secret-unavailable`. */
  readonly category: ToolErrorCategory;
  /** Always `false`: asking again cannot change the answer. */
  readonly retryable = false;

  constructor(code: ToolSecretErrorCode, message: string) {
    super(message);
    this.code = code;
    this.category = code === secretNotAcceptedCode ? 'permission' : 'unavailable';
  }
}

/**
 * Whether `value` is a {@link SecretReference}: a plain object (prototype `Object.prototype` or
 * `null`) whose only own key is `secretRef` and whose value is a string. An object with any other
 * key, a non-string `secretRef`, or a class instance is ordinary data and is left alone, so a
 * tool whose own parameters happen to include a `secretRef` field next to others is unaffected.
 */
export function isSecretReference(value: unknown): value is SecretReference {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === 1 &&
    keys[0] === 'secretRef' &&
    typeof Reflect.get(value, 'secretRef') === 'string'
  );
}

/** Where a {@link SecretReference} sits in an arguments value, and what it names. */
export interface SecretReferenceLocation {
  /** Property names and array indexes from the root of the arguments to the reference. */
  readonly path: readonly (string | number)[];
  /** The reference's `secretRef` string. */
  readonly reference: string;
}

/**
 * Finds every {@link SecretReference} in `value`, descending through arrays and plain objects at
 * any depth. A reference's own contents are not searched.
 */
export function findSecretReferences(value: unknown): SecretReferenceLocation[] {
  const found: SecretReferenceLocation[] = [];
  const visit = (node: unknown, path: readonly (string | number)[], ancestors: object[]): void => {
    if (isSecretReference(node)) {
      found.push({ path, reference: node.secretRef });
      return;
    }
    if (typeof node !== 'object' || node === null || ancestors.includes(node)) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...path, index], [...ancestors, node]));
    } else if (isPlainObject(node)) {
      for (const [key, item] of Object.entries(node))
        visit(item, [...path, key], [...ancestors, node]);
    }
  };
  visit(value, [], []);
  return found;
}

/**
 * Snapshots the arguments of a call that carries {@link SecretReference} values: a fresh copy that
 * keeps the references, so admission and substitution work from what the caller passed when the
 * call began, not from an object the caller still owns and may edit across an `await`. Returns
 * `undefined` when the arguments hold no reference, which is the common case and costs one read.
 */
export function snapshotSecretBearingArguments(argumentsValue: unknown): unknown {
  return findSecretReferences(argumentsValue).length > 0
    ? replaceSecretReferences(argumentsValue, new Map())
    : undefined;
}

/**
 * Returns a fresh copy of `value` with every {@link SecretReference} replaced by the string
 * `plaintext` maps its `secretRef` to. Arrays and plain objects are copied; `value` is never
 * mutated, so a recorded copy of the call keeps showing the references.
 */
export function replaceSecretReferences(
  value: unknown,
  plaintext: ReadonlyMap<string, string>,
): unknown {
  const copy = (node: unknown, ancestors: object[]): unknown => {
    if (isSecretReference(node))
      return plaintext.get(node.secretRef) ?? { secretRef: node.secretRef };
    if (typeof node !== 'object' || node === null || ancestors.includes(node)) return node;
    if (Array.isArray(node)) return node.map((item) => copy(item, [...ancestors, node]));
    if (!isPlainObject(node)) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, item]) => [key, copy(item, [...ancestors, node])]),
    );
  };
  return copy(value, []);
}

/** Whether a tool's metadata declares `acceptsSecrets: true`. */
export function toolAcceptsSecrets(configuration: Pick<ToolConfiguration, 'metadata'>): boolean {
  return configuration.metadata?.acceptsSecrets === true;
}

/** The secret access of one tool call: its gate, its resolver, and its per-call cache. */
export interface ToolCallSecrets {
  /** Whether the tool declares `acceptsSecrets`. */
  readonly accepts: boolean;
  /**
   * Resolves one reference, once per call. Rejects with `secret-not-accepted` for an undeclared
   * tool, and with `secret-unavailable` when there is no resolver or it throws or returns a
   * non-string.
   */
  resolve(reference: string): Promise<string>;
  /**
   * Returns a fresh copy of `argumentsValue` with every reference replaced by its plaintext.
   * Rejects with the same errors as {@link ToolCallSecrets.resolve}.
   */
  substitute(argumentsValue: unknown): Promise<unknown>;
}

/** What {@link createToolCallSecrets} needs to know about one call. */
export interface ToolCallSecretsInput {
  /** The tool's configuration, read for `metadata.acceptsSecrets`. */
  readonly configuration: Pick<ToolConfiguration, 'metadata'>;
  /** The tool's name. */
  readonly toolName: string;
  /** The call's id. */
  readonly callId?: string;
  /** The toolbox's resolver, when it has one. */
  readonly resolver?: ToolSecretResolver | undefined;
  /** The call's abort signal. */
  readonly signal?: MinimalAbortSignal | undefined;
  /** The call's effective request context, already frozen. */
  readonly requestContext?: Readonly<ToolRequestContext> | undefined;
  /** The call's execution context. */
  readonly executionContext?: Readonly<Record<string, unknown>> | undefined;
}

/** Creates the {@link ToolCallSecrets} for one call. Nothing is shared between calls. */
export function createToolCallSecrets(input: ToolCallSecretsInput): ToolCallSecrets {
  const accepts = toolAcceptsSecrets(input.configuration);
  const resolved = new Map<string, Promise<string>>();
  const resolveOnce = async (reference: string): Promise<string> => {
    if (input.resolver === undefined) throw unavailable(reference);
    try {
      const plaintext = await input.resolver(reference, {
        toolName: input.toolName,
        ...(input.callId !== undefined ? { callId: input.callId } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(input.requestContext !== undefined ? { requestContext: input.requestContext } : {}),
        ...(input.executionContext !== undefined
          ? { executionContext: input.executionContext }
          : {}),
      });
      if (typeof plaintext !== 'string') throw new TypeError('not a string');
      return plaintext;
    } catch {
      // The resolver's own message may describe the secret store; it is not copied.
      throw unavailable(reference);
    }
  };
  const resolve = (reference: string): Promise<string> => {
    if (!accepts) return Promise.reject(notAccepted(input.toolName));
    let pending = resolved.get(reference);
    if (pending === undefined) {
      pending = resolveOnce(reference);
      resolved.set(reference, pending);
    }
    return pending;
  };
  return {
    accepts,
    resolve,
    async substitute(argumentsValue) {
      if (!accepts) throw notAccepted(input.toolName);
      const references = [...new Set(findSecretReferences(argumentsValue).map((r) => r.reference))];
      const entries = await Promise.all(
        references.map(async (reference) => [reference, await resolve(reference)] as const),
      );
      return replaceSecretReferences(argumentsValue, new Map(entries));
    },
  };
}

/** The failure for a call that carried or asked for a secret the tool did not declare. */
export function notAccepted(toolName: string): ToolSecretError {
  return new ToolSecretError(
    secretNotAcceptedCode,
    `Tool "${toolName}" does not accept secrets. Declare acceptsSecrets: true in its metadata.`,
  );
}

function unavailable(reference: string): ToolSecretError {
  return new ToolSecretError(secretUnavailableCode, `Secret "${reference}" is unavailable.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
