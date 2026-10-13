/**
 * The parent-to-frame protocol between the theme builder and its preview iframe.
 *
 * The iframe is a layout boundary, not a security sandbox: the validation in this
 * module is the boundary. Everything here is pure (no DOM, no globals) so both sides
 * and the tests exercise the same decisions over plain `{ source, origin, data }`
 * envelopes. A message is accepted only when the sender window, the origin, the
 * message shape, the concrete context, and the revision all agree; a stale revision
 * is ignored rather than treated as an error; and a message that is too large, carries
 * too many property records, or names anything but a validated public `--cinder-*`
 * property is rejected with a NAMED error so the receiver keeps its last-valid preview.
 */

export const THEME_PREVIEW_PROTOCOL = 'cinder-theme-preview';
export const THEME_PREVIEW_VERSION = 1;

/** A serialized message above this many bytes is rejected before its shape is read. */
export const MAX_THEME_PREVIEW_MESSAGE_BYTES = 1024 * 1024;
/** A message that carries more property records than this is rejected. */
export const MAX_THEME_PREVIEW_PROPERTY_RECORDS = 2000;
/** A single property value longer than this is rejected. */
export const MAX_THEME_PREVIEW_VALUE_LENGTH = 2048;

export const THEME_PREVIEW_COLOR_MODES = ['light', 'dark'] as const;
export const THEME_PREVIEW_MOTIONS = ['default', 'reduced', 'forced-reduced-motion'] as const;

export type ThemePreviewColorMode = (typeof THEME_PREVIEW_COLOR_MODES)[number];
export type ThemePreviewMotion = (typeof THEME_PREVIEW_MOTIONS)[number];

/** One concrete context: a color mode and a motion mode, never a "system" placeholder. */
export type ThemePreviewContext = {
  colorMode: ThemePreviewColorMode;
  motion: ThemePreviewMotion;
};

/** Every concrete context, in a stable order. */
export const THEME_PREVIEW_CONTEXTS: readonly ThemePreviewContext[] =
  THEME_PREVIEW_COLOR_MODES.flatMap((colorMode) =>
    THEME_PREVIEW_MOTIONS.map((motion) => ({ colorMode, motion })),
  );

export type ThemePreviewProperty = { name: string; value: string };

export const THEME_PREVIEW_MESSAGE_TYPES = {
  apply: 'theme-preview:apply',
  reset: 'theme-preview:reset',
  ready: 'theme-preview:ready',
  applied: 'theme-preview:applied',
  rejected: 'theme-preview:rejected',
} as const;

type Envelope<Type extends string> = {
  protocol: typeof THEME_PREVIEW_PROTOCOL;
  version: typeof THEME_PREVIEW_VERSION;
  type: Type;
};

/** Replace the frame's whole variable map with `properties`, in `context`. */
export type ThemePreviewApplyMessage = Envelope<typeof THEME_PREVIEW_MESSAGE_TYPES.apply> & {
  revision: number;
  context: ThemePreviewContext;
  sceneId: string;
  properties: readonly ThemePreviewProperty[];
};

/** Drop every applied property, keeping only the context and scene. */
export type ThemePreviewResetMessage = Envelope<typeof THEME_PREVIEW_MESSAGE_TYPES.reset> & {
  revision: number;
  context: ThemePreviewContext;
  sceneId: string;
};

export type ThemePreviewParentMessage = ThemePreviewApplyMessage | ThemePreviewResetMessage;

/** The frame booted (or reloaded) and is waiting for its first message. */
export type ThemePreviewReadyMessage = Envelope<typeof THEME_PREVIEW_MESSAGE_TYPES.ready>;

export type ThemePreviewAppliedMessage = Envelope<typeof THEME_PREVIEW_MESSAGE_TYPES.applied> & {
  revision: number;
  context: ThemePreviewContext;
  sceneId: string;
  propertyCount: number;
};

export type ThemePreviewRejectedMessage = Envelope<typeof THEME_PREVIEW_MESSAGE_TYPES.rejected> & {
  revision: number | null;
  code: ThemePreviewErrorCode;
  detail: string;
};

export type ThemePreviewFrameMessage =
  ThemePreviewReadyMessage | ThemePreviewAppliedMessage | ThemePreviewRejectedMessage;

export const THEME_PREVIEW_ERROR_CODES = [
  'wrong-sender',
  'wrong-origin',
  'malformed-message',
  'message-too-large',
  'too-many-properties',
  'duplicate-property',
  'unknown-property',
  'invalid-value',
  'invalid-context',
  'invalid-revision',
  'context-mismatch',
] as const;

export type ThemePreviewErrorCode = (typeof THEME_PREVIEW_ERROR_CODES)[number];

export type ThemePreviewError = { code: ThemePreviewErrorCode; message: string };

export type ThemePreviewValidation<Message> =
  | { status: 'accepted'; message: Message }
  | { status: 'stale'; revision: number }
  | { status: 'rejected'; error: ThemePreviewError };

/** The slice of a `MessageEvent` the validators read. */
export type ThemePreviewEnvelope = { source: unknown; origin: string; data: unknown };

function reject<Message>(
  code: ThemePreviewErrorCode,
  message: string,
): ThemePreviewValidation<Message> {
  return { status: 'rejected', error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializedByteLength(data: unknown): number | null {
  try {
    const serialized = JSON.stringify(data);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

/**
 * Functions that fetch a resource, which a custom property must never carry: the value
 * would reach `url()`-taking properties through `var()` substitution.
 */
const RESOURCE_FUNCTION_PATTERN =
  /(?:^|[^a-z0-9_-])(?:url|image|image-set|-webkit-image-set|cross-fade|-webkit-cross-fade|element|-moz-element|paint|attr|src|expression)\s*\(/i;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
/** Semicolons and braces end a declaration or block; `@` opens an at-rule; `<>`, `!` and `\` have no place. */
const STRUCTURAL_CHARACTER_PATTERN = /[;{}@<>!\\]/;
const COMMENT_PATTERN = /\/\*|\*\//;
const PUBLIC_PROPERTY_NAME_PATTERN = /^--cinder-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (const character of value) {
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** The reason a property value is unsafe, or `null` when it is a plain CSS value. */
export function themePreviewValueProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'value must be a string';
  if (value.trim() === '') return 'value must not be empty';
  if (value.length > MAX_THEME_PREVIEW_VALUE_LENGTH) {
    return `value must be at most ${MAX_THEME_PREVIEW_VALUE_LENGTH} characters`;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) return 'value must not contain control characters';
  if (COMMENT_PATTERN.test(value)) return 'value must not contain comments';
  if (STRUCTURAL_CHARACTER_PATTERN.test(value)) {
    return 'value must not contain escapes, semicolons, braces, at-rules, or angle brackets';
  }
  if (RESOURCE_FUNCTION_PATTERN.test(value)) return 'value must not use a resource function';
  if (!hasBalancedParentheses(value)) return 'value must have balanced parentheses';
  return null;
}

function parseContext(value: unknown): ThemePreviewContext | null {
  if (!isRecord(value)) return null;
  const { colorMode, motion } = value;
  const knownColorMode = THEME_PREVIEW_COLOR_MODES.find((mode) => mode === colorMode);
  const knownMotion = THEME_PREVIEW_MOTIONS.find((mode) => mode === motion);
  if (knownColorMode === undefined || knownMotion === undefined) return null;
  return { colorMode: knownColorMode, motion: knownMotion };
}

export function sameThemePreviewContext(
  left: ThemePreviewContext,
  right: ThemePreviewContext,
): boolean {
  return left.colorMode === right.colorMode && left.motion === right.motion;
}

function parseRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function checkEnvelope(
  envelope: ThemePreviewEnvelope,
  expectedSource: unknown,
  expectedOrigin: string,
): ThemePreviewError | null {
  if (expectedSource == null || envelope.source !== expectedSource) {
    return { code: 'wrong-sender', message: 'message did not come from the expected window' };
  }
  if (envelope.origin !== expectedOrigin) {
    return {
      code: 'wrong-origin',
      message: `message origin ${envelope.origin} is not ${expectedOrigin}`,
    };
  }
  const bytes = serializedByteLength(envelope.data);
  if (bytes === null) {
    return { code: 'malformed-message', message: 'message is not serializable data' };
  }
  if (bytes > MAX_THEME_PREVIEW_MESSAGE_BYTES) {
    return {
      code: 'message-too-large',
      message: `message is ${bytes} bytes; the limit is ${MAX_THEME_PREVIEW_MESSAGE_BYTES}`,
    };
  }
  const data = envelope.data;
  if (
    !isRecord(data) ||
    data['protocol'] !== THEME_PREVIEW_PROTOCOL ||
    data['version'] !== THEME_PREVIEW_VERSION ||
    typeof data['type'] !== 'string'
  ) {
    return { code: 'malformed-message', message: 'message is not a theme preview message' };
  }
  return null;
}

export type ParentMessageOptions = {
  /** The window the message must come from (the builder's own window). */
  expectedSource: unknown;
  expectedOrigin: string;
  /** The highest revision the frame has applied; `-1` for a frame that has applied none. */
  lastRevision: number;
  /** The validated public `--cinder-*` property names. */
  allowedProperties: ReadonlySet<string>;
};

function parseProperties(
  value: unknown,
  allowedProperties: ReadonlySet<string>,
): { properties: ThemePreviewProperty[] } | { error: ThemePreviewError } {
  if (!Array.isArray(value)) {
    return { error: { code: 'malformed-message', message: 'properties must be an array' } };
  }
  if (value.length > MAX_THEME_PREVIEW_PROPERTY_RECORDS) {
    return {
      error: {
        code: 'too-many-properties',
        message: `${value.length} property records exceed the limit of ${MAX_THEME_PREVIEW_PROPERTY_RECORDS}`,
      },
    };
  }
  const seen = new Set<string>();
  const properties: ThemePreviewProperty[] = [];
  for (const record of value as unknown[]) {
    if (!isRecord(record) || typeof record['name'] !== 'string') {
      return { error: { code: 'malformed-message', message: 'property record is malformed' } };
    }
    const name = record['name'];
    if (!PUBLIC_PROPERTY_NAME_PATTERN.test(name) || !allowedProperties.has(name)) {
      return {
        error: { code: 'unknown-property', message: `${name} is not a public Cinder property` },
      };
    }
    if (seen.has(name)) {
      return { error: { code: 'duplicate-property', message: `${name} appears twice` } };
    }
    seen.add(name);
    const problem = themePreviewValueProblem(record['value']);
    if (problem !== null) {
      return { error: { code: 'invalid-value', message: `${name}: ${problem}` } };
    }
    properties.push({ name, value: record['value'] as string });
  }
  return { properties };
}

/** Validate a message the builder sent to the preview frame. */
export function validateParentMessage(
  envelope: ThemePreviewEnvelope,
  options: ParentMessageOptions,
): ThemePreviewValidation<ThemePreviewParentMessage> {
  const envelopeError = checkEnvelope(envelope, options.expectedSource, options.expectedOrigin);
  if (envelopeError !== null) return { status: 'rejected', error: envelopeError };
  const data = envelope.data as Record<string, unknown>;
  const type = data['type'];
  if (type !== THEME_PREVIEW_MESSAGE_TYPES.apply && type !== THEME_PREVIEW_MESSAGE_TYPES.reset) {
    return reject('malformed-message', `unknown message type ${String(type)}`);
  }
  const revision = parseRevision(data['revision']);
  if (revision === null) {
    return reject('invalid-revision', 'revision must be a non-negative integer');
  }
  const context = parseContext(data['context']);
  if (context === null) return reject('invalid-context', 'context is not a concrete context');
  const sceneId = data['sceneId'];
  if (typeof sceneId !== 'string' || sceneId === '' || sceneId.length > 120) {
    return reject('malformed-message', 'sceneId must be a short string');
  }
  if (revision <= options.lastRevision) return { status: 'stale', revision };

  const base = {
    protocol: THEME_PREVIEW_PROTOCOL,
    version: THEME_PREVIEW_VERSION,
    revision,
    context,
    sceneId,
  } as const;
  if (type === THEME_PREVIEW_MESSAGE_TYPES.reset) {
    return { status: 'accepted', message: { ...base, type } };
  }
  const parsed = parseProperties(data['properties'], options.allowedProperties);
  if ('error' in parsed) return { status: 'rejected', error: parsed.error };
  return { status: 'accepted', message: { ...base, type, properties: parsed.properties } };
}

export type FrameMessageOptions = {
  /** The preview iframe's content window. */
  expectedSource: unknown;
  expectedOrigin: string;
  /** The revision of the latest message the builder sent; `null` before it sent any. */
  expectedRevision: number | null;
  /** The context of that message. */
  expectedContext: ThemePreviewContext | null;
};

/** Validate a message the preview frame sent back to the builder. */
export function validateFrameMessage(
  envelope: ThemePreviewEnvelope,
  options: FrameMessageOptions,
): ThemePreviewValidation<ThemePreviewFrameMessage> {
  const envelopeError = checkEnvelope(envelope, options.expectedSource, options.expectedOrigin);
  if (envelopeError !== null) return { status: 'rejected', error: envelopeError };
  const data = envelope.data as Record<string, unknown>;
  const type = data['type'];
  const base = { protocol: THEME_PREVIEW_PROTOCOL, version: THEME_PREVIEW_VERSION } as const;
  if (type === THEME_PREVIEW_MESSAGE_TYPES.ready) {
    return { status: 'accepted', message: { ...base, type } };
  }
  if (
    type !== THEME_PREVIEW_MESSAGE_TYPES.applied &&
    type !== THEME_PREVIEW_MESSAGE_TYPES.rejected
  ) {
    return reject('malformed-message', `unknown message type ${String(type)}`);
  }
  // A rejection that predates any valid revision (for example a malformed message) carries `null`.
  const unrevisioned = type === THEME_PREVIEW_MESSAGE_TYPES.rejected && data['revision'] === null;
  const revision = unrevisioned ? null : parseRevision(data['revision']);
  if (revision === null && !unrevisioned) {
    return reject('invalid-revision', 'revision must be a non-negative integer');
  }
  if (revision !== null) {
    if (options.expectedRevision === null || revision > options.expectedRevision) {
      return reject('invalid-revision', `revision ${revision} was never sent`);
    }
    if (revision < options.expectedRevision) return { status: 'stale', revision };
  }
  if (type === THEME_PREVIEW_MESSAGE_TYPES.rejected) {
    const code = THEME_PREVIEW_ERROR_CODES.find((candidate) => candidate === data['code']);
    if (code === undefined || typeof data['detail'] !== 'string') {
      return reject('malformed-message', 'rejection must name a known error code');
    }
    return {
      status: 'accepted',
      message: { ...base, type, revision, code, detail: data['detail'] },
    };
  }
  const context = parseContext(data['context']);
  if (context === null) return reject('invalid-context', 'context is not a concrete context');
  if (
    options.expectedContext === null ||
    !sameThemePreviewContext(context, options.expectedContext)
  ) {
    return reject('context-mismatch', 'applied context differs from the requested context');
  }
  const { sceneId, propertyCount } = data;
  if (
    revision === null ||
    typeof sceneId !== 'string' ||
    typeof propertyCount !== 'number' ||
    !Number.isSafeInteger(propertyCount) ||
    propertyCount < 0
  ) {
    return reject('malformed-message', 'applied message is malformed');
  }
  return {
    status: 'accepted',
    message: { ...base, type, revision, context, sceneId, propertyCount },
  };
}

/** Build the parent's apply message. */
export function createApplyMessage(input: {
  revision: number;
  context: ThemePreviewContext;
  sceneId: string;
  properties: readonly ThemePreviewProperty[];
}): ThemePreviewApplyMessage {
  return {
    protocol: THEME_PREVIEW_PROTOCOL,
    version: THEME_PREVIEW_VERSION,
    type: THEME_PREVIEW_MESSAGE_TYPES.apply,
    ...input,
  };
}

export function createResetMessage(input: {
  revision: number;
  context: ThemePreviewContext;
  sceneId: string;
}): ThemePreviewResetMessage {
  return {
    protocol: THEME_PREVIEW_PROTOCOL,
    version: THEME_PREVIEW_VERSION,
    type: THEME_PREVIEW_MESSAGE_TYPES.reset,
    ...input,
  };
}

export function createReadyMessage(): ThemePreviewReadyMessage {
  return {
    protocol: THEME_PREVIEW_PROTOCOL,
    version: THEME_PREVIEW_VERSION,
    type: THEME_PREVIEW_MESSAGE_TYPES.ready,
  };
}

export function createAppliedMessage(input: {
  revision: number;
  context: ThemePreviewContext;
  sceneId: string;
  propertyCount: number;
}): ThemePreviewAppliedMessage {
  return {
    protocol: THEME_PREVIEW_PROTOCOL,
    version: THEME_PREVIEW_VERSION,
    type: THEME_PREVIEW_MESSAGE_TYPES.applied,
    ...input,
  };
}

export function createRejectedMessage(input: {
  revision: number | null;
  error: ThemePreviewError;
}): ThemePreviewRejectedMessage {
  return {
    protocol: THEME_PREVIEW_PROTOCOL,
    version: THEME_PREVIEW_VERSION,
    type: THEME_PREVIEW_MESSAGE_TYPES.rejected,
    revision: input.revision,
    code: input.error.code,
    detail: input.error.message,
  };
}
