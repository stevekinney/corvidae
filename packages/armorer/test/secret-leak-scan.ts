import { expect } from 'bun:test';

import type { ToolboxEvents } from '../src';

/**
 * Every toolbox event name. `satisfies` makes the compiler reject this object when an event is
 * added to `ToolboxEvents` and not here, so a leak scan never misses a new event.
 */
const toolboxEventNames = {
  call: true,
  complete: true,
  error: true,
  'not-found': true,
  query: true,
  search: true,
  'status:update': true,
  'execute-start': true,
  'validate-success': true,
  'validate-error': true,
  'execute-success': true,
  'execute-error': true,
  settled: true,
  'policy-denied': true,
  'tool.started': true,
  'tool.finished': true,
  'budget-exceeded': true,
  progress: true,
  'stream-start': true,
  'stream-chunk': true,
  'stream-end': true,
  'stream-error': true,
  'output-chunk': true,
  log: true,
  cancelled: true,
  'name-resolved': true,
  'loop-warning': true,
  'loop-blocked': true,
  'grant.used': true,
} as const satisfies Record<keyof ToolboxEvents, true>;

/** One recorded event: its name, the event object, and its `detail` when it has one. */
export type RecordedEvent = { type: string; event: unknown; detail: unknown };

/**
 * Subscribes to every toolbox event and returns the live list it records into, so a test can
 * scan everything Armorer emitted during a call.
 */
export function recordEveryEvent(toolbox: object): RecordedEvent[] {
  const recorded: RecordedEvent[] = [];
  const subscribe = Reflect.get(toolbox, 'addEventListener') as (
    type: string,
    listener: (event: unknown) => void,
  ) => unknown;
  for (const type of Object.keys(toolboxEventNames)) {
    subscribe.call(toolbox, type, (event: unknown) => {
      const detail =
        typeof event === 'object' && event !== null ? Reflect.get(event, 'detail') : undefined;
      recorded.push({ type, event, detail });
    });
  }
  return recorded;
}

/**
 * Returns the path of every string inside `value` that contains `needle`. It walks plain objects,
 * arrays, maps, sets, class instances, and errors, including an error's non-enumerable `message`,
 * `stack`, and `cause`, which `JSON.stringify` drops. Getters are not invoked and functions (tools)
 * are not entered.
 */
export function findPlaintext(value: unknown, needle: string): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (node.includes(needle)) found.push(path);
      return;
    }
    if (typeof node !== 'object' || node === null || seen.has(node)) return;
    seen.add(node);
    if (node instanceof Map) {
      for (const [key, item] of node) {
        visit(key, `${path}<key>`);
        visit(item, `${path}<${String(key)}>`);
      }
      return;
    }
    if (node instanceof Set) {
      for (const item of node) visit(item, `${path}<item>`);
      return;
    }
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor !== undefined && 'value' in descriptor) {
        visit(descriptor.value, `${path}.${String(key)}`);
      }
    }
  };
  visit(value, '$');
  return found;
}

/** Fails, naming each path, when `needle` occurs anywhere inside `value` (see {@link findPlaintext}). */
export function expectNoPlaintext(value: unknown, needle: string): void {
  expect(findPlaintext(value, needle)).toEqual([]);
}
