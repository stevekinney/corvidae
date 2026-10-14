/** The only wire version this package speaks. An unknown version fails closed. */
export const PROTOCOL_VERSION = 1;

/** The largest payload one application frame may carry: 64 KiB. */
export const MAXIMUM_FRAME_PAYLOAD_BYTES = 64 * 1024;

/** The size of the bounded host FIFO shared by input and resize operations. */
export const MAXIMUM_QUEUED_OPERATIONS = 256;

/** Sequence numbers are unsigned 53-bit integers, which is `Number.MAX_SAFE_INTEGER`. */
export const MAXIMUM_SEQUENCE = Number.MAX_SAFE_INTEGER;

/** Which side of the connection sends a frame. */
export type MessageDirection = 'client-to-server' | 'server-to-client';

/** Every message kind a version 1 frame can carry, with the side that sends it. */
export const MESSAGE_KIND_DIRECTIONS = {
  hello: 'client-to-server',
  capabilities: 'server-to-client',
  output: 'server-to-client',
  input: 'client-to-server',
  resize: 'client-to-server',
  'operation-ack': 'server-to-client',
  'operation-failure': 'server-to-client',
  'output-consumed': 'client-to-server',
  'process-exit': 'server-to-client',
  'attachment-error': 'server-to-client',
  terminate: 'client-to-server',
  'cleanup-result': 'server-to-client',
} as const satisfies Record<string, MessageDirection>;

export type MessageKind = keyof typeof MESSAGE_KIND_DIRECTIONS;

/** Whether `value` is a sequence number the wire schema allows. */
export function isValidSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_SEQUENCE;
}
