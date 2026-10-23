/**
 * The checks a surface's component graph and bindings must pass beyond its catalog's schemas
 * (COR-837): the graph is bounded, acyclic, and (when it must be whole) rooted with no dangling
 * reference or orphan; a binding is a well-formed JSON Pointer; and every action a component
 * raises is one the surface declares. All of it treats the components as untrusted.
 *
 * @experimental
 * @module graph
 */

import type { A2uiCatalog } from './catalogs.ts';

/** One reason a proposal was refused. */
export interface A2uiIssue {
  /** Where the problem is, as a JSON Pointer into the proposal (`/messages/1/...`) or a component id. */
  readonly path: string;
  readonly message: string;
}

/** The most components one surface may hold. */
export const A2UI_MAX_COMPONENTS = 500;
/** The deepest a component tree may nest. */
export const A2UI_MAX_DEPTH = 32;
/** The longest JSON Pointer a binding or data-model path may be, in characters. */
export const A2UI_MAX_POINTER_LENGTH = 512;
/** The most reference segments a JSON Pointer may have. */
export const A2UI_MAX_POINTER_SEGMENTS = 32;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The reference tokens of an absolute JSON Pointer (RFC 6901), or `undefined` when it is not
 * one. `~0` and `~1` are the only escapes; `__proto__` is refused so a pointer cannot reach a
 * prototype; a pointer over the length or segment bounds is refused.
 */
export function pointerSegments(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/') || pointer.length > A2UI_MAX_POINTER_LENGTH) return undefined;
  const raw = pointer.slice(1).split('/');
  if (raw.length > A2UI_MAX_POINTER_SEGMENTS) return undefined;
  const segments: string[] = [];
  for (const token of raw) {
    if (/~(?![01])/u.test(token)) return undefined;
    const segment = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (segment === '__proto__') return undefined;
    segments.push(segment);
  }
  return segments;
}

/** The component ids a component refers to, through the properties its catalog marks as references. */
function referencesOf(component: JsonObject, referenceKeys: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      found.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (isRecord(value)) {
      if (typeof value['componentId'] === 'string') found.push(value['componentId']);
      for (const [key, inner] of Object.entries(value)) {
        if (referenceKeys.has(key)) collect(inner);
      }
    }
  };
  for (const [key, value] of Object.entries(component)) {
    if (referenceKeys.has(key)) collect(value);
  }
  return found;
}

/** What {@link checkGraph} found beyond hard errors. */
export interface A2uiGraphReport {
  readonly issues: readonly A2uiIssue[];
  /** Ids referenced but not (yet) defined. */
  readonly dangling: readonly string[];
  /** Whether a component with the id `root` exists. */
  readonly rooted: boolean;
}

/**
 * Checks the whole component list. Always an error: more components than the bound, a cycle, a
 * tree deeper than the bound, a self-reference. With `complete`: a missing `root`, a dangling
 * reference, or a component `root` does not reach. Without it those are reported, not refused,
 * because A2UI sends components progressively and `root` may arrive last.
 */
export function checkGraph(
  components: readonly JsonObject[],
  catalog: A2uiCatalog,
  complete: boolean,
): A2uiGraphReport {
  const issues: A2uiIssue[] = [];
  if (components.length > A2UI_MAX_COMPONENTS) {
    issues.push({
      path: '/components',
      message: `A surface holds at most ${A2UI_MAX_COMPONENTS} components; this one has ${components.length}.`,
    });
    return { issues, dangling: [], rooted: false };
  }
  const edges = new Map<string, string[]>();
  for (const component of components) {
    edges.set(String(component['id']), referencesOf(component, catalog.referenceKeys));
  }
  const dangling = new Set<string>();
  for (const [id, targets] of edges) {
    for (const target of targets) {
      if (target === id) issues.push({ path: id, message: `Component "${id}" refers to itself.` });
      if (!edges.has(target)) dangling.add(target);
    }
  }

  // Iterative depth-first search: colors detect a cycle, and the depth bound stops a deep chain
  // before it can exhaust anything.
  const state = new Map<string, 'open' | 'done'>();
  const depth = new Map<string, number>();
  let cyclic = false;
  let tooDeep = false;
  for (const start of edges.keys()) {
    if (state.has(start)) continue;
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    state.set(start, 'open');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = edges.get(frame.id) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (!edges.has(target)) continue;
        const seen = state.get(target);
        if (seen === 'open') {
          if (!cyclic) {
            issues.push({
              path: frame.id,
              message: `Components form a cycle through "${frame.id}" and "${target}".`,
            });
          }
          cyclic = true;
        } else if (seen === undefined) {
          state.set(target, 'open');
          stack.push({ id: target, next: 0 });
          if (stack.length > A2UI_MAX_DEPTH + 1) {
            tooDeep = true;
            stack.length = 0;
          }
        }
      } else {
        state.set(frame.id, 'done');
        let deepest = 0;
        for (const target of targets) deepest = Math.max(deepest, (depth.get(target) ?? 0) + 1);
        depth.set(frame.id, deepest);
        if (deepest > A2UI_MAX_DEPTH) tooDeep = true;
        stack.pop();
      }
    }
    if (tooDeep) break;
  }
  if (tooDeep) {
    issues.push({
      path: '/components',
      message: `A component tree nests at most ${A2UI_MAX_DEPTH} levels deep.`,
    });
  }

  const rooted = edges.has('root');
  if (complete && !cyclic && !tooDeep) {
    if (!rooted)
      issues.push({ path: '/components', message: 'The surface has no "root" component.' });
    for (const id of dangling) {
      issues.push({ path: id, message: `A component refers to "${id}", which is not defined.` });
    }
    if (rooted) {
      const reached = new Set<string>(['root']);
      const queue = ['root'];
      for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
        for (const target of edges.get(id) ?? []) {
          if (edges.has(target) && !reached.has(target)) {
            reached.add(target);
            queue.push(target);
          }
        }
      }
      for (const id of edges.keys()) {
        if (!reached.has(id)) {
          issues.push({ path: id, message: `Component "${id}" is not reachable from "root".` });
        }
      }
    }
  }
  return { issues, dangling: [...dangling], rooted };
}

/**
 * Checks every data binding in the components: an object whose only key is `path`. An absolute
 * binding (leading `/`) must be a well-formed pointer. A relative one (a template's item scope)
 * must be made of well-formed segments.
 */
export function checkBindings(components: readonly JsonObject[]): A2uiIssue[] {
  const issues: A2uiIssue[] = [];
  const visit = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${where}/${index}`));
      return;
    }
    if (!isRecord(value)) return;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'path' && typeof value['path'] === 'string') {
      const path = value['path'];
      const absolute = path.startsWith('/');
      if (pointerSegments(absolute ? path : `/${path}`) === undefined || path === '') {
        issues.push({
          path: where,
          message: `"${path.slice(0, 80)}" is not a valid JSON Pointer.`,
        });
      }
      return;
    }
    for (const [key, inner] of Object.entries(value)) visit(inner, `${where}/${key}`);
  };
  for (const component of components) visit(component, String(component['id']));
  return issues;
}

/** The names of the server events components raise (`action.event.name`), by component id. */
export function eventNamesOf(components: readonly JsonObject[]): Map<string, string[]> {
  const byComponent = new Map<string, string[]>();
  const visit = (value: unknown, id: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, id));
      return;
    }
    if (!isRecord(value)) return;
    const event = value['event'];
    if (isRecord(event) && typeof event['name'] === 'string') {
      byComponent.set(id, [...(byComponent.get(id) ?? []), event['name']]);
    }
    for (const inner of Object.values(value)) visit(inner, id);
  };
  for (const component of components) visit(component, String(component['id']));
  return byComponent;
}

/**
 * Every event a component raises must be one of the surface's declared actions: a generated
 * component can raise only what the host admitted, never a name of its own choosing.
 */
export function checkEvents(
  components: readonly JsonObject[],
  declared: ReadonlySet<string>,
): A2uiIssue[] {
  const issues: A2uiIssue[] = [];
  for (const [id, names] of eventNamesOf(components)) {
    for (const name of names) {
      if (!declared.has(name)) {
        issues.push({
          path: id,
          message: `Component "${id}" raises "${name}", which is not one of the surface's declared actions.`,
        });
      }
    }
  }
  return issues;
}
