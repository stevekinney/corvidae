/**
 * COR-1631 — validates interactive-surface commands as untrusted content.
 * A surface's author may be the model, so nothing here trusts its input: every
 * shape is closed (an unknown field is an error), every schema must compile,
 * and the content is held to the payload cap.
 */
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import {
  INTERACTIVE_SURFACE_A2UI_VERSION,
  INTERACTIVE_SURFACE_CONTRACT_VERSION,
  INTERACTIVE_SURFACE_MCP_APP_MIME_TYPE,
  type InteractiveSurfaceActionDefinition,
  type InteractiveSurfaceActionIntent,
  type InteractiveSurfaceJsonObject,
  type InteractiveSurfaceJsonValue,
  type InteractiveSurfaceRepresentation,
} from './types';

/** The longest identifier (`commandId`, `taskId`, `surfaceId`, action name) a command may carry. */
const MAX_IDENTIFIER_LENGTH = 256;

/**
 * The cap on an identifier Bureau composes from others: a task id is a session
 * id (up to 256 characters) plus `:<sequence>`, and a review id wraps a task id
 * with its kind and suffix, so neither fits the leaf cap.
 */
export const MAX_COMPOSITE_IDENTIFIER_LENGTH = 1024;

/** The longest text summary a surface may carry. */
const MAX_SUMMARY_LENGTH = 4096;

const ACTION_INTENTS: ReadonlySet<string> = new Set<InteractiveSurfaceActionIntent>([
  'answer',
  'submit',
  'approve',
  'deny',
]);

const MCP_APP_PERMISSIONS: ReadonlySet<string> = new Set([
  'camera',
  'microphone',
  'geolocation',
  'clipboardWrite',
]);

const textEncoder = new TextEncoder();

/** A validation failure, with a message that names the offending field. */
export class InteractiveSurfaceValidationError extends Error {
  /** The rejection reason the failure maps to. */
  readonly reason: 'invalid' | 'payload-too-large';

  constructor(message: string, reason: 'invalid' | 'payload-too-large' = 'invalid') {
    super(message);
    this.name = 'InteractiveSurfaceValidationError';
    this.reason = reason;
  }
}

function fail(message: string): never {
  throw new InteractiveSurfaceValidationError(message);
}

/** A plain object: not an array, not `null`, not a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A deep copy of a command, detached from the caller's objects; fails unless it is plain data. */
export function detach(value: Record<string, unknown>): Record<string, unknown> {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    fail('the command must be plain JSON data');
  }
  if (!isPlainObject(copy)) fail('the command must be an object');
  // `structuredClone` keeps a cycle, which the recursive JSON checks after this would overflow on
  // with a `RangeError`; serializing refuses it here, as it does anything nested too deeply.
  try {
    JSON.stringify(copy);
  } catch {
    fail('the command must be plain JSON data');
  }
  return copy;
}

/** Fails on any key of `value` outside `allowed`. */
export function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where} has an unknown field "${key}"`);
  }
}

/** A non-empty identifier of bounded length, with no control characters. */
export function readIdentifier(
  value: unknown,
  where: string,
  maxLength: number = MAX_IDENTIFIER_LENGTH,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`${where} must be a non-empty string of at most ${maxLength} characters`);
  }
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters.
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${where} must not contain control characters`);
  // An unpaired surrogate cannot be encoded into a storage key.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    fail(`${where} must be well-formed Unicode`);
  }
  return value;
}

function readOptionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${where} must be a string`);
  return value;
}

function readStringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${where} must be an array of strings`);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail(`${where} must hold only non-empty strings`);
    }
  }
  return value as readonly string[];
}

/** Checks the command's contract version. */
export function assertContractVersion(value: unknown): void {
  if (value !== INTERACTIVE_SURFACE_CONTRACT_VERSION) {
    fail(`contractVersion must be "${INTERACTIVE_SURFACE_CONTRACT_VERSION}"`);
  }
}

/** A JSON value: finite numbers, plain objects, and arrays all the way down. */
export function readJsonValue(value: unknown, where: string): InteractiveSurfaceJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${where} must hold only finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => readJsonValue(entry, `${where}[${index}]`));
    return value as InteractiveSurfaceJsonValue;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) readJsonValue(entry, `${where}.${key}`);
    return value as InteractiveSurfaceJsonValue;
  }
  fail(`${where} must be JSON`);
}

function readJsonObject(value: unknown, where: string): InteractiveSurfaceJsonObject {
  if (!isPlainObject(value)) fail(`${where} must be an object`);
  return readJsonValue(value, where) as InteractiveSurfaceJsonObject;
}

/** Reads a surface's text summary. */
export function readSummary(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('summary must be a non-empty string');
  }
  if (value.length > MAX_SUMMARY_LENGTH) {
    fail(`summary must be at most ${MAX_SUMMARY_LENGTH} characters`);
  }
  return value;
}

/** Reads an audience: unique, non-empty principals. */
export function readAudience(value: unknown): readonly string[] {
  if (value === undefined) return [];
  // Each principal is an identifier: bounded, with no control characters.
  const audience = readStringList(value, 'audience').map((principal, index) =>
    readIdentifier(principal, `audience[${index}]`),
  );
  if (new Set(audience).size !== audience.length) fail('audience must not repeat a principal');
  return audience;
}

// ── Schemas ─────────────────────────────────────────────────────────

/** Thrown when a surface schema would compile a regular expression. */
class RegularExpressionRefused extends Error {}

/**
 * Compiles and caches JSON Schema 2020-12 validators. Unknown keywords are
 * allowed (authors annotate their schemas), and `format` is not asserted,
 * which JSON Schema 2020-12 also makes the default.
 */
export class InteractiveSurfaceSchemaCompiler {
  /**
   * Ajv calls this engine for each `pattern` and `patternProperties` it
   * compiles, wherever the keyword sits (`dependencies` and every other
   * subschema position included), so Ajv's own vocabulary decides what is a
   * regular expression, and an annotation holding a `pattern` key is not one.
   * Only the meta-schema, compiled in the constructor, may use one.
   */
  #refusing = false;
  readonly #ajv: Ajv2020;

  /**
   * @param options.formats Formats to assert, by name, each a predicate over the string. Without
   * it `format` is an annotation, as JSON Schema 2020-12 makes it by default; with it, a value
   * that fails a listed format is an error, and a format not listed is still an annotation.
   */
  constructor(
    options: { readonly formats?: Readonly<Record<string, (value: string) => boolean>> } = {},
  ) {
    this.#ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      validateFormats: options.formats !== undefined,
      ...(options.formats === undefined
        ? {}
        : { formats: { ...options.formats }, logger: false as const }),
      code: {
        regExp: Object.assign(
          (pattern: string, flags: string): RegExp => {
            if (this.#refusing) throw new RegularExpressionRefused();
            return new RegExp(pattern, flags);
          },
          { code: 'new RegExp' },
        ),
      },
    });
    // Compile the meta-schema, whose own patterns are trusted, before refusing.
    this.#ajv.compile({});
    this.#refusing = true;
  }

  /** Compiled validators, most recently used last, bounded so unique schemas cannot grow the heap. */
  readonly #cache = new Map<string, ValidateFunction>();
  readonly #capacity = 256;

  /** Compiles `schema`, or fails naming `where`. */
  compile(schema: InteractiveSurfaceJsonObject, where: string): ValidateFunction {
    const key = JSON.stringify(schema);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    if (Object.hasOwn(schema, '$id')) fail(`${where} must not declare $id`);
    // Ajv registers each nested `$id` it finds in a real subschema position
    // (not a property named `$id`, nor annotation data), so a new entry in its
    // references is a nested `$id`, which would move base URIs and `$ref`
    // resolution, and collide across surfaces sharing this compiler.
    const known = new Set(Object.keys(this.#ajv.refs));
    const nestedIds = (): string[] => Object.keys(this.#ajv.refs).filter((ref) => !known.has(ref));
    let validate: ValidateFunction;
    try {
      validate = this.#ajv.compile(schema);
    } catch (error: unknown) {
      // Ajv caches a schema as compiling begins; a rejected one must not stay.
      for (const ref of nestedIds()) this.#ajv.removeSchema(ref);
      this.#ajv.removeSchema(schema);
      // A schema's regular expressions run on Bureau's event loop when a value
      // is admitted, and an untrusted author can write one that backtracks for
      // seconds, so v1 refuses them.
      if (error instanceof RegularExpressionRefused) {
        fail(`${where} must not use "pattern" or "patternProperties"`);
      }
      fail(
        `${where} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const added = nestedIds();
    if (added.length > 0) {
      for (const ref of added) this.#ajv.removeSchema(ref);
      this.#ajv.removeSchema(schema);
      fail(`${where} must not declare $id`);
    }
    // An asynchronous schema validates to a Promise; admission validates synchronously.
    if (Reflect.get(validate, '$async') === true) {
      this.#ajv.removeSchema(schema);
      fail(`${where} must not be an asynchronous ($async) schema`);
    }
    this.#cache.set(key, validate);
    if (this.#cache.size > this.#capacity) {
      const [oldestKey, oldest] = this.#cache.entries().next().value ?? [];
      if (oldestKey !== undefined && oldest !== undefined) {
        this.#cache.delete(oldestKey);
        this.#ajv.removeSchema(oldest.schema);
      }
    }
    return validate;
  }

  /**
   * Validates `value` against `schema` and returns every failure Ajv reports (empty when it
   * satisfies the schema). Throws {@link InteractiveSurfaceValidationError} when the schema
   * cannot be compiled under this compiler's rules.
   */
  errors(schema: InteractiveSurfaceJsonObject, value: unknown): readonly ErrorObject[] {
    const validate = this.compile(schema, 'schema');
    return validate(value) ? [] : [...(validate.errors ?? [])];
  }

  /** Validates `value` against `schema`; returns the first problem, or `undefined`. */
  check(schema: InteractiveSurfaceJsonObject, value: unknown): string | undefined {
    const validate = this.compile(schema, 'schema');
    if (validate(value)) return undefined;
    return this.#ajv.errorsText(validate.errors, { dataVar: 'value' });
  }
}

// ── Representations ─────────────────────────────────────────────────

function readInputForm(
  value: Record<string, unknown>,
  schemas: InteractiveSurfaceSchemaCompiler,
): InteractiveSurfaceRepresentation {
  assertKnownFields(value, ['kind', 'schema', 'submitLabel'], 'representation');
  const schema = readJsonObject(value['schema'], 'representation.schema');
  if (schema['type'] !== 'object') fail('representation.schema must describe an object');
  schemas.compile(schema, 'representation.schema');
  const submitLabel = readOptionalString(value['submitLabel'], 'representation.submitLabel');
  return { kind: 'input-form', schema, ...(submitLabel === undefined ? {} : { submitLabel }) };
}

function readA2ui(value: Record<string, unknown>): InteractiveSurfaceRepresentation {
  assertKnownFields(
    value,
    ['kind', 'specificationVersion', 'catalogId', 'components', 'theme', 'sendDataModel'],
    'representation',
  );
  if (value['specificationVersion'] !== INTERACTIVE_SURFACE_A2UI_VERSION) {
    fail(`representation.specificationVersion must be "${INTERACTIVE_SURFACE_A2UI_VERSION}"`);
  }
  const catalogId = readIdentifier(value['catalogId'], 'representation.catalogId');
  // A2UI's `createSurface` carries no components; they follow in `updateComponents`.
  if (!Array.isArray(value['components'])) fail('representation.components must be an array');
  const ids = new Set<string>();
  const components = value['components'].map((component: unknown, index) => {
    const where = `representation.components[${index}]`;
    const entry = readJsonObject(component, where);
    const id = readIdentifier(entry['id'], `${where}.id`);
    readIdentifier(entry['component'], `${where}.component`);
    if (ids.has(id)) fail(`${where}.id "${id}" is used twice`);
    ids.add(id);
    return entry;
  });
  const theme =
    value['theme'] === undefined
      ? undefined
      : readJsonObject(value['theme'], 'representation.theme');
  const sendDataModel = value['sendDataModel'];
  if (sendDataModel !== undefined && typeof sendDataModel !== 'boolean') {
    fail('representation.sendDataModel must be a boolean');
  }
  return {
    kind: 'a2ui',
    specificationVersion: INTERACTIVE_SURFACE_A2UI_VERSION,
    catalogId,
    components,
    ...(theme === undefined ? {} : { theme }),
    ...(sendDataModel === undefined ? {} : { sendDataModel }),
  };
}

const ORIGIN_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'wss:', 'ws:']);

/** A list of origins: a scheme, host, and optional port, and nothing else. */
function readOrigins(value: unknown, where: string): readonly string[] {
  const origins = readStringList(value, where);
  for (const origin of origins) {
    // The shape first (no path, query, or fragment), then the parse (a real
    // host and port, no credentials); default ports and letter case are allowed.
    const shaped = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\s]+$/i.test(origin);
    const parsed = shaped && URL.canParse(origin) ? new URL(origin) : undefined;
    // The parse is checked too: it reads `\` as `/`, so a shape alone can hide a path.
    if (
      parsed === undefined ||
      !ORIGIN_PROTOCOLS.has(parsed.protocol) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      origin.includes('\\')
    ) {
      fail(`${where} must hold only origins, such as "https://example.com"`);
    }
  }
  return origins;
}

function readMcpApp(value: Record<string, unknown>): InteractiveSurfaceRepresentation {
  assertKnownFields(
    value,
    [
      'kind',
      'resourceUri',
      'mimeType',
      'contentDigest',
      'instanceId',
      'csp',
      'permissions',
      'toolName',
      'domain',
      'prefersBorder',
    ],
    'representation',
  );
  const resourceUri = readIdentifier(value['resourceUri'], 'representation.resourceUri');
  if (!resourceUri.startsWith('ui://') || !URL.canParse(resourceUri)) {
    fail('representation.resourceUri must be a ui:// URI');
  }
  if (value['mimeType'] !== INTERACTIVE_SURFACE_MCP_APP_MIME_TYPE) {
    fail(`representation.mimeType must be "${INTERACTIVE_SURFACE_MCP_APP_MIME_TYPE}"`);
  }
  if (
    typeof value['contentDigest'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value['contentDigest'])
  ) {
    fail('representation.contentDigest must be "sha256:" and 64 lowercase hex digits');
  }
  const instanceId = readIdentifier(value['instanceId'], 'representation.instanceId');
  if (!isPlainObject(value['csp'])) fail('representation.csp must be an object');
  assertKnownFields(
    value['csp'],
    ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'],
    'representation.csp',
  );
  const csp = {
    connectDomains: readOrigins(
      value['csp']['connectDomains'],
      'representation.csp.connectDomains',
    ),
    resourceDomains: readOrigins(
      value['csp']['resourceDomains'],
      'representation.csp.resourceDomains',
    ),
    ...(value['csp']['frameDomains'] === undefined
      ? {}
      : {
          frameDomains: readOrigins(
            value['csp']['frameDomains'],
            'representation.csp.frameDomains',
          ),
        }),
    ...(value['csp']['baseUriDomains'] === undefined
      ? {}
      : {
          baseUriDomains: readOrigins(
            value['csp']['baseUriDomains'],
            'representation.csp.baseUriDomains',
          ),
        }),
  };
  if (!isPlainObject(value['permissions'])) fail('representation.permissions must be an object');
  for (const [name, granted] of Object.entries(value['permissions'])) {
    if (!MCP_APP_PERMISSIONS.has(name)) {
      fail(`representation.permissions has an unknown field "${name}"`);
    }
    if (typeof granted !== 'boolean') fail(`representation.permissions.${name} must be a boolean`);
  }
  const toolName = readOptionalString(value['toolName'], 'representation.toolName');
  const domain =
    value['domain'] === undefined
      ? undefined
      : readIdentifier(value['domain'], 'representation.domain');
  const prefersBorder = value['prefersBorder'];
  if (prefersBorder !== undefined && typeof prefersBorder !== 'boolean') {
    fail('representation.prefersBorder must be a boolean');
  }
  return {
    kind: 'mcp-app',
    resourceUri,
    mimeType: INTERACTIVE_SURFACE_MCP_APP_MIME_TYPE,
    contentDigest: value['contentDigest'],
    instanceId,
    csp,
    permissions: { ...value['permissions'] },
    ...(toolName === undefined ? {} : { toolName }),
    ...(domain === undefined ? {} : { domain }),
    ...(prefersBorder === undefined ? {} : { prefersBorder }),
  };
}

/** Reads a representation of a known kind, checking everything that kind carries. */
export function readRepresentation(
  value: unknown,
  schemas: InteractiveSurfaceSchemaCompiler,
): InteractiveSurfaceRepresentation {
  if (!isPlainObject(value)) fail('representation must be an object');
  switch (value['kind']) {
    case 'input-form':
      return readInputForm(value, schemas);
    case 'a2ui':
      return readA2ui(value);
    case 'mcp-app':
      return readMcpApp(value);
    default:
      return fail('representation.kind must be "input-form", "a2ui", or "mcp-app"');
  }
}

// ── Actions ─────────────────────────────────────────────────────────

function readAction(
  value: unknown,
  where: string,
  schemas: InteractiveSurfaceSchemaCompiler,
): InteractiveSurfaceActionDefinition {
  if (!isPlainObject(value)) fail(`${where} must be an object`);
  assertKnownFields(value, ['name', 'intent', 'continuation', 'valueSchema', 'label'], where);
  const name = readIdentifier(value['name'], `${where}.name`);
  if (typeof value['intent'] !== 'string' || !ACTION_INTENTS.has(value['intent'])) {
    fail(`${where}.intent must be "answer", "submit", "approve", or "deny"`);
  }
  const intent = value['intent'] as InteractiveSurfaceActionIntent;
  const continuation = value['continuation'];
  if (!isPlainObject(continuation)) fail(`${where}.continuation must be an object`);
  const decides = intent === 'approve' || intent === 'deny';
  let readContinuation: InteractiveSurfaceActionDefinition['continuation'];
  if (decides) {
    if (continuation['type'] !== 'review') fail(`${where}: an ${intent} action continues a review`);
    assertKnownFields(continuation, ['type', 'reviewId', 'round'], `${where}.continuation`);
    const round = continuation['round'];
    if (
      round !== undefined &&
      (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 0)
    ) {
      fail(`${where}.continuation.round must be a non-negative integer`);
    }
    readContinuation = {
      type: 'review',
      reviewId: readIdentifier(
        continuation['reviewId'],
        `${where}.continuation.reviewId`,
        MAX_COMPOSITE_IDENTIFIER_LENGTH,
      ),
      ...(round === undefined ? {} : { round }),
    };
  } else if (continuation['type'] === 'review') {
    // An answer delivers its value as a held human wait's payload; it never decides an approval.
    assertKnownFields(continuation, ['type', 'reviewId'], `${where}.continuation`);
    const reviewId = readIdentifier(
      continuation['reviewId'],
      `${where}.continuation.reviewId`,
      MAX_COMPOSITE_IDENTIFIER_LENGTH,
    );
    if (!reviewId.startsWith('human-wait:')) {
      fail(`${where}: an ${intent} action continues a signal or a human-wait review`);
    }
    readContinuation = { type: 'review', reviewId };
  } else {
    if (continuation['type'] !== 'signal') {
      fail(`${where}: an ${intent} action continues a signal or a human-wait review`);
    }
    assertKnownFields(continuation, ['type', 'sessionId', 'signalName'], `${where}.continuation`);
    readContinuation = {
      type: 'signal',
      sessionId: readIdentifier(continuation['sessionId'], `${where}.continuation.sessionId`),
      signalName: readIdentifier(continuation['signalName'], `${where}.continuation.signalName`),
    };
  }
  let valueSchema: InteractiveSurfaceJsonObject | undefined;
  if (value['valueSchema'] !== undefined) {
    valueSchema = readJsonObject(value['valueSchema'], `${where}.valueSchema`);
    schemas.compile(valueSchema, `${where}.valueSchema`);
  }
  const label = readOptionalString(value['label'], `${where}.label`);
  return {
    name,
    intent,
    continuation: readContinuation,
    ...(valueSchema === undefined ? {} : { valueSchema }),
    ...(label === undefined ? {} : { label }),
  };
}

/** Reads an action catalog: well-formed actions with unique names. */
export function readActions(
  value: unknown,
  schemas: InteractiveSurfaceSchemaCompiler,
): readonly InteractiveSurfaceActionDefinition[] {
  if (!Array.isArray(value)) fail('actions must be an array');
  const actions = value.map((action: unknown, index) =>
    readAction(action, `actions[${index}]`, schemas),
  );
  const names = new Set(actions.map((action) => action.name));
  if (names.size !== actions.length) fail('actions must not repeat a name');
  return actions;
}

/**
 * The schema an action's value must satisfy: its own, or, for an `answer` or
 * `submit` on an `input-form` surface, the form's. `undefined` when the
 * action takes no value.
 */
export function actionValueSchema(
  action: InteractiveSurfaceActionDefinition,
  representation: InteractiveSurfaceRepresentation | null,
): InteractiveSurfaceJsonObject | undefined {
  if (action.valueSchema !== undefined) return action.valueSchema;
  if (
    representation?.kind === 'input-form' &&
    (action.intent === 'answer' || action.intent === 'submit')
  ) {
    return representation.schema;
  }
  return undefined;
}

// ── Size ────────────────────────────────────────────────────────────

/** The UTF-8 size of `value`'s JSON. */
export function jsonByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

/** Fails with `payload-too-large` when `content` exceeds `limit` bytes of JSON. */
export function assertWithinPayloadLimit(content: unknown, limit: number): void {
  const size = jsonByteLength(content);
  if (size > limit) {
    throw new InteractiveSurfaceValidationError(
      `the surface's content is ${size} bytes, over the ${limit}-byte limit`,
      'payload-too-large',
    );
  }
}
