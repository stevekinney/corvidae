/**
 * The few matchers the conformance rules use, with no test runner behind them, so the checks load
 * under `bun test`, `node --test`, or no runner at all. A failed match throws a plain `Error`; the
 * rule that called it replaces that with one naming only the subject and the rule, so these
 * messages never reach a caller and carry no compared value.
 *
 * `toEqual` follows `bun:test`: own enumerable properties compared recursively, with a property
 * whose value is `undefined` treated as absent. `toMatchObject` requires only the expected
 * properties.
 *
 * @module conformance-expect
 */

function fail(): never {
  throw new Error('A conformance expectation failed.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function definedEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([, entry]) => entry !== undefined);
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return (
      left instanceof Uint8Array &&
      right instanceof Uint8Array &&
      left.length === right.length &&
      left.every((byte, index) => byte === right[index])
    );
  }
  const leftEntries = definedEntries(left);
  const rightValues = new Map(definedEntries(right));
  if (leftEntries.length !== rightValues.size) return false;
  return leftEntries.every(
    ([key, value]) => rightValues.has(key) && equal(value, rightValues.get(key)),
  );
}

function matches(actual: unknown, expected: unknown): boolean {
  if (!isRecord(expected) || Array.isArray(expected)) return equal(actual, expected);
  if (!isRecord(actual)) return false;
  return Object.keys(expected).every(
    (key) => Object.hasOwn(actual, key) && matches(actual[key], expected[key]),
  );
}

function contains(container: unknown, item: unknown): boolean {
  if (typeof container === 'string') return typeof item === 'string' && container.includes(item);
  return Array.isArray(container) && container.some((entry) => Object.is(entry, item));
}

/** The matchers of one `expect(actual)`. */
export type Expectation = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toContain(item: unknown): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeInstanceOf(constructor: abstract new (...parameters: never[]) => unknown): void;
  readonly not: {
    toBe(expected: unknown): void;
    toContain(item: unknown): void;
  };
};

/**
 * Begin a match on `actual`. The second argument, a label in `bun:test`, is accepted and unused:
 * a failure never names what it compared.
 */
export function expect(actual: unknown, _label?: string): Expectation {
  const check = (passed: boolean): void => {
    if (!passed) fail();
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected)),
    toEqual: (expected) => check(equal(actual, expected)),
    toMatchObject: (expected) => check(matches(actual, expected)),
    toContain: (item) => check(contains(actual, item)),
    toBeUndefined: () => check(actual === undefined),
    toBeDefined: () => check(actual !== undefined),
    toBeInstanceOf: (constructor) => check(actual instanceof constructor),
    not: {
      toBe: (expected) => check(!Object.is(actual, expected)),
      toContain: (item) => check(!contains(actual, item)),
    },
  };
}
