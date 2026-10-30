import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { JsonEditorSchema } from './json-editor.types.ts';

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** Marks "any element of an array" in the path from the document root to a position. */
const ITEMS = Symbol('items');
type PathSegment = string | typeof ITEMS;

/** A reference chain or combinator nesting deeper than this is treated as a cycle. */
const MAXIMUM_DEPTH = 16;

const VALUE_NODE_NAMES = new Set(['String', 'Number', 'True', 'False', 'Null']);
const ROOT_VALUE_NODE_NAMES = new Set([...VALUE_NODE_NAMES, 'Object', 'Array']);

type CompletionSite =
  | { kind: 'key'; object: SyntaxNode; tokenFrom: number; tokenTo: number; typedFrom: number }
  | { kind: 'value'; path: PathSegment[]; tokenFrom: number; tokenTo: number };

function readOwn<Value>(record: Record<string, Value> | undefined, key: string): Value | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined;
  return record[key];
}

function isSchema(candidate: unknown): candidate is JsonEditorSchema {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
}

function followPointer(root: JsonEditorSchema, reference: string): JsonEditorSchema | undefined {
  if (!reference.startsWith('#')) return undefined;
  let current: unknown = root;
  for (const rawSegment of reference.slice(1).split('/')) {
    if (rawSegment === '') continue;
    const segment = decodeURIComponent(rawSegment).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isSchema(current) && !Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = Reflect.get(current, segment);
  }
  return isSchema(current) ? current : undefined;
}

/** The schema itself plus every schema it reaches through `$ref`, `allOf`, `anyOf`, and `oneOf`. */
function expand(root: JsonEditorSchema, schema: JsonEditorSchema, depth = 0): JsonEditorSchema[] {
  if (depth > MAXIMUM_DEPTH) return [];
  const expanded: JsonEditorSchema[] = [schema];
  if (typeof schema.$ref === 'string') {
    const target = followPointer(root, schema.$ref);
    if (target !== undefined) expanded.push(...expand(root, target, depth + 1));
  }
  for (const branches of [schema.allOf, schema.anyOf, schema.oneOf]) {
    for (const branch of branches ?? []) {
      if (isSchema(branch)) expanded.push(...expand(root, branch, depth + 1));
    }
  }
  return expanded;
}

function childSchemas(
  root: JsonEditorSchema,
  schemas: readonly JsonEditorSchema[],
  segment: PathSegment,
): JsonEditorSchema[] {
  const children: JsonEditorSchema[] = [];
  for (const schema of schemas) {
    if (segment === ITEMS) {
      if (isSchema(schema.items)) children.push(...expand(root, schema.items));
      continue;
    }
    const named = readOwn(schema.properties, segment);
    const fallback = isSchema(schema.additionalProperties)
      ? schema.additionalProperties
      : undefined;
    const child = named ?? fallback;
    if (isSchema(child)) children.push(...expand(root, child));
  }
  return children;
}

function schemasAtPath(root: JsonEditorSchema, path: readonly PathSegment[]): JsonEditorSchema[] {
  let schemas = expand(root, root);
  for (const segment of path) {
    schemas = childSchemas(root, schemas, segment);
    if (schemas.length === 0) break;
  }
  return schemas;
}

function propertyKey(state: EditorState, property: SyntaxNode): string | undefined {
  const name = property.getChild('PropertyName');
  if (name === null) return undefined;
  try {
    const key: unknown = JSON.parse(state.sliceDoc(name.from, name.to));
    return typeof key === 'string' ? key : undefined;
  } catch {
    return undefined;
  }
}

function pathOf(state: EditorState, node: SyntaxNode): PathSegment[] | undefined {
  const path: PathSegment[] = [];
  for (let current: SyntaxNode | null = node; current !== null; current = current.parent) {
    if (current.name === 'Property') {
      const key = propertyKey(state, current);
      if (key === undefined) return undefined;
      path.unshift(key);
    } else if (current.name === 'Array') {
      path.unshift(ITEMS);
    }
  }
  return path;
}

function keySite(
  state: EditorState,
  object: SyntaxNode,
  position: number,
  token?: { from: number; to: number },
): CompletionSite {
  if (token !== undefined && state.sliceDoc(token.from, token.from + 1) === '"') {
    return {
      kind: 'key',
      object,
      tokenFrom: token.from,
      tokenTo: token.to,
      typedFrom: token.from + 1,
    };
  }
  const typed = /[\w$-]*$/.exec(state.sliceDoc(Math.max(0, position - 64), position));
  const typedFrom = position - (typed?.[0].length ?? 0);
  return { kind: 'key', object, tokenFrom: typedFrom, tokenTo: position, typedFrom };
}

/** Whether the document root already holds a value, so a second one does not belong beside it. */
function rootHasValue(root: SyntaxNode): boolean {
  for (let child = root.firstChild; child !== null; child = child.nextSibling) {
    if (ROOT_VALUE_NODE_NAMES.has(child.name)) return true;
  }
  return false;
}

/** The site for a value written directly at the document root, whose path is empty. */
function rootValueSite(tokenFrom: number, tokenTo: number): CompletionSite {
  return { kind: 'value', path: [], tokenFrom, tokenTo };
}

function siteAt(state: EditorState, position: number): CompletionSite | undefined {
  const node = syntaxTree(state).resolveInner(position, -1);
  const parent = node.parent;

  // An empty or whitespace-only document, where a root value is about to be written.
  if (node.name === 'JsonText' && !rootHasValue(node)) return rootValueSite(position, position);

  if (node.name === 'PropertyName' || (node.name === 'String' && parent?.name === 'PropertyName')) {
    const name = node.name === 'PropertyName' ? node : parent;
    const object = name?.parent?.parent;
    if (name === null || name === undefined || object?.name !== 'Object') return undefined;
    return keySite(state, object, position, { from: name.from, to: name.to });
  }

  if (VALUE_NODE_NAMES.has(node.name) && parent !== null) {
    if (parent.name !== 'Property' && parent.name !== 'Array' && parent.name !== 'JsonText') {
      return undefined;
    }
    const path = pathOf(state, node);
    return path === undefined
      ? undefined
      : { kind: 'value', path, tokenFrom: node.from, tokenTo: node.to };
  }

  // The cursor sits right after a delimiter, which CodeMirror's tree exposes as its own node.
  if (
    parent !== null &&
    (node.name === '{' || node.name === ',' || node.name === ':' || node.name === '[')
  ) {
    if (parent.name === 'Object') return keySite(state, parent, position);
    if (parent.name === 'Property' || parent.name === 'Array') {
      const path = pathOf(state, parent);
      return path === undefined
        ? undefined
        : { kind: 'value', path, tokenFrom: position, tokenTo: position };
    }
  }

  if (node.name === 'Object') {
    if (position <= node.from) return undefined;
    return keySite(state, node, position);
  }

  if (node.name === 'Property' || node.name === 'Array') {
    const path = pathOf(state, node);
    return path === undefined
      ? undefined
      : { kind: 'value', path, tokenFrom: position, tokenTo: position };
  }

  if (node.name === '⚠' && parent !== null) {
    const token = { from: node.from, to: Math.max(node.to, position) };
    if (parent.name === 'JsonText') {
      return rootHasValue(parent) ? undefined : rootValueSite(token.from, token.to);
    }
    if (parent.name === 'Object') return keySite(state, parent, position, token);
    if (parent.name === 'Property' || parent.name === 'Array') {
      const path = pathOf(state, node);
      return path === undefined
        ? undefined
        : { kind: 'value', path, tokenFrom: token.from, tokenTo: token.to };
    }
  }

  return undefined;
}

function existingKeys(state: EditorState, object: SyntaxNode): Set<string> {
  const keys = new Set<string>();
  for (let child = object.firstChild; child !== null; child = child.nextSibling) {
    if (child.name !== 'Property') continue;
    const key = propertyKey(state, child);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function describeType(schema: JsonEditorSchema): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  return Array.isArray(schema.type) ? schema.type.join(' | ') : undefined;
}

function keyCompletions(
  state: EditorState,
  schemas: readonly JsonEditorSchema[],
  site: Extract<CompletionSite, { kind: 'key' }>,
  root: JsonEditorSchema,
): Completion[] {
  const present = existingKeys(state, site.object);
  const completions = new Map<string, Completion>();
  for (const schema of schemas) {
    const properties = isSchema(schema.properties) ? schema.properties : {};
    for (const [name, child] of Object.entries(properties)) {
      if (present.has(name) || completions.has(name)) continue;
      const described = isSchema(child) ? (expand(root, child)[0] ?? child) : undefined;
      const detail = described === undefined ? undefined : describeType(described);
      completions.set(name, {
        label: name,
        type: 'property',
        ...(detail === undefined ? {} : { detail }),
        ...(typeof described?.description === 'string' ? { info: described.description } : {}),
        apply: (view, _completion, _from, to) => {
          const end = Math.max(to, site.tokenTo);
          const followedByColon = /^\s*:/.test(view.state.sliceDoc(end, end + 32));
          const insert = `${JSON.stringify(name)}${followedByColon ? '' : ': '}`;
          view.dispatch({
            changes: { from: site.tokenFrom, to: end, insert },
            selection: { anchor: site.tokenFrom + insert.length },
            userEvent: 'input.complete',
          });
        },
      });
    }
  }
  return [...completions.values()];
}

function valueCompletions(schemas: readonly JsonEditorSchema[]): Completion[] {
  const completions = new Map<string, Completion>();
  const add = (value: unknown, detail?: string): void => {
    const label = JSON.stringify(value);
    if (label === undefined || completions.has(label)) return;
    completions.set(label, {
      label,
      type: 'constant',
      ...(detail === undefined ? {} : { detail }),
    });
  };
  for (const schema of schemas) {
    if ('const' in schema) add(schema.const);
    for (const value of schema.enum ?? []) add(value);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes('boolean')) {
      add(true, 'boolean');
      add(false, 'boolean');
    }
    if (types.includes('null')) add(null, 'null');
  }
  return [...completions.values()];
}

/**
 * Build a CodeMirror completion source from a JSON Schema.
 *
 * Inside an object the source offers the schema's property names that the object does not yet
 * hold, and where a value belongs it offers the schema's `enum`, `const`, boolean, and null
 * values. It returns `null` wherever the schema says nothing, so it never blocks other sources.
 */
export function createSchemaCompletionSource(schema: JsonEditorSchema): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const site = siteAt(context.state, context.pos);
    if (site === undefined) return null;

    if (site.kind === 'key') {
      const path = pathOf(context.state, site.object);
      if (path === undefined) return null;
      const options = keyCompletions(context.state, schemasAtPath(schema, path), site, schema);
      const typed = site.typedFrom < context.pos;
      if (options.length === 0 || (!typed && !context.explicit)) return null;
      return { from: site.typedFrom, options, filter: true };
    }

    const options = valueCompletions(schemasAtPath(schema, site.path)).map(
      (option): Completion => ({
        ...option,
        apply: (view, _completion, _from, to) => {
          const end = Math.max(to, site.tokenTo);
          view.dispatch({
            changes: { from: site.tokenFrom, to: end, insert: option.label },
            selection: { anchor: site.tokenFrom + option.label.length },
            userEvent: 'input.complete',
          });
        },
      }),
    );
    const typed = site.tokenFrom < context.pos;
    if (options.length === 0 || (!typed && !context.explicit)) return null;
    return { from: site.tokenFrom, options, filter: true };
  };
}
