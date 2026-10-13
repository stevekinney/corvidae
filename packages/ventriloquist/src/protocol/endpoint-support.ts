import { channelsForMode } from './capabilities.ts';
import type { FailureCode } from './failure-codes.ts';
import { describeFailure } from './failure-table.ts';
import type { Capabilities, OutputChannel } from './messages.ts';
import {
  FRAME_PAYLOAD_BYTES_RANGE,
  MAXIMUM_FRAME_PAYLOAD_BYTES,
  MAXIMUM_QUEUED_OPERATIONS,
  QUEUED_OPERATIONS_RANGE,
} from './protocol-constants.ts';
import type { ProtocolFailure } from './protocol-failure.ts';
import type { SequenceCursor } from './sequence-cursor.ts';
import { encodeUtf8 } from './utf8.ts';

/** A frame ready for the transport, and the sequence number it consumed in its direction. */
export type SentFrame = {
  readonly frame: Uint8Array | string;
  readonly sequence: number;
};

/** The sequence position of each direction of an attachment. */
export type EndpointCursors = {
  readonly inbound: SequenceCursor;
  readonly outbound: SequenceCursor;
};

/** What a host or client knows about the attachment once the handshake has completed. */
export type AttachmentTerms = {
  readonly generation: number;
  readonly capabilities: Capabilities;
  readonly maxFrameBytes: number;
  readonly maxQueuedOperations: number;
};

export type EndpointLimits = {
  readonly maxFrameBytes: number;
  readonly maxQueuedOperations: number;
};

/** Resolve a host's advertised limits, throwing a `RangeError` when one lies outside the budget. */
export function resolveLimits(options: {
  readonly maxFrameBytes?: number;
  readonly maxQueuedOperations?: number;
}): EndpointLimits {
  const maxFrameBytes = options.maxFrameBytes ?? MAXIMUM_FRAME_PAYLOAD_BYTES;
  const maxQueuedOperations = options.maxQueuedOperations ?? MAXIMUM_QUEUED_OPERATIONS;
  if (
    !Number.isInteger(maxFrameBytes) ||
    maxFrameBytes < FRAME_PAYLOAD_BYTES_RANGE.minimum ||
    maxFrameBytes > FRAME_PAYLOAD_BYTES_RANGE.maximum
  ) {
    throw new RangeError(`maxFrameBytes must be an integer from 1 to 262144, got ${maxFrameBytes}`);
  }
  if (
    !Number.isInteger(maxQueuedOperations) ||
    maxQueuedOperations < QUEUED_OPERATIONS_RANGE.minimum ||
    maxQueuedOperations > QUEUED_OPERATIONS_RANGE.maximum
  ) {
    throw new RangeError(
      `maxQueuedOperations must be an integer from 1 to 4096, got ${maxQueuedOperations}`,
    );
  }
  return { maxFrameBytes, maxQueuedOperations };
}

/** Whether `failure` ends the endpoint's inbound side: a revoked generation or a closed transport. */
export function endsAttachment(failure: ProtocolFailure): boolean {
  return (
    describeFailure(failure.code).revokesGeneration ||
    failure.code === 'protocol-version-unsupported'
  );
}

export function channelPermitted(mode: Capabilities['mode'], channel: OutputChannel): boolean {
  return channelsForMode(mode).includes(channel);
}

/** The UTF-8 bytes of a string, or a copy of the bytes it was given. */
export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? encodeUtf8(data) : data.slice();
}

export function isSubmittedOperationFailure(code: FailureCode): boolean {
  return code === 'backend-failed' || code === 'transport-failed';
}
