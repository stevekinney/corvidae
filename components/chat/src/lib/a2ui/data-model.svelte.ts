/**
 * The data model a surface binds to: a JSON value held in Svelte state, read
 * and written by JSON Pointer (RFC 6901), with A2UI's relative paths resolved
 * against the scope of a template item.
 */
import type { A2uiJsonValue } from './types.ts';

type Container = A2uiJsonValue[] | { [key: string]: A2uiJsonValue };

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

/** A plain copy of a (possibly proxied) JSON value. */
function plainCopy(value: A2uiJsonValue): A2uiJsonValue {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (isContainer(value)) {
    const copy: Record<string, A2uiJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = plainCopy(entry);
    return copy;
  }
  return value;
}

function childOf(container: Container, segment: string): A2uiJsonValue | undefined {
  return Array.isArray(container) ? container[Number(segment)] : container[segment];
}

function assign(container: Container, segment: string, value: A2uiJsonValue): void {
  if (Array.isArray(container)) container[Number(segment)] = value;
  else container[segment] = value;
}

/** Splits a JSON Pointer into its unescaped segments. `''` and `'/'` are the root. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * Resolves a path against a scope. An absolute path (starting with `/`)
 * ignores the scope; a relative one is appended to it.
 */
export function resolvePath(path: string, scope: string): string {
  if (path.startsWith('/')) return path;
  if (path === '' || path === '.') return scope === '' ? '/' : scope;
  return `${scope === '/' ? '' : scope}/${path}`;
}

/** Appends one escaped segment to a pointer. */
export function childPointer(pointer: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${pointer === '/' ? '' : pointer}/${escaped}`;
}

/** A surface's data model. Reads are reactive; writes notify `onChange`. */
export class A2uiDataModel {
  #root = $state<A2uiJsonValue>(null);
  readonly #onChange: ((value: A2uiJsonValue) => void) | undefined;

  constructor(initial: A2uiJsonValue | undefined, onChange?: (value: A2uiJsonValue) => void) {
    this.#root = structuredClone(initial ?? {});
    this.#onChange = onChange;
  }

  /** The whole model, as a plain value. */
  snapshot(): A2uiJsonValue {
    return plainCopy(this.#root);
  }

  /** Replaces the whole model, as a server update does. */
  replace(value: A2uiJsonValue | undefined): void {
    this.#root = structuredClone(value ?? {});
  }

  /** The value at `pointer`, or `undefined` when nothing is there. */
  get(pointer: string): A2uiJsonValue | undefined {
    let current: A2uiJsonValue | undefined = this.#root;
    for (const segment of pointerSegments(pointer)) {
      if (!isContainer(current)) return undefined;
      current = childOf(current, segment);
    }
    return current;
  }

  /** Writes `value` at `pointer`, creating objects along the way. */
  set(pointer: string, value: A2uiJsonValue): void {
    const segments = pointerSegments(pointer);
    const last = segments.pop();
    if (last === undefined) {
      this.#root = value;
    } else {
      if (!isContainer(this.#root)) this.#root = {};
      let current: A2uiJsonValue | undefined = this.#root;
      for (const segment of segments) {
        if (!isContainer(current)) break;
        if (!isContainer(childOf(current, segment))) assign(current, segment, {});
        current = childOf(current, segment);
      }
      if (isContainer(current)) assign(current, last, value);
    }
    this.#onChange?.(this.snapshot());
  }
}
