/**
 * A2UI v0.9.1's server-to-client messages as Bureau reads and writes them (COR-837): the four
 * message types, a parser that classifies untrusted input, the fold of a batch of messages into a
 * surface's components and data model, and the projection of a stored surface back into the
 * messages that rebuild it.
 *
 * The names and fields are those of the vendored `server_to_client.json`
 * (`server-to-client.schema.json`); `messages.test.ts` round-trips each message through it.
 *
 * @experimental A2UI support is pinned to v0.9.1 and may change until a stable A2UI 1.0 review.
 * @module messages
 */

import type {
  InteractiveSurface,
  InteractiveSurfaceJsonObject,
  InteractiveSurfaceJsonValue,
} from '../interactive-surface/types.ts';
import { A2UI_SPECIFICATION_VERSION } from './catalogs.ts';
import { pointerSegments, type A2uiIssue } from './graph.ts';

/** A component as a surface holds it: a JSON object with at least an `id` and a `component`. */
export type A2uiComponent = InteractiveSurfaceJsonObject;

/** `createSurface`: begins a surface with a catalog. @experimental */
export interface A2uiCreateSurfaceMessage {
  readonly version: 'v0.9' | 'v0.9.1';
  readonly createSurface: {
    readonly surfaceId: string;
    readonly catalogId: string;
    readonly theme?: InteractiveSurfaceJsonObject | undefined;
    readonly sendDataModel?: boolean | undefined;
  };
}

/** `updateComponents`: adds components to a surface, or replaces those with the same ids. @experimental */
export interface A2uiUpdateComponentsMessage {
  readonly version: 'v0.9' | 'v0.9.1';
  readonly updateComponents: {
    readonly surfaceId: string;
    readonly components: readonly A2uiComponent[];
  };
}

/** `updateDataModel`: sets (or, with no `value`, removes) the value at `path`. @experimental */
export interface A2uiUpdateDataModelMessage {
  readonly version: 'v0.9' | 'v0.9.1';
  readonly updateDataModel: {
    readonly surfaceId: string;
    readonly path?: string | undefined;
    readonly value?: InteractiveSurfaceJsonValue | undefined;
  };
}

/** `deleteSurface`: ends a surface. @experimental */
export interface A2uiDeleteSurfaceMessage {
  readonly version: 'v0.9' | 'v0.9.1';
  readonly deleteSurface: { readonly surfaceId: string };
}

/** Any A2UI v0.9.1 server-to-client message. @experimental */
export type A2uiServerMessage =
  | A2uiCreateSurfaceMessage
  | A2uiUpdateComponentsMessage
  | A2uiUpdateDataModelMessage
  | A2uiDeleteSurfaceMessage;

/** The message kinds, as the key each message carries. */
export type A2uiMessageKind =
  'createSurface' | 'updateComponents' | 'updateDataModel' | 'deleteSurface';

/** The `$defs` entry of `server_to_client.json` that defines each kind. */
export const A2UI_MESSAGE_DEFINITIONS: Readonly<Record<A2uiMessageKind, string>> = {
  createSurface: 'CreateSurfaceMessage',
  updateComponents: 'UpdateComponentsMessage',
  updateDataModel: 'UpdateDataModelMessage',
  deleteSurface: 'DeleteSurfaceMessage',
};

/** The most messages one batch may hold. */
export const A2UI_MAX_BATCH = 64;

const KINDS = Object.keys(A2UI_MESSAGE_DEFINITIONS) as A2uiMessageKind[];

/** What {@link classifyMessage} read from one message. */
export interface ClassifiedMessage {
  readonly kind: A2uiMessageKind;
  readonly surfaceId: string;
  readonly message: Record<string, unknown>;
}

/** The kind and surface of an untrusted message, or why it is not one. */
export function classifyMessage(message: unknown, index: number): ClassifiedMessage | A2uiIssue {
  const where = `/messages/${index}`;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { path: where, message: 'An A2UI message must be a JSON object.' };
  }
  const record = message as Record<string, unknown>;
  const kinds = KINDS.filter((kind) => Object.hasOwn(record, kind));
  if (kinds.length !== 1) {
    return {
      path: where,
      message: `An A2UI message carries exactly one of ${KINDS.join(', ')}.`,
    };
  }
  const kind = kinds[0]!;
  const body = record[kind];
  const surfaceId =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['surfaceId']
      : undefined;
  if (typeof surfaceId !== 'string' || surfaceId === '') {
    return { path: `${where}/${kind}/surfaceId`, message: 'surfaceId must be a non-empty string.' };
  }
  return { kind, surfaceId, message: record };
}

/** Whether {@link classifyMessage} produced a message and not an issue. */
export function isClassified(value: ClassifiedMessage | A2uiIssue): value is ClassifiedMessage {
  return 'kind' in value;
}

/** The deepest a message, a data-model value, or a context may nest. */
export const A2UI_MAX_JSON_DEPTH = 48;

const MAX_JSON_DEPTH = 64;

/**
 * Whether a value nests deeper than `limit` levels. Iterative, so a hostile depth cannot overflow
 * the stack; it stops as soon as the limit is passed, so a cyclic value terminates too.
 */
export function jsonDepthExceeds(value: unknown, limit: number): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item.value !== 'object' || item.value === null) continue;
    if (item.depth > limit) return true;
    for (const inner of Object.values(item.value)) {
      stack.push({ value: inner, depth: item.depth + 1 });
    }
  }
  return false;
}

/** Why a value is not JSON a data model can hold, or `undefined` when it is. */
export function jsonProblemOf(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_JSON_DEPTH) return 'nests too deeply';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) ? undefined : 'is not a finite number';
  if (Array.isArray(value)) {
    for (const entry of value) {
      const problem = jsonProblemOf(entry, depth + 1);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return 'is not a plain object';
    }
    for (const entry of Object.values(value)) {
      const problem = jsonProblemOf(entry, depth + 1);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  return 'is not JSON';
}

/** The outcome of changing a data model. */
export type DataModelChange =
  | { readonly ok: true; readonly data: InteractiveSurfaceJsonValue }
  | { readonly ok: false; readonly message: string };

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/**
 * Applies an `updateDataModel` to a data model and returns the whole of the result; the input is
 * not changed. `path` is a JSON Pointer; omitted or `/` it is the whole model. A `value` sets the
 * location (creating objects on the way); no `value` removes it. An array index must exist, or
 * equal the length to append. The same inputs always give the same model.
 */
export function changeDataModel(
  current: InteractiveSurfaceJsonValue,
  path: string | undefined,
  value: InteractiveSurfaceJsonValue | undefined,
): DataModelChange {
  const problem = value === undefined ? undefined : jsonProblemOf(value);
  if (problem !== undefined) return { ok: false, message: `The value ${problem}.` };
  const segments = pointerSegments(path === undefined || path === '/' ? '' : path);
  if (segments === undefined)
    return { ok: false, message: `"${String(path).slice(0, 80)}" is not a valid JSON Pointer.` };
  if (segments.length === 0) {
    return { ok: true, data: value === undefined ? {} : structuredClone(value) };
  }
  const root: unknown = current === null ? {} : structuredClone(current);
  if (!isContainer(root))
    return { ok: false, message: 'The data model is not an object or an array.' };
  let container: Record<string, unknown> | unknown[] = root;
  for (const [position, segment] of segments.entries()) {
    const last = position === segments.length - 1;
    if (Array.isArray(container)) {
      const index = /^(0|[1-9]\d*)$/u.test(segment) ? Number(segment) : -1;
      if (
        index < 0 ||
        index > container.length ||
        (index === container.length && value === undefined)
      ) {
        return { ok: false, message: `"${segment}" is not an index of the array at this path.` };
      }
      if (last) {
        if (value === undefined) container.splice(index, 1);
        else container[index] = structuredClone(value);
        break;
      }
      let next: unknown = container[index];
      if (next === undefined || next === null) {
        next = {};
        container[index] = next;
      }
      if (!isContainer(next))
        return {
          ok: false,
          message: `The path crosses a value that is not an object or an array, at "${segment}".`,
        };
      container = next;
    } else {
      if (last) {
        if (value === undefined) delete container[segment];
        else container[segment] = structuredClone(value);
        break;
      }
      const record = container;
      let next: unknown = Object.hasOwn(record, segment) ? record[segment] : undefined;
      if (next === undefined || next === null) {
        next = {};
        record[segment] = next;
      }
      if (!isContainer(next))
        return {
          ok: false,
          message: `The path crosses a value that is not an object or an array, at "${segment}".`,
        };
      container = next;
    }
  }
  return { ok: true, data: root as InteractiveSurfaceJsonValue };
}

/** Folds `updateComponents` into a component list: a component replaces the one with its id, in place; a new one is appended. */
export function mergeComponents(
  current: readonly A2uiComponent[],
  incoming: readonly A2uiComponent[],
): A2uiComponent[] {
  const merged = [...current];
  const positions = new Map(merged.map((component, index) => [component['id'], index] as const));
  for (const component of incoming) {
    const position = positions.get(component['id']);
    if (position === undefined) {
      positions.set(component['id'], merged.length);
      merged.push(component);
    } else {
      merged[position] = component;
    }
  }
  return merged;
}

/**
 * The messages that rebuild a stored `a2ui` surface from nothing: its `createSurface`, then its
 * components and data model when it has any. A reconnecting client is sent these, and a replay
 * from the surface's `eventCursor` continues from them. Another kind of surface yields none.
 *
 * @experimental
 */
export function a2uiMessagesOf(surface: InteractiveSurface): A2uiServerMessage[] {
  const representation = surface.representation;
  if (representation === null || representation.kind !== 'a2ui') return [];
  const version = A2UI_SPECIFICATION_VERSION;
  const messages: A2uiServerMessage[] = [
    {
      version,
      createSurface: {
        surfaceId: surface.surfaceId,
        catalogId: representation.catalogId,
        ...(representation.theme === undefined ? {} : { theme: representation.theme }),
        ...(representation.sendDataModel === undefined
          ? {}
          : { sendDataModel: representation.sendDataModel }),
      },
    },
  ];
  if (representation.components.length > 0) {
    messages.push({
      version,
      updateComponents: { surfaceId: surface.surfaceId, components: representation.components },
    });
  }
  // Always, even for `null`: the renderer starts an absent model as `{}` and keeps an explicit
  // `null`, and the adapter stores an absent model as `{}`, so a stored `null` is explicit.
  messages.push({
    version,
    updateDataModel: { surfaceId: surface.surfaceId, path: '/', value: surface.data },
  });
  return messages;
}
