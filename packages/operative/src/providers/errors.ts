import type { TokenUsage } from 'conversationalist';

import type { ProviderName } from './types.ts';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Wraps SDK errors from any provider with consistent metadata.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  override readonly cause: unknown;
  readonly statusCode?: number | undefined;
  readonly retryable: boolean;

  constructor(options: {
    provider: ProviderName;
    cause: unknown;
    message?: string | undefined;
    statusCode?: number | undefined;
  }) {
    const statusCode = options.statusCode ?? extractStatusCode(options.cause);
    const message =
      options.message ?? `[provider:${options.provider}] ${extractMessage(options.cause)}`;

    super(message);
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.cause = options.cause;
    if (statusCode !== undefined) {
      this.statusCode = statusCode;
    }
    this.retryable = statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode);
  }
}

/**
 * Returns true when the error is a retryable ProviderError.
 * Designed for use as `retry.shouldRetry` in operative's RetryOptions.
 */
export function shouldRetryProviderError(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

/**
 * Thrown when a streaming provider successfully receives a response but the
 * accumulated tool-call argument JSON cannot be parsed — i.e. the model
 * streamed malformed output, not an API/HTTP failure. Extends `ProviderError`
 * so existing `instanceof ProviderError` checks keep working, but carries
 * enough detail (tool name/id, raw fragment) for callers that want to tell
 * "the provider is down" apart from "the model emitted bad JSON".
 */
export class ToolCallParseError extends ProviderError {
  readonly toolName: string;
  readonly toolCallId: string | undefined;
  readonly rawArguments: string;

  constructor(options: {
    provider: ProviderName;
    toolName: string;
    toolCallId: string | undefined;
    rawArguments: string;
    cause: unknown;
  }) {
    const idLabel = options.toolCallId ?? '(unknown id)';
    super({
      provider: options.provider,
      cause: options.cause,
      message: `[provider:${options.provider}] unparseable tool-call arguments for "${options.toolName}" (${idLabel}): ${extractMessage(options.cause)}`,
    });
    this.name = 'ToolCallParseError';
    this.toolName = options.toolName;
    this.toolCallId = options.toolCallId;
    this.rawArguments = options.rawArguments;
  }
}

/**
 * Structural type guard for `ToolCallParseError`, for use alongside (not instead of)
 * `instanceof`. The structural check also covers errors crossing a separately loaded
 * package copy, where the class identity is different. It checks the same fields the
 * constructor always sets.
 */
export function isToolCallParseError(error: unknown): error is ToolCallParseError {
  if (error instanceof ToolCallParseError) return true;
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as Record<string, unknown>;
  return (
    candidate['name'] === 'ToolCallParseError' &&
    typeof candidate['toolName'] === 'string' &&
    typeof candidate['rawArguments'] === 'string' &&
    typeof candidate['provider'] === 'string'
  );
}

/**
 * Why a provider response broke the adapter's mapping contract: a block, part or stream
 * delta type the mapping table does not list, a media part whose modality the selected
 * backend does not advertise as output, or a stream that ended before a block it opened had
 * stopped (`truncated-stream`: the half block is never finalized into a part).
 */
export type ProviderContractReason =
  'unlisted-block' | 'unadvertised-modality' | 'truncated-stream';

/**
 * Thrown when a provider returns output the adapter has no mapping for. Each built-in
 * adapter maps every block type it can receive to a part, a tool call, usage, metadata or
 * control; anything else would otherwise vanish silently, so it fails loudly instead.
 *
 * It is never retryable: the same request would produce the same block. `usage` is the
 * billed usage of the response that carried the block, so the loop can account for it. A
 * streaming adapter throws it after the stream has drained, with the usage the stream
 * reported.
 */
export class ProviderContractError extends ProviderError {
  readonly reason: ProviderContractReason;
  readonly blockType: string;
  /** The block's position in the provider's own sequence; an unlisted block never becomes a part. */
  readonly partIndex: number;
  readonly usage: TokenUsage | undefined;

  constructor(options: {
    provider: ProviderName;
    reason: ProviderContractReason;
    blockType: string;
    partIndex: number;
    usage: TokenUsage | undefined;
  }) {
    const what =
      options.reason === 'unadvertised-modality'
        ? `a ${options.blockType} part the selected backend does not advertise as output`
        : options.reason === 'truncated-stream'
          ? `a "${options.blockType}" block the stream ended before finishing`
          : `an unmapped block "${options.blockType}"`;
    super({
      provider: options.provider,
      cause: undefined,
      message: `[provider:${options.provider}] response part ${options.partIndex} is ${what}.`,
    });
    this.name = 'ProviderContractError';
    this.reason = options.reason;
    this.blockType = options.blockType;
    this.partIndex = options.partIndex;
    this.usage = options.usage;
  }
}

/** Structural guard for {@link ProviderContractError}, for a copy loaded from another package instance. */
export function isProviderContractError(error: unknown): error is ProviderContractError {
  if (error instanceof ProviderContractError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    candidate['name'] === 'ProviderContractError' &&
    typeof candidate['blockType'] === 'string' &&
    typeof candidate['partIndex'] === 'number' &&
    typeof candidate['provider'] === 'string'
  );
}

/**
 * Extracts an HTTP status code from an arbitrary SDK error shape, checking `status`, `statusCode`,
 * and a nested `error.status` (the shape some SDKs use). Returns `undefined` when no code is found.
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  if ('status' in error && typeof error.status === 'number') {
    return error.status;
  }

  if ('statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }

  if (
    'error' in error &&
    error.error &&
    typeof error.error === 'object' &&
    'status' in error.error &&
    typeof error.error.status === 'number'
  ) {
    return error.error.status;
  }

  return undefined;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}
