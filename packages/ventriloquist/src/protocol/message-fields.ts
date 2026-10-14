import { validateCapabilities } from './capabilities.ts';
import type { FailureCode } from './failure-codes.ts';
import { ATTACHMENT_ERROR_CODES, OPERATION_FAILURE_CODES } from './failure-table.ts';
import type { Capabilities, CleanupOutcome, OutputChannel, ProtocolMessage } from './messages.ts';
import {
  FRAME_PAYLOAD_BYTES_RANGE,
  isValidSequence,
  MAXIMUM_TERMINAL_DIMENSION,
  MESSAGE_KIND_DIRECTIONS,
  MINIMUM_TERMINAL_DIMENSION,
  PROTOCOL_VERSION,
  QUEUED_OPERATIONS_RANGE,
  type MessageKind,
} from './protocol-constants.ts';
import {
  accept,
  codeForReason,
  reject,
  type FailureReason,
  type ProtocolResult,
} from './protocol-failure.ts';

/** Marks a field value that failed validation; `undefined` and `null` are both legal values. */
const INVALID = Symbol('invalid');

type FieldReader = {
  readonly read: (value: unknown) => unknown;
  readonly reason: FailureReason;
};

const SESSION_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerWithin(value: unknown, minimum: number, maximum: number): number | typeof INVALID {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : INVALID;
}

function oneOf<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value | typeof INVALID {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as Value)
    : INVALID;
}

function field(reason: FailureReason, read: (value: unknown) => unknown): FieldReader {
  return { reason, read };
}

const version = field('wrong-version', (value) => (value === PROTOCOL_VERSION ? value : INVALID));
const sessionId = field('invalid-session-identifier', (value) =>
  typeof value === 'string' && SESSION_IDENTIFIER.test(value) ? value : INVALID,
);
const generation = field('invalid-generation', (value) =>
  integerWithin(value, 1, Number.MAX_SAFE_INTEGER),
);
const generationOrNone = field('invalid-generation', (value) =>
  integerWithin(value, 0, Number.MAX_SAFE_INTEGER),
);
const sequence = field('invalid-sequence', (value) =>
  typeof value === 'number' && isValidSequence(value) && value >= 1 ? value : INVALID,
);
const sequenceOrNone = field('invalid-sequence', (value) =>
  typeof value === 'number' && isValidSequence(value) ? value : INVALID,
);
const operationSequence = field('invalid-sequence', (value) =>
  typeof value === 'number' && isValidSequence(value) && value >= 1 ? value : INVALID,
);
const byteCount = field('invalid-count', (value) =>
  typeof value === 'number' && isValidSequence(value) ? value : INVALID,
);
const dimension = field('invalid-dimension', (value) =>
  integerWithin(value, MINIMUM_TERMINAL_DIMENSION, MAXIMUM_TERMINAL_DIMENSION),
);
const text = field('invalid-field', (value) => (typeof value === 'string' ? value : INVALID));
const token = field('invalid-field', (value) =>
  typeof value === 'string' && value.length > 0 ? value : INVALID,
);
const requestedMode = field('invalid-field', (value) => oneOf(value, ['read-only', 'interactive']));
const channel = field('invalid-field', (value) =>
  oneOf<OutputChannel>(value, ['pty', 'stdout', 'stderr']),
);
const outcome = field('invalid-field', (value) =>
  oneOf<CleanupOutcome>(value, ['complete', 'incomplete', 'unknown']),
);
const operationFailureCode = field('invalid-field', (value) =>
  oneOf<FailureCode>(value, OPERATION_FAILURE_CODES),
);
const attachmentErrorCode = field('invalid-field', (value) =>
  oneOf<FailureCode>(value, ATTACHMENT_ERROR_CODES),
);
const exitCode = field('invalid-field', (value) =>
  value === null ? null : integerWithin(value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
);
const signal = field('invalid-field', (value) =>
  value === null || (typeof value === 'string' && value.length > 0) ? value : INVALID,
);
const frameLimit = field('invalid-limits', (value) =>
  integerWithin(value, FRAME_PAYLOAD_BYTES_RANGE.minimum, FRAME_PAYLOAD_BYTES_RANGE.maximum),
);
const queueLimit = field('invalid-limits', (value) =>
  integerWithin(value, QUEUED_OPERATIONS_RANGE.minimum, QUEUED_OPERATIONS_RANGE.maximum),
);
/** Copies the bytes: the accepted message must not share memory with the producer or the wire buffer. */
const payload = field('invalid-field', (value) =>
  value instanceof Uint8Array ? value.slice() : INVALID,
);
const capabilities = field('invalid-capabilities', (value) => {
  if (!isRecord(value)) return INVALID;
  const keys = Object.keys(value).toSorted();
  if (keys.join() !== 'input,kill,mode,readOnly,resize') return INVALID;
  const mode = oneOf<Capabilities['mode']>(value['mode'], ['pty', 'pipe', 'output-only']);
  if (
    mode === INVALID ||
    typeof value['input'] !== 'boolean' ||
    typeof value['resize'] !== 'boolean' ||
    typeof value['kill'] !== 'boolean' ||
    typeof value['readOnly'] !== 'boolean'
  ) {
    return INVALID;
  }
  const candidate: Capabilities = {
    mode,
    input: value['input'],
    resize: value['resize'],
    kill: value['kill'],
    readOnly: value['readOnly'],
  };
  return validateCapabilities(candidate) === undefined ? candidate : INVALID;
});

const header = { sessionId, attachmentGeneration: generation, sequence };

/** The exact field set of every message kind, besides `kind` itself. */
const FIELD_READERS: Record<MessageKind, Readonly<Record<string, FieldReader>>> = {
  hello: { version, sessionId, requestedMode, token },
  capabilities: {
    version,
    sessionId,
    attachmentGeneration: generation,
    capabilities,
    maxFrameBytes: frameLimit,
    maxQueuedOperations: queueLimit,
  },
  output: { ...header, channel, payload },
  input: { ...header, payload },
  resize: { ...header, columns: dimension, rows: dimension },
  'operation-ack': { ...header, operationSequence },
  'operation-failure': { ...header, operationSequence, code: operationFailureCode, message: text },
  'output-consumed': { ...header, consumedBytes: byteCount },
  'process-exit': { ...header, exitCode, signal },
  'attachment-error': {
    sessionId,
    attachmentGeneration: generationOrNone,
    sequence: sequenceOrNone,
    code: attachmentErrorCode,
    message: text,
  },
  terminate: header,
  'cleanup-result': { ...header, outcome },
};

/** Whether `kind` names a message kind of the version 1 schema. */
export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === 'string' && Object.hasOwn(MESSAGE_KIND_DIRECTIONS, value);
}

/**
 * Validate `candidate` against the exact field set of its kind and return a fresh message that
 * shares no memory with it. An attachment error sent before any generation was issued carries
 * generation 0 and sequence 0, and only together.
 */
export function normalizeMessage(candidate: unknown): ProtocolResult<ProtocolMessage> {
  if (!isRecord(candidate)) return reject('malformed-frame', 'not-an-object');
  const kind = candidate['kind'];
  if (!isMessageKind(kind)) return reject('malformed-frame', 'unknown-kind');
  const readers = FIELD_READERS[kind];
  const names = Object.keys(readers);
  for (const name of Object.keys(candidate)) {
    if (name !== 'kind' && !Object.hasOwn(readers, name)) {
      return reject('malformed-frame', 'unknown-field');
    }
  }
  const message: Record<string, unknown> = { kind };
  for (const name of names) {
    const reader = readers[name]!;
    const value = Object.hasOwn(candidate, name) ? reader.read(candidate[name]) : INVALID;
    if (value === INVALID) return reject(codeForReason(reader.reason), reader.reason);
    message[name] = value;
  }
  if (
    kind === 'attachment-error' &&
    (message['attachmentGeneration'] === 0) !== (message['sequence'] === 0)
  ) {
    return reject('malformed-frame', 'invalid-sequence');
  }
  return accept(message as ProtocolMessage);
}
