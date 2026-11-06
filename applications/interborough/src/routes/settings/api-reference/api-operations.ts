/**
 * The operations Settings › API reference lists (board PageSettingsSections, "API reference ·
 * Operations"), read from Interborough's own OpenAPI description (`/api/openapi.json`,
 * `src/host/api-description.ts`): each operation's method, path and summary, the scope it needs
 * (`x-interborough-scope`), the group it belongs to (its first tag), and an example request and
 * response made from its schemas. The document is what other programs generate their clients from,
 * so the page cannot list an operation the server does not serve.
 */

interface SchemaLike {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, SchemaLike>>;
  readonly required?: readonly string[];
  readonly items?: SchemaLike;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly default?: unknown;
  readonly example?: unknown;
  readonly anyOf?: readonly SchemaLike[];
  readonly oneOf?: readonly SchemaLike[];
  readonly allOf?: readonly SchemaLike[];
}

interface ContentLike {
  readonly content?: Readonly<Record<string, { readonly schema?: SchemaLike }>>;
}

interface OperationLike {
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly requestBody?: ContentLike;
  readonly responses?: Readonly<Record<string, ContentLike>>;
  readonly 'x-interborough-scope'?: string;
}

/** The parts of an OpenAPI document this page reads. */
export interface OpenApiDocumentLike {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, OperationLike>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, SchemaLike>> };
}

/** One operation, as a row of the table and the request and response its row opens. */
export interface ApiOperation {
  /** The operation's identifier, which names its row. */
  readonly id: string;
  /** The HTTP method, in capitals. */
  readonly method: string;
  readonly path: string;
  /** What the operation does, in a few words. */
  readonly summary: string;
  /** The scope the operation needs, or `undefined` when any caller may use it. */
  readonly scope: string | undefined;
  /** The group the operation belongs to: its first tag. */
  readonly group: string;
  /** An example request body as pretty JSON, or `undefined` when the operation takes none. */
  readonly request: string | undefined;
  /** The status of the success response. */
  readonly responseStatus: string | undefined;
  /** An example success response as pretty JSON, or `undefined` when it has no body. */
  readonly response: string | undefined;
}

/** The group an operation with no tag belongs to. */
export const UNTAGGED_GROUP = 'Other';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAXIMUM_DEPTH = 4;
const JSON_MEDIA_TYPE = 'application/json';

function resolve(schema: SchemaLike, document: OpenApiDocumentLike): SchemaLike {
  const reference = schema.$ref;
  if (reference === undefined) return schema;
  const name = reference.split('/').at(-1);
  const found = name === undefined ? undefined : document.components?.schemas?.[name];
  return found ?? {};
}

function typeOf(schema: SchemaLike): string | undefined {
  const { type } = schema;
  if (Array.isArray(type)) return type.find((candidate) => candidate !== 'null');
  return typeof type === 'string' ? type : undefined;
}

/** An example value for a schema: a stated example, default or constant, else a placeholder of the right shape. */
export function exampleOf(input: SchemaLike, document: OpenApiDocumentLike, depth = 0): unknown {
  const schema = resolve(input, document);
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum !== undefined && schema.enum.length > 0) return schema.enum[0];
  const alternative = schema.anyOf?.[0] ?? schema.oneOf?.[0];
  if (alternative !== undefined) return exampleOf(alternative, document, depth);
  if (schema.allOf !== undefined) {
    return Object.assign(
      {},
      ...schema.allOf.map((part) => {
        const value = exampleOf(part, document, depth);
        return typeof value === 'object' && value !== null ? value : {};
      }),
    );
  }
  switch (typeOf(schema)) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return depth >= MAXIMUM_DEPTH || schema.items === undefined
        ? []
        : [exampleOf(schema.items, document, depth + 1)];
    default: {
      if (schema.properties === undefined) return depth === 0 && schema.type === 'object' ? {} : {};
      if (depth >= MAXIMUM_DEPTH) return {};
      const required = new Set(schema.required ?? []);
      const names = Object.keys(schema.properties).filter((name) => required.has(name));
      return Object.fromEntries(
        names.map((name) => [name, exampleOf(schema.properties![name]!, document, depth + 1)]),
      );
    }
  }
}

function jsonSchemaOf(content: ContentLike | undefined): SchemaLike | undefined {
  return content?.content?.[JSON_MEDIA_TYPE]?.schema;
}

/** The scope an operation names, or `undefined` for one open to any caller. */
export function scopeOf(operation: OperationLike): string | undefined {
  const scope = operation['x-interborough-scope'];
  return typeof scope === 'string' && scope !== '' ? scope : undefined;
}

/** The longest example the table writes on one line, as the board draws a short one. */
const INLINE_EXAMPLE_LENGTH = 72;

function inline(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map((item) => inline(item)).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * An example as the table writes it: on one line, spaced as the board draws
 * `{ "workflow": "order-refund", "input": { "order": 4471 } }`, when that fits; indented JSON
 * when it does not.
 */
export function formatExample(value: unknown): string {
  const line = inline(value);
  return line.length <= INLINE_EXAMPLE_LENGTH ? line : JSON.stringify(value, null, 2);
}

function successOf(
  operation: OperationLike,
): { readonly status: string; readonly schema: SchemaLike | undefined } | undefined {
  const status = Object.keys(operation.responses ?? {}).find((code) => /^2\d\d$/.test(code));
  if (status === undefined) return undefined;
  return { status, schema: jsonSchemaOf(operation.responses?.[status]) };
}

/** How many operations of the document carry each `operationId`. */
function operationIdCounts(document: OpenApiDocumentLike): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of Object.values(document.paths ?? {})) {
    for (const method of METHODS) {
      const operationId = entry[method]?.operationId;
      if (operationId !== undefined) counts.set(operationId, (counts.get(operationId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The identifier of an operation's row, which keys it in the table. It is the `operationId`, which
 * OpenAPI says is unique but a generated document can repeat (the server gives the GET and the POST
 * of a workflow query one), so a repeated one also names its method and path, and a row never
 * shares a key with another.
 */
function rowIdentifier(
  operationId: string | undefined,
  method: string,
  path: string,
  counts: ReadonlyMap<string, number>,
): string {
  if (operationId === undefined) return `${method} ${path}`;
  return (counts.get(operationId) ?? 0) > 1 ? `${operationId} ${method} ${path}` : operationId;
}

/**
 * Every operation the document serves, in the order it lists them: by path as the document orders
 * its paths, then by method. The order is the server's, so the table reads as the description does.
 */
export function buildApiOperations(document: OpenApiDocumentLike): readonly ApiOperation[] {
  const operations: ApiOperation[] = [];
  const claimed = operationIdCounts(document);
  for (const [path, entry] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = entry[method];
      if (operation === undefined) continue;
      const requestSchema = jsonSchemaOf(operation.requestBody);
      const success = successOf(operation);
      operations.push({
        id: rowIdentifier(operation.operationId, method, path, claimed),
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? operation.operationId ?? '',
        scope: scopeOf(operation),
        group: operation.tags?.[0] ?? UNTAGGED_GROUP,
        request:
          requestSchema === undefined
            ? undefined
            : formatExample(exampleOf(requestSchema, document)),
        responseStatus: success?.status,
        response:
          success?.schema === undefined
            ? undefined
            : formatExample(exampleOf(success.schema, document)),
      });
    }
  }
  return operations;
}

/** The groups the operations fall in, in the order the table lists them. */
export function operationGroups(operations: readonly ApiOperation[]): readonly string[] {
  return [...new Set(operations.map((operation) => operation.group))];
}
