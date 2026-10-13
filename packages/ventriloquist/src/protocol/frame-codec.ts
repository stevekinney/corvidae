import { isMessageKind, normalizeMessage } from './message-fields.ts';
import type {
  ClientMessage,
  InputMessage,
  OutputChannel,
  OutputMessage,
  ProtocolMessage,
  ServerMessage,
} from './messages.ts';
import {
  BINARY_FRAME_HEADER_BYTES,
  MAXIMUM_FRAME_PAYLOAD_BYTES,
  MESSAGE_KIND_DIRECTIONS,
  PROTOCOL_VERSION,
  type MessageDirection,
  type MessageKind,
} from './protocol-constants.ts';
import {
  accept,
  codeForReason,
  reject,
  type FailureReason,
  type ProtocolResult,
} from './protocol-failure.ts';
import { utf8ByteLength } from './utf8.ts';

/** Which side decodes a frame: the host receives client messages, the client receives server messages. */
export type Receiver = 'host' | 'client';

/** The payload budget a frame is checked against; defaults to the 64 KiB of the version 1 schema. */
export type FrameLimits = { readonly maxFrameBytes?: number };

/** What `decodeFrame` returns for each receiver. */
export type DecodedMessage<Side extends Receiver> = Side extends 'host'
  ? ClientMessage
  : ServerMessage;

const BINARY_KIND_CODES = { output: 1, input: 2 } as const;
const BINARY_KINDS = ['output', 'input'] as const satisfies readonly MessageKind[];
const DIRECTION_CODES: Record<MessageDirection, number> = {
  'client-to-server': 1,
  'server-to-client': 2,
};
const CHANNEL_CODES: Record<OutputChannel, number> = { pty: 1, stdout: 2, stderr: 3 };
const CHANNELS = ['pty', 'stdout', 'stderr'] as const satisfies readonly OutputChannel[];

const UINT32_RANGE = 2 ** 32;
const MAXIMUM_HIGH_WORD = 0x1f_ffff;
const HEX_DIGITS = '0123456789abcdef';

function limitFor(limits: FrameLimits | undefined): number {
  return limits?.maxFrameBytes ?? MAXIMUM_FRAME_PAYLOAD_BYTES;
}

function receivesDirection(receiver: Receiver): MessageDirection {
  return receiver === 'host' ? 'client-to-server' : 'server-to-client';
}

function isBinaryKind(kind: MessageKind): kind is (typeof BINARY_KINDS)[number] {
  return kind === 'output' || kind === 'input';
}

/** Turn the canonical lowercase session identifier into its 16 bytes. */
function writeSessionIdentifier(view: Uint8Array, offset: number, identifier: string): void {
  const digits = identifier.replaceAll('-', '');
  for (let index = 0; index < 16; index += 1) {
    view[offset + index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  }
}

function readSessionIdentifier(view: Uint8Array, offset: number): string {
  let digits = '';
  for (let index = 0; index < 16; index += 1) {
    const byte = view[offset + index] ?? 0;
    digits += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 0x0f]!;
    if (index === 3 || index === 5 || index === 7 || index === 9) digits += '-';
  }
  return digits;
}

function writeUnsigned53(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, Math.floor(value / UINT32_RANGE));
  view.setUint32(offset + 4, value % UINT32_RANGE);
}

function readUnsigned53(view: DataView, offset: number): number | undefined {
  const high = view.getUint32(offset);
  return high > MAXIMUM_HIGH_WORD ? undefined : high * UINT32_RANGE + view.getUint32(offset + 4);
}

/**
 * Encode `message` as one complete application frame. Control messages become a JSON text frame;
 * `input` and `output` become a binary frame whose fixed header (big-endian) carries the version,
 * kind, direction, channel, session identifier, generation, sequence and payload length. The
 * message is validated first and its payload is copied, so a producer that mutates its buffer
 * afterwards cannot change the frame.
 */
export function encodeFrame(
  message: ProtocolMessage,
  limits?: FrameLimits,
): ProtocolResult<Uint8Array | string> {
  const maxFrameBytes = limitFor(limits);
  const candidate: unknown = message;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'payload' in candidate &&
    candidate.payload instanceof Uint8Array &&
    candidate.payload.length > maxFrameBytes
  ) {
    return reject('frame-too-large', 'oversized');
  }
  const normalized = normalizeMessage(candidate);
  if (!normalized.ok) return normalized;
  const normalizedMessage = normalized.value;
  const direction = MESSAGE_KIND_DIRECTIONS[normalizedMessage.kind];
  if (isBinaryKind(normalizedMessage.kind)) {
    return accept(encodeBinary(normalizedMessage as InputMessage | OutputMessage, direction));
  }
  const json = JSON.stringify({ ...normalizedMessage, version: PROTOCOL_VERSION, direction });
  if (json.length > maxFrameBytes && utf8ByteLength(json) > maxFrameBytes) {
    return reject('frame-too-large', 'oversized');
  }
  return accept(json);
}

function encodeBinary(
  message: InputMessage | OutputMessage,
  direction: MessageDirection,
): Uint8Array {
  const frame = new Uint8Array(BINARY_FRAME_HEADER_BYTES + message.payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = PROTOCOL_VERSION;
  frame[1] = BINARY_KIND_CODES[message.kind];
  frame[2] = DIRECTION_CODES[direction];
  frame[3] = message.kind === 'output' ? CHANNEL_CODES[message.channel] : 0;
  writeSessionIdentifier(frame, 4, message.sessionId);
  writeUnsigned53(view, 20, message.attachmentGeneration);
  writeUnsigned53(view, 28, message.sequence);
  view.setUint32(36, message.payload.length);
  frame.set(message.payload, BINARY_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Decode one complete application frame received by `receiver`. Checks run in a fixed order and
 * nothing is built until all of them pass: size, then structure, version, kind, direction, and
 * finally each field. A frame that fails any of them yields a typed failure and never throws.
 * Accepted payloads are copies, so reusing the transport's buffer cannot alter a decoded message.
 */
export function decodeFrame<Side extends Receiver>(
  frame: Uint8Array | string,
  receiver: Side,
  limits?: FrameLimits,
): ProtocolResult<DecodedMessage<Side>> {
  const maxFrameBytes = limitFor(limits);
  const decoded =
    typeof frame === 'string'
      ? decodeText(frame, receiver, maxFrameBytes)
      : decodeBinary(frame, receiver, maxFrameBytes);
  return decoded as ProtocolResult<DecodedMessage<Side>>;
}

function wrongDirection(kind: MessageKind, receiver: Receiver): FailureReason | undefined {
  return MESSAGE_KIND_DIRECTIONS[kind] === receivesDirection(receiver)
    ? undefined
    : 'wrong-direction';
}

function decodeText(
  frame: string,
  receiver: Receiver,
  maxFrameBytes: number,
): ProtocolResult<ProtocolMessage> {
  if (frame.length > maxFrameBytes || utf8ByteLength(frame) > maxFrameBytes) {
    return reject('frame-too-large', 'oversized');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return reject('malformed-frame', 'invalid-json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return reject('malformed-frame', 'not-an-object');
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== PROTOCOL_VERSION) {
    return reject(codeForReason('wrong-version'), 'wrong-version');
  }
  const kind = record['kind'];
  if (!isMessageKind(kind)) return reject('malformed-frame', 'unknown-kind');
  if (isBinaryKind(kind)) return reject('malformed-frame', 'binary-kind-in-text');
  if (record['direction'] !== MESSAGE_KIND_DIRECTIONS[kind]) {
    return reject('malformed-frame', 'direction-mismatch');
  }
  const misdirected = wrongDirection(kind, receiver);
  if (misdirected !== undefined) return reject('malformed-frame', misdirected);
  const { direction: _direction, ...fields } = record;
  if (kind !== 'hello' && kind !== 'capabilities') delete fields['version'];
  return normalizeMessage(fields);
}

function decodeBinary(
  frame: Uint8Array,
  receiver: Receiver,
  maxFrameBytes: number,
): ProtocolResult<ProtocolMessage> {
  if (frame.length > BINARY_FRAME_HEADER_BYTES + maxFrameBytes) {
    return reject('frame-too-large', 'oversized');
  }
  if (frame.length < BINARY_FRAME_HEADER_BYTES) return reject('malformed-frame', 'truncated');
  if (frame[0] !== PROTOCOL_VERSION) return reject('protocol-version-unsupported', 'wrong-version');
  const kind = BINARY_KINDS.find((candidate) => BINARY_KIND_CODES[candidate] === frame[1]);
  if (kind === undefined) return reject('malformed-frame', 'unknown-kind');
  if (frame[2] !== DIRECTION_CODES[MESSAGE_KIND_DIRECTIONS[kind]]) {
    return reject('malformed-frame', 'direction-mismatch');
  }
  const misdirected = wrongDirection(kind, receiver);
  if (misdirected !== undefined) return reject('malformed-frame', misdirected);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const payloadLength = view.getUint32(36);
  if (payloadLength > maxFrameBytes) return reject('frame-too-large', 'oversized');
  if (frame.length < BINARY_FRAME_HEADER_BYTES + payloadLength) {
    return reject('malformed-frame', 'truncated');
  }
  if (frame.length > BINARY_FRAME_HEADER_BYTES + payloadLength) {
    return reject('malformed-frame', 'trailing-bytes');
  }
  const generation = readUnsigned53(view, 20);
  const sequence = readUnsigned53(view, 28);
  const channelCode = frame[3];
  const channel = CHANNELS.find((candidate) => CHANNEL_CODES[candidate] === channelCode);
  if (kind === 'output' ? channel === undefined : channelCode !== 0) {
    return reject('malformed-frame', 'invalid-field');
  }
  return normalizeMessage({
    kind,
    sessionId: readSessionIdentifier(frame, 4),
    attachmentGeneration: generation,
    sequence,
    ...(kind === 'output' ? { channel } : {}),
    payload: frame.subarray(BINARY_FRAME_HEADER_BYTES),
  });
}
