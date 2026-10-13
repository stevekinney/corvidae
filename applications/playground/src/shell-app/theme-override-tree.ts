/** Immutable edits on the nested DTCG override trees, addressed by dotted token path. */

import type { JsonObject, JsonValue } from './theme-draft-types.ts';

export function splitPath(path: string): string[] {
  return path.split('.');
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getNode(tree: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = tree;
  for (const segment of splitPath(path)) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Return a copy of `tree` with `node` at `path`; siblings keep their identity. */
export function setNode(tree: JsonObject, path: string, node: JsonValue): JsonObject {
  const [head, ...rest] = splitPath(path);
  if (head === undefined) return tree;
  if (rest.length === 0) return { ...tree, [head]: node };
  const child = Object.hasOwn(tree, head) ? tree[head] : undefined;
  return { ...tree, [head]: setNode(isObject(child) ? child : {}, rest.join('.'), node) };
}

/** Return a copy without the node at `path`, pruning groups the removal leaves empty. */
export function removeNode(tree: JsonObject, path: string): JsonObject {
  const [head, ...rest] = splitPath(path);
  if (head === undefined || !Object.hasOwn(tree, head)) return tree;
  const next: JsonObject = { ...tree };
  if (rest.length === 0) {
    delete next[head];
    return next;
  }
  const child = tree[head];
  if (!isObject(child)) return tree;
  const pruned = removeNode(child, rest.join('.'));
  if (pruned === child) return tree;
  if (Object.keys(pruned).length === 0) delete next[head];
  else next[head] = pruned;
  return next;
}

export function jsonEquals(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => jsonEquals(item, right[i]));
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      jsonEquals((left as JsonObject)[key], (right as JsonObject)[key]),
  );
}
