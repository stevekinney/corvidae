/**
 * Reading an OpenAPI spec before it is connected (COR-2009, PageConnectTools): the page uploads a
 * file, or names its address, and the host says what it holds before anything is saved.
 *
 * - **A file that is not an OpenAPI 3 spec** keeps its name and says what is wrong and on which
 *   line, in plain words: `This isn’t a valid OpenAPI 3 file. Line 14: “paths” must be an object.`
 *   A file that is not YAML or JSON at all says where reading stopped.
 * - **A valid spec whose operations have no `operationId`** is its own answer, because each tool is
 *   named by one: the page names the problem rather than listing no tools.
 * - **A valid spec** answers its version (`3.1`), title, first server, operations (each with its
 *   method, path, `operationId`, `summary` as its title, and the risk its method carries, as Armorer
 *   reads it), the parsed document to connect with, and the one operation Test connection calls:
 *   the first `GET` in the order the file lists its paths that has an `operationId` and needs no
 *   input, which a wrong key fails at once (“Calls List refunds (GET /refunds)”). The probe
 *   (`tool-source-manager.ts`) calls the same operation by the same rule.
 *
 * YAML and JSON are both read with `js-yaml`, whose errors carry the line. The line of a field the
 * spec gets wrong is the line its key is written on.
 *
 * @module openapi-inspection
 */

import { load, YAMLException } from 'js-yaml';

/** The HTTP methods an OpenAPI path item holds operations under, in the order Armorer reads them. */
const OPERATION_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

/** The methods Armorer reads as read-only; `delete` is dangerous and the rest change things. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['get', 'head', 'options', 'trace']);

/** The largest spec the host reads: the size of a request body the tool-source routes accept. */
export const MAXIMUM_OPENAPI_SPEC_BYTES = 4 * 1024 * 1024;

/** One operation of a spec, as Choose tools lists it. */
export type OpenApiOperationSummary = {
  /** The operation's `operationId`, which names its tool, or `null` when it has none. */
  readonly operationId: string | null;
  /** The HTTP method, upper case: `GET`. */
  readonly method: string;
  /** The path it is written under: `/refunds/{id}`. */
  readonly path: string;
  /** Its `summary`, the tool's name for a person, or `null` when it has none. */
  readonly title: string | null;
  /** Its `description`, or `null`. */
  readonly description: string | null;
  /** The risk its method carries: `read-only`, `mutating` or `dangerous`. */
  readonly tier: 'read-only' | 'mutating' | 'dangerous';
};

/** The operation Test connection calls: a `GET` that needs no input. */
export type OpenApiTestOperation = {
  /** Its `operationId`. */
  readonly operationId: string;
  /** Its `summary`, or `null` when it has none. */
  readonly title: string | null;
  /** Always `GET`. */
  readonly method: 'GET';
  /** The path it calls. */
  readonly path: string;
};

/** What the host makes of a spec. */
export type OpenApiInspection =
  /** An OpenAPI 3 spec with at least one operation that has an `operationId`. */
  | {
      readonly outcome: 'valid';
      /** The uploaded file's name, or `null` for a spec read from an address. */
      readonly fileName: string | null;
      /** The major and minor version: `3.1`. */
      readonly version: string;
      /** The spec's `info.title`, which prefills Name, or `null`. */
      readonly title: string | null;
      /** The first server's URL, which prefills Base URL, or `null`. */
      readonly baseUrl: string | null;
      /** How many operations the spec has. */
      readonly operationCount: number;
      /** Every operation, in the order the file lists them. */
      readonly operations: readonly OpenApiOperationSummary[];
      /** The operation Test connection calls, or `null` when no `GET` needs no input. */
      readonly testOperation: OpenApiTestOperation | null;
      /** The parsed spec, the `document` of the tool source description to connect. */
      readonly document: Readonly<Record<string, unknown>>;
    }
  /** Not an OpenAPI 3 spec, or not YAML or JSON. */
  | {
      readonly outcome: 'invalid';
      readonly fileName: string | null;
      /** The line the problem is on, from 1, or `null` when it has none. */
      readonly line: number | null;
      /** What is wrong, as a sentence: `“paths” must be an object.` */
      readonly problem: string;
      /** The whole message a page shows. */
      readonly message: string;
    }
  /** A valid spec in which no operation has an `operationId`, so no tool can be named. */
  | {
      readonly outcome: 'no-operation-ids';
      readonly fileName: string | null;
      readonly version: string;
      readonly operationCount: number;
      /** The whole message a page shows. */
      readonly message: string;
    };

/** What an address answered when the spec could not be fetched from it. */
export type OpenApiFetchFailure = {
  /** Always `unreachable`: the address gave no spec to read. */
  readonly outcome: 'unreachable';
  /** The HTTP status the address answered, or `null` when it did not answer. */
  readonly status: number | null;
  /** The whole message a page shows. Nothing was saved. */
  readonly message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` trimmed, when it is a string with something in it. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The line, from 1, that a top-level key `key` is written on in `source`, or `null`. JSON is read
 * by depth, so a nested key of the same name is never taken; YAML's top-level keys start a line.
 */
export function lineOfTopLevelKey(source: string, key: string): number | null {
  if (source.trimStart().startsWith('{')) return lineOfJsonTopLevelKey(source, key);
  const lines = source.split('\n');
  const pattern = new RegExp(
    `^(?:${escapeRegExp(key)}|"${escapeRegExp(key)}"|'${escapeRegExp(key)}')\\s*:`,
  );
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? null : index + 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** {@link lineOfTopLevelKey} for JSON: a key string at depth one followed by a colon. */
function lineOfJsonTopLevelKey(source: string, key: string): number | null {
  let depth = 0;
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n') line += 1;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    else if (character === '"') {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '\n') line += 1;
        index += 1;
      }
      if (depth !== 1) continue;
      const after = source.slice(index + 1).match(/^\s*:/);
      if (after === null) continue;
      try {
        if (JSON.parse(source.slice(start, index + 1)) === key) return line;
      } catch {
        // A string JSON cannot read is no key.
      }
    }
  }
  return null;
}

/** The answer for a spec that is not OpenAPI 3, with the line of `key` when there is one. */
function invalid(
  fileName: string | null,
  line: number | null,
  problem: string,
): Extract<OpenApiInspection, { outcome: 'invalid' }> {
  const where = line === null ? '' : `Line ${String(line)}: `;
  return {
    outcome: 'invalid',
    fileName,
    line,
    problem,
    message: `This isn’t a valid OpenAPI 3 file. ${where}${problem}`,
  };
}

/** The parameters an operation declares beside its path's, local `$ref`s resolved, unreadable ones as `null`. */
function parametersOf(
  document: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): (Record<string, unknown> | null)[] {
  const resolve = (parameter: unknown): Record<string, unknown> | null => {
    if (!isRecord(parameter)) return null;
    const reference = parameter['$ref'];
    if (typeof reference !== 'string') return parameter;
    const prefix = '#/components/parameters/';
    if (!reference.startsWith(prefix)) return null;
    const components = document['components'];
    const parameters = isRecord(components) ? components['parameters'] : undefined;
    const name = reference.slice(prefix.length);
    return isRecord(parameters) && Object.hasOwn(parameters, name) && isRecord(parameters[name])
      ? parameters[name]
      : null;
  };
  const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  return [...listed(pathItem['parameters']), ...listed(operation['parameters'])].map(resolve);
}

/**
 * Whether a call to the operation needs input: a templated path (`/refunds/{id}`), a required or
 * path parameter, a parameter that cannot be read, or a required body.
 */
function needsInput(
  document: Record<string, unknown>,
  path: string,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): boolean {
  if (path.includes('{')) return true;
  const parameters = parametersOf(document, pathItem, operation);
  if (
    parameters.some(
      (parameter) =>
        parameter === null || parameter['required'] === true || parameter['in'] === 'path',
    )
  ) {
    return true;
  }
  const body = operation['requestBody'];
  return isRecord(body) && (body['required'] === true || typeof body['$ref'] === 'string');
}

/**
 * What `source` holds, read as an OpenAPI 3 spec. `fileName` is the uploaded file's name, kept in
 * every answer so the page can show it beside what is wrong.
 */
export function inspectOpenApiSpec(source: string, fileName: string | null): OpenApiInspection {
  let parsed: unknown;
  try {
    parsed = load(source, { json: true });
  } catch (error) {
    if (error instanceof YAMLException) {
      return invalid(
        fileName,
        error.mark === undefined ? null : error.mark.line + 1,
        `The file can’t be read as YAML or JSON: ${error.reason}.`,
      );
    }
    return invalid(fileName, null, 'The file can’t be read as YAML or JSON.');
  }
  if (!isRecord(parsed)) {
    return invalid(fileName, 1, 'The file must hold an object of OpenAPI fields.');
  }
  const openapi = parsed['openapi'];
  const version = typeof openapi === 'string' ? /^3\.(\d+)(?:\.\d+)?$/.exec(openapi.trim()) : null;
  if (version === null) {
    return invalid(
      fileName,
      lineOfTopLevelKey(source, 'openapi') ?? 1,
      '“openapi” must be a 3.x version, such as 3.1.0.',
    );
  }
  const paths = parsed['paths'];
  const pathsLine = lineOfTopLevelKey(source, 'paths');
  if (!isRecord(paths)) {
    return invalid(fileName, pathsLine ?? 1, '“paths” must be an object.');
  }
  const operations: OpenApiOperationSummary[] = [];
  let testOperation: OpenApiTestOperation | null = null;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) {
      return invalid(fileName, pathsLine, `The path “${path}” must be an object.`);
    }
    for (const method of OPERATION_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) continue;
      if (!isRecord(operation)) {
        return invalid(
          fileName,
          pathsLine,
          `The ${method.toUpperCase()} operation of “${path}” must be an object.`,
        );
      }
      const operationId = text(operation['operationId']);
      const title = text(operation['summary']);
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        title,
        description: text(operation['description']),
        tier: READ_ONLY_METHODS.has(method)
          ? 'read-only'
          : method === 'delete'
            ? 'dangerous'
            : 'mutating',
      });
      if (
        testOperation === null &&
        method === 'get' &&
        operationId !== null &&
        !needsInput(parsed, path, pathItem, operation)
      ) {
        testOperation = { operationId, title, method: 'GET', path };
      }
    }
  }
  if (operations.length === 0) {
    return invalid(fileName, pathsLine, '“paths” lists no operations.');
  }
  const versionText = `3.${version[1] ?? '0'}`;
  if (operations.every((operation) => operation.operationId === null)) {
    const count = operations.length;
    return {
      outcome: 'no-operation-ids',
      fileName,
      version: versionText,
      operationCount: count,
      message:
        count === 1
          ? 'The one operation has no operationId, and each tool needs one. Add an operationId to the spec, then upload it again.'
          : `None of the ${String(count)} operations has an operationId, and each tool needs one. Add operationIds to the spec, then upload it again.`,
    };
  }
  const info = parsed['info'];
  const servers = parsed['servers'];
  const firstServer = Array.isArray(servers) ? (servers as unknown[])[0] : undefined;
  return {
    outcome: 'valid',
    fileName,
    version: versionText,
    title: isRecord(info) ? text(info['title']) : null,
    baseUrl: isRecord(firstServer) ? text(firstServer['url']) : null,
    operationCount: operations.length,
    operations,
    testOperation,
    document: parsed,
  };
}

/**
 * The spec at `url`, inspected as {@link inspectOpenApiSpec} inspects an upload, or what the
 * address answered instead. Nothing is saved either way.
 */
export async function inspectOpenApiAddress(
  url: string,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<OpenApiInspection | OpenApiFetchFailure> {
  const fetchImplementation = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: { accept: 'application/json, application/yaml, text/yaml, */*' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return {
      outcome: 'unreachable',
      status: null,
      message:
        'Couldn’t fetch the spec. The address didn’t answer. Check it, or upload the file instead.',
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return {
      outcome: 'unreachable',
      status: response.status,
      message: `Couldn’t fetch the spec. The address answered ${String(response.status)}. Check it, or upload the file instead.`,
    };
  }
  const body = await response.text();
  if (body.length > MAXIMUM_OPENAPI_SPEC_BYTES) {
    return invalid(null, null, 'The spec is larger than 4 MB.');
  }
  return inspectOpenApiSpec(body, null);
}
