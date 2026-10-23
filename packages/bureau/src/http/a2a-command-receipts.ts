/**
 * The command-receipts extension on Bureau's A2A sends (COR-903, part 2b;
 * `packages/weft/documentation/a2a/extensions/command-receipts-v1.md`).
 *
 * A send that activates it may carry `expectedRevision` and `deadline` in its message's
 * extension namespace, and its response `Task` carries the command's receipt and the task's
 * revision. A conflicting reuse of a `messageId` and a stale `expectedRevision` are typed errors
 * (`-32602` with a `bureau` ErrorInfo whose reason is `CONFLICT` or `STALE_REVISION`), and a
 * blocking send its deadline overtakes is `-32603` with reason `TIMEOUT`.
 *
 * @module a2a-command-receipts
 */

import { A2AError, ERROR_INFO_TYPE, RequestMalformedError } from '@a2a-js/sdk/errors';

/** The command-receipts extension's URI. */
export const COMMAND_RECEIPTS_EXTENSION_URI =
  'https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/command-receipts-v1.md';

/** The ErrorInfo domain of a fault A2A has no code of its own for. */
const BUREAU_ERROR_DOMAIN = 'bureau';

/** A receipt state a send can report. */
export type SendReceiptState =
  | 'accepted'
  | 'rejected'
  | 'pending'
  | 'applied'
  | 'observed'
  | 'superseded'
  | 'failed'
  | 'expired';

/** What a send that activated the extension carries in its message's namespace. */
export type CommandReceiptsRequest = {
  readonly expectedRevision: string | undefined;
  /** Epoch milliseconds. */
  readonly deadline: number | undefined;
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether the timestamp parses and names a day that exists, which `Date.parse` rolls over. */
function isRealDate(timestamp: string): boolean {
  // RFC 3339 allows a leap second, which Date.parse refuses: it is judged as the second before.
  if (Number.isNaN(Date.parse(timestamp.replace(/:60(?=[.Z+-])/, ':59')))) return false;
  const [year, month, day] = timestamp.slice(0, 10).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Reads the extension's request namespace, refusing a malformed one with `-32602`. */
export function readCommandReceiptsRequest(
  metadata: Record<string, unknown> | undefined,
): CommandReceiptsRequest {
  const namespace = metadata?.[COMMAND_RECEIPTS_EXTENSION_URI];
  if (namespace === undefined) return { expectedRevision: undefined, deadline: undefined };
  if (typeof namespace !== 'object' || namespace === null || Array.isArray(namespace)) {
    throw new RequestMalformedError('The command-receipts metadata must be an object.');
  }
  const { expectedRevision, deadline, ...rest } = namespace as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new RequestMalformedError(
      `The command-receipts metadata has no field ${Object.keys(rest)
        .map((key) => `'${key}'`)
        .join(', ')}.`,
    );
  }
  if (
    expectedRevision !== undefined &&
    (typeof expectedRevision !== 'string' || expectedRevision === '')
  ) {
    throw new RequestMalformedError('expectedRevision must be a non-empty string.');
  }
  if (
    deadline !== undefined &&
    (typeof deadline !== 'string' || !RFC3339.test(deadline) || !isRealDate(deadline))
  ) {
    throw new RequestMalformedError('deadline must be an RFC 3339 timestamp with an offset.');
  }
  return {
    expectedRevision,
    deadline:
      deadline === undefined ? undefined : Date.parse(deadline.replace(/:60(?=[.Z+-])/, ':59')),
  };
}

/** The receipt namespace a response `Task` carries. */
export function receiptMetadata(
  state: SendReceiptState,
  commandId: string,
  revision: string | undefined,
  reason?: string,
): Record<string, unknown> {
  return {
    receipt: { state, commandId, ...(reason === undefined ? {} : { reason }) },
    ...(revision === undefined ? {} : { revision }),
  };
}

/**
 * A refusal the extension types: `-32602`, so a client that does not know the reason still
 * reads it as a refused request, with a `bureau` ErrorInfo naming the reason.
 */
export class CommandReceiptError extends RequestMalformedError {
  readonly receiptReason: 'CONFLICT' | 'STALE_REVISION';
  readonly details: Record<string, string>;

  constructor(
    reason: 'CONFLICT' | 'STALE_REVISION',
    message: string,
    details: Record<string, string>,
  ) {
    super(message);
    // The SDK maps an error to its JSON-RPC code by name; this one answers as the refusal it is.
    Object.defineProperty(this, 'name', { value: 'RequestMalformedError' });
    this.receiptReason = reason;
    this.details = details;
  }

  override toErrorInfo() {
    return {
      '@type': ERROR_INFO_TYPE,
      reason: this.receiptReason,
      domain: BUREAU_ERROR_DOMAIN,
      metadata: this.details,
    } as unknown as ReturnType<RequestMalformedError['toErrorInfo']>;
  }
}

/** A blocking send its deadline overtook: `-32603` with a `bureau` ErrorInfo, reason `TIMEOUT`. */
export class CommandTimeoutError extends A2AError {
  readonly details: Record<string, string>;

  constructor(message: string, details: Record<string, string>) {
    super(message);
    this.details = details;
  }

  override toErrorInfo() {
    return {
      '@type': ERROR_INFO_TYPE,
      reason: 'TIMEOUT',
      domain: BUREAU_ERROR_DOMAIN,
      metadata: this.details,
    } as unknown as ReturnType<A2AError['toErrorInfo']>;
  }
}
