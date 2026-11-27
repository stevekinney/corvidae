import { compileSchema, draft2020, extendDraft, type JsonSchema } from 'json-schema-library';

export type SchemaError = {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
};

export type SchemaValidator = {
  readonly errors: readonly SchemaError[];
  validate(value: unknown): boolean;
};

type SchemaNode = { readonly schema: unknown; readonly [key: string]: unknown };
type RawError = {
  readonly code: unknown;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
};

type FormatValidator = NonNullable<Parameters<typeof extendDraft>[1]['formats']>[string];

const BUILT_IN_FORMATS = [
  'date',
  'date-time',
  'duration',
  'email',
  'json-pointer',
  'relative-json-pointer',
  'regex',
  'time',
  'url',
  'uuid',
] as const;

const annotationFormat: FormatValidator = () => undefined;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && 'schema' in value;
}

function childNodes(node: SchemaNode): SchemaNode[] {
  const children: SchemaNode[] = [];
  for (const key of [
    'additionalProperties',
    'items',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'propertyNames',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    if (isNode(value)) children.push(value);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    if (Array.isArray(value)) children.push(...value.filter(isNode));
  }
  for (const key of ['properties', '$defs', 'dependentSchemas', 'propertyDependencies']) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    if (typeof value !== 'object' || value === null) continue;
    for (const entry of Object.values(value)) {
      if (isNode(entry)) children.push(entry);
      else if (typeof entry === 'object' && entry !== null)
        children.push(...Object.values(entry).filter(isNode));
    }
  }
  return children;
}

function rejectUnsafeKeywords(root: SchemaNode): void {
  const seen = new Set<SchemaNode>();
  const visit = (node: SchemaNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (typeof node.schema === 'object' && node.schema !== null) {
      const schema = node.schema as Record<string, unknown>;
      if (Object.hasOwn(schema, '$id')) throw new Error('must not declare $id');
      if (Object.hasOwn(schema, '$async'))
        throw new Error('must not be an asynchronous ($async) schema');
      if (Object.hasOwn(schema, 'pattern') || Object.hasOwn(schema, 'patternProperties'))
        throw new Error('must not use "pattern" or "patternProperties"');
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
}

/** Resolve every reference while compiling, including references below optional properties. */
function rejectUnresolvedReferences(root: SchemaNode): void {
  const seen = new Set<SchemaNode>();
  const visit = (node: SchemaNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (typeof node.schema === 'object' && node.schema !== null) {
      const schema = node.schema as Record<string, unknown>;
      if (Object.hasOwn(schema, '$ref')) {
        const result = (
          node as SchemaNode & { validate(value: unknown): { errors: RawError[] } }
        ).validate(undefined);
        const error = result.errors.find((candidate) => candidate.code === 'ref-error');
        if (error !== undefined) throw new Error(error.message);
      }
      const dynamicReference = schema['$dynamicRef'];
      if (typeof dynamicReference === 'string' && !dynamicReference.startsWith('#')) {
        throw new Error('"$dynamicRef" only supports hash fragment reference');
      }
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
}

function keywordOf(code: unknown): string {
  const value = typeof code === 'string' ? code : '';
  const known: Readonly<Record<string, string>> = {
    'required-property-error': 'required',
    'no-additional-properties-error': 'additionalProperties',
    'type-error': 'type',
    'enum-error': 'enum',
    'format-error': 'format',
    'min-length-error': 'minLength',
    'max-length-error': 'maxLength',
    'any-of-error': 'anyOf',
    'multiple-oneof-error': 'oneOf',
    'multiple-one-of-error': 'oneOf',
  };
  if (Object.hasOwn(known, value)) return known[value] ?? 'schema';
  if (value.startsWith('format-') && value.endsWith('-error')) return 'format';
  return value.endsWith('-error') ? value.slice(0, -'-error'.length).replaceAll('-', '') : value;
}

function pathForSchema(root: unknown, target: unknown, path = ''): string | undefined {
  if (root === target) return path;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return undefined;
  const record = root as Record<string, unknown>;
  const properties = Object.hasOwn(record, 'properties') ? record['properties'] : undefined;
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      const found = pathForSchema(
        child,
        target,
        `${path}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      );
      if (found !== undefined) return found;
    }
  }
  for (const key of ['items', 'allOf', 'anyOf', 'oneOf', '$defs']) {
    if (!Object.hasOwn(record, key)) continue;
    const child = record[key];
    if (Array.isArray(child)) {
      for (const entry of child) {
        const found = pathForSchema(entry, target, path);
        if (found !== undefined) return found;
      }
    } else {
      const found = pathForSchema(child, target, path);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Restores JSON Pointer escaping without replacing the array indexes in an instance location. */
function pointerOf(rawPointer: string, schemaPointer: string | undefined): string {
  if (schemaPointer === undefined || schemaPointer === '') return rawPointer;
  const decoded = schemaPointer.replaceAll('~1', '/').replaceAll('~0', '~');
  return rawPointer.endsWith(decoded)
    ? `${rawPointer.slice(0, rawPointer.length - decoded.length)}${schemaPointer}`
    : rawPointer;
}

function errorOf(error: RawError, rootSchema: Readonly<Record<string, unknown>>): SchemaError {
  const data = error.data ?? {};
  const keyword = keywordOf(error.code);
  const params: Record<string, unknown> = { ...data };
  if (keyword === 'required') params['missingProperty'] = data['key'];
  if (keyword === 'additionalProperties') params['additionalProperty'] = data['property'];
  if (keyword === 'enum') params['allowedValues'] = data['values'];
  if (
    keyword === 'format' &&
    typeof (data['schema'] as Record<string, unknown> | undefined)?.['format'] === 'string'
  ) {
    params['format'] = (data['schema'] as Record<string, unknown>)['format'];
  }
  const rawPointer = typeof data['pointer'] === 'string' ? data['pointer'].slice(1) : '';
  const pointer = pointerOf(rawPointer, pathForSchema(rootSchema, data['schema']));
  const instancePath =
    keyword === 'additionalProperties'
      ? pointer.slice(0, Math.max(0, pointer.lastIndexOf('/')))
      : pointer;
  const message =
    keyword === 'type' && typeof data['expected'] === 'string'
      ? `must be ${data['expected']}`
      : error.message;
  return { instancePath, keyword, message, params };
}

function errorPath(error: SchemaError): string {
  if (error.keyword !== 'required' && error.keyword !== 'additionalProperties') {
    return error.instancePath;
  }
  const named =
    error.keyword === 'required'
      ? error.params['missingProperty']
      : error.params['additionalProperty'];
  return typeof named === 'string' ? `${error.instancePath}/${named}` : error.instancePath;
}

export function compileInterpretedSchema(
  schema: Readonly<Record<string, unknown>>,
  options: {
    readonly formats?: Readonly<Record<string, (value: string) => boolean>>;
    readonly remotes?: readonly Readonly<Record<string, unknown>>[];
    readonly allowUnsafeKeywords?: boolean;
  } = {},
): SchemaValidator {
  const formats = options.formats;
  const customFormats = Object.entries(formats ?? {}).map(([name, predicate]) => {
    const validator: FormatValidator = ({ node, pointer, data }) => {
      if (typeof data !== 'string' || predicate(data)) return undefined;
      return node.createError(
        'format-error',
        { pointer, format: name, schema: node.schema, value: data },
        'must match its format',
      );
    };
    return [name, validator] as const;
  });
  const draft =
    formats === undefined
      ? draft2020
      : extendDraft(draft2020, {
          formats: Object.fromEntries([
            ...BUILT_IN_FORMATS.map((name) => [name, annotationFormat]),
            ...customFormats,
          ]),
        });
  const compileOptions = {
    drafts: [draft],
    formatAssertion: formats !== undefined,
    throwOnInvalidRef: true,
    ...(options.remotes === undefined ? {} : { remotes: options.remotes as JsonSchema[] }),
  };
  const root = compileSchema(schema, compileOptions);
  if ((root.schemaErrors?.length ?? 0) > 0) throw new Error(root.schemaErrors?.[0]?.message);
  rejectUnresolvedReferences(root as unknown as SchemaNode);
  if (!options.allowUnsafeKeywords) rejectUnsafeKeywords(root as unknown as SchemaNode);
  const anyOf = Array.isArray(schema['anyOf']) ? schema['anyOf'] : [];
  let errors: readonly SchemaError[] = [];
  return {
    get errors() {
      return errors;
    },
    validate(value) {
      const result = root.validate(value);
      errors = result.errors
        .map((error) => errorOf(error, schema))
        .filter(
          (error) =>
            error.keyword !== 'format' ||
            formats === undefined ||
            Object.hasOwn(formats, String(error.params['format'])),
        );
      errors = errors.toSorted((left, right) => errorPath(left).localeCompare(errorPath(right)));
      if (errors.some((error) => error.keyword === 'anyOf')) {
        for (const branch of anyOf) {
          if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) continue;
          const branchResult = compileSchema(branch as JsonSchema, compileOptions).validate(value);
          errors = [
            ...errors,
            ...branchResult.errors.map((error) =>
              errorOf(error, branch as Record<string, unknown>),
            ),
          ];
        }
      }
      return errors.length === 0;
    },
  };
}
