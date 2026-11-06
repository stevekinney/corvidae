/**
 * The operations Settings › API reference lists (board PageSettingsSections, "API reference ·
 * Operations"), read from the server's own OpenAPI description: each operation's method, path and
 * summary, the scope it needs, the group it belongs to (its first tag), and an example request and
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

interface ScopeRequirementLike {
  readonly kind?: string;
  readonly scopes?: readonly string[];
}

interface AccessLike {
  readonly kind?: string;
  readonly scopes?: ScopeRequirementLike;
  readonly alternatives?: readonly ScopeRequirementLike[];
}

interface OperationLike {
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly requestBody?: ContentLike;
  readonly responses?: Readonly<Record<string, ContentLike>>;
  readonly 'x-weft-access'?: AccessLike;
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

function requirementText(requirement: ScopeRequirementLike | undefined): string | undefined {
  const scopes = requirement?.scopes ?? [];
  if (scopes.length === 0) return undefined;
  return scopes.join(requirement?.kind === 'anyOf' ? ' or ' : ', ');
}

/** The scope an operation's access policy names, or `undefined` for one open to any caller. */
export function scopeOf(access: AccessLike | undefined): string | undefined {
  if (access === undefined) return undefined;
  if (access.kind === 'scoped') return requirementText(access.scopes);
  if (access.kind === 'scopedAlternatives') {
    const alternatives = (access.alternatives ?? []).flatMap((alternative) => {
      const text = requirementText(alternative);
      return text === undefined ? [] : [text];
    });
    return alternatives.length === 0 ? undefined : alternatives.join(' or ');
  }
  return undefined;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function successOf(
  operation: OperationLike,
): { readonly status: string; readonly schema: SchemaLike | undefined } | undefined {
  const status = Object.keys(operation.responses ?? {}).find((code) => /^2\d\d$/.test(code));
  if (status === undefined) return undefined;
  return { status, schema: jsonSchemaOf(operation.responses?.[status]) };
}

/** Where a method falls among the ones the table lists: the order of {@link METHODS}. */
function methodOrder(method: string): number {
  return METHODS.findIndex((candidate) => candidate === method.toLowerCase());
}

/**
 * Every operation the document serves, by group, then path, then method. A route that carries no
 * access policy (the health check, the documents themselves) is not an operation of the API.
 */
export function buildApiOperations(document: OpenApiDocumentLike): readonly ApiOperation[] {
  const operations: ApiOperation[] = [];
  for (const [path, entry] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = entry[method];
      if (operation === undefined || operation['x-weft-access'] === undefined) continue;
      const requestSchema = jsonSchemaOf(operation.requestBody);
      const success = successOf(operation);
      operations.push({
        id: operation.operationId ?? `${method} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? operation.operationId ?? '',
        scope: scopeOf(operation['x-weft-access']),
        group: operation.tags?.[0] ?? UNTAGGED_GROUP,
        request:
          requestSchema === undefined ? undefined : pretty(exampleOf(requestSchema, document)),
        responseStatus: success?.status,
        response:
          success?.schema === undefined ? undefined : pretty(exampleOf(success.schema, document)),
      });
    }
  }
  return operations.toSorted(
    (left, right) =>
      left.group.localeCompare(right.group) ||
      left.path.localeCompare(right.path) ||
      methodOrder(left.method) - methodOrder(right.method),
  );
}

/** The groups the operations fall in, in the order the table lists them. */
export function operationGroups(operations: readonly ApiOperation[]): readonly string[] {
  return [...new Set(operations.map((operation) => operation.group))];
}
