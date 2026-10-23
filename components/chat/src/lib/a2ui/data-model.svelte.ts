/**
 * The data model a surface binds to: a JSON value read and written by JSON
 * Pointer (RFC 6901), with A2UI's relative paths resolved against the scope of
 * a template item.
 *
 * The value is not held in a Svelte state proxy: the proxy drops a write to a
 * member whose name `Object.prototype` also has (`constructor`, `toString`),
 * because it sees the inherited name as already present. The model keeps its
 * own objects with null prototypes instead, so every member name is ordinary
 * data, and reads are made reactive by a version that every write advances.
 */
import type { A2uiJsonValue } from './types.ts';

type Container = A2uiJsonValue[] | { [key: string]: A2uiJsonValue };

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

/** A copy of a JSON value whose objects have null prototypes, as the model stores it. */
function ownCopy(value: A2uiJsonValue): A2uiJsonValue {
  if (Array.isArray(value)) return value.map(ownCopy);
  if (isContainer(value)) {
    const copy: Record<string, A2uiJsonValue> = {};
    Object.setPrototypeOf(copy, null);
    for (const [key, entry] of Object.entries(value)) {
      if (key !== '__proto__') copy[key] = ownCopy(entry);
    }
    return copy;
  }
  return value;
}

/** A plain copy of a JSON value, for a reader outside the model. */
function plainCopy(value: A2uiJsonValue): A2uiJsonValue {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (isContainer(value)) {
    const copy: Record<string, A2uiJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Assigning `__proto__` would replace the copy's prototype, not add data.
      if (key !== '__proto__') copy[key] = plainCopy(entry);
    }
    return copy;
  }
  return value;
}

/** Keys that would reach an object's prototype rather than its data. */
// Only `__proto__` reaches a prototype when assigned; `constructor` and `prototype` are ordinary
// member names, written as own properties like any other.
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['__proto__']);

function childOf(container: Container, segment: string): A2uiJsonValue | undefined {
  // Only own properties: a path must never walk into a prototype.
  if (!Object.hasOwn(container, segment)) return undefined;
  return Array.isArray(container) ? container[Number(segment)] : container[segment];
}

/**
 * Whether `segment` can name a member of `container`. An array has only its
 * indices (RFC 6901: `0` or a digit string with no leading zero); `Number`
 * would read `''` as `0`, so any other token must never reach one.
 */
function addresses(container: Container, segment: string): boolean {
  return !Array.isArray(container) || /^(?:0|[1-9]\d*)$/.test(segment);
}

function assign(container: Container, segment: string, value: A2uiJsonValue): void {
  if (Array.isArray(container)) container[Number(segment)] = value;
  else container[segment] = value;
}

/**
 * Splits a JSON Pointer into its unescaped segments. `''` is the whole
 * document; `'/'` is the member whose key is empty (RFC 6901).
 */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
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
  if (path === '' || path === '.') return scope;
  return `${scope}/${path}`;
}

/** Appends one escaped segment to a pointer. */
export function childPointer(pointer: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${pointer}/${escaped}`;
}

/** A surface's data model. Reads are reactive; writes notify `onChange`. */
export class A2uiDataModel {
  #root: A2uiJsonValue;
  /** Advanced by every write; each read depends on it, so it reruns after any change. */
  #version = $state(0);
  #generation = $state(0);
  readonly #onChange: ((value: A2uiJsonValue) => void) | undefined;

  constructor(initial: A2uiJsonValue | undefined, onChange?: (value: A2uiJsonValue) => void) {
    // Only an absent model starts empty; an explicit `null` is a value of its own.
    this.#root = ownCopy(initial === undefined ? {} : initial);
    this.#onChange = onChange;
  }

  /** The whole model, as a plain value. */
  snapshot(): A2uiJsonValue {
    void this.#version;
    return plainCopy(this.#root);
  }

  /** Replaces the whole model, as a server update does. */
  replace(value: A2uiJsonValue | undefined): void {
    this.#root = ownCopy(value === undefined ? {} : value);
    this.#version += 1;
    this.#generation += 1;
  }

  /** How many times the host has replaced the model; a write of the surface's own leaves it. */
  get generation(): number {
    return this.#generation;
  }

  /** The value at `pointer`, or `undefined` when nothing is there. */
  get(pointer: string): A2uiJsonValue | undefined {
    void this.#version;
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
    // A path through a prototype key writes nothing, rather than polluting a prototype.
    if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) return;
    const last = segments.pop();
    if (last === undefined) {
      this.#root = ownCopy(value);
    } else {
      if (!isContainer(this.#root)) this.#root = ownCopy({});
      // A token an array cannot hold anywhere on the path writes nothing.
      let probe: A2uiJsonValue | undefined = this.#root;
      for (const segment of [...segments, last]) {
        if (!isContainer(probe)) break;
        if (!addresses(probe, segment)) return;
        probe = childOf(probe, segment);
      }
      let current: A2uiJsonValue | undefined = this.#root;
      for (const segment of segments) {
        if (!isContainer(current)) break;
        if (!isContainer(childOf(current, segment))) assign(current, segment, ownCopy({}));
        current = childOf(current, segment);
      }
      if (isContainer(current)) assign(current, last, ownCopy(value));
    }
    this.#version += 1;
    this.#onChange?.(plainCopy(this.#root));
  }
}
