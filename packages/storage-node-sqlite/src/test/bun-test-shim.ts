/**
 * The part of `bun:test` the shared storage suites use, over `node:test` and `node:assert`, so they
 * run against `NodeSQLiteStorage` under `node --test`. `better-sqlite3` cannot load in Bun
 * (oven-sh/bun#4290), and the suites in `@lostgradient/storage/testing` import `bun:test`;
 * `register-bun-test-shim.ts` resolves that specifier to this module in the Node child.
 *
 * A shim rather than suites that take their runner as a parameter: five suite modules import
 * `bun:test`, and two `@lostgradient/testing` helpers they use (`module-scope-scenario`,
 * `fake-timers`) do too, while every other adapter calls the suites from `bun test` and would have
 * to pass Bun's runner through each signature. The shim keeps those callers as they are.
 *
 * It implements only what those modules use, and fails loudly on anything else: an unknown matcher
 * or `jest` member throws, and so does a test body or hook that takes a `done` callback. `toEqual`
 * is `assert.deepStrictEqual`, which is stricter than Bun's (it compares prototypes and `undefined`
 * properties), so a difference fails a case rather than passing it. `bun-test-shim.integration.ts`
 * proves each matcher fails when it should.
 */
import assert from 'node:assert/strict';
import {
  after,
  before,
  afterEach as nodeAfterEach,
  beforeEach as nodeBeforeEach,
  describe as nodeDescribe,
  it as nodeIt,
} from 'node:test';
import { inspect } from 'node:util';

type Body = () => unknown;

/** Reject a body that Bun would call with a `done` callback, which `node:test` would not. */
function withoutDone(kind: string, body: Body): () => Promise<void> {
  if (body.length > 0) {
    throw new Error(`the Node bun:test shim does not support a ${kind} that takes a done callback`);
  }
  return async () => {
    await body();
  };
}

/** Register a suite, as `bun:test`'s `describe` does. */
export function describe(name: string, body: () => void): void {
  void nodeDescribe(name, () => body());
}

/**
 * Register a test, as `bun:test`'s `it` does. A numeric `timeout` becomes `node:test`'s; leaving it
 * out (or passing `undefined`) leaves the test without one, as `node:test` does. Bun's options object
 * is not supported.
 */
export function it(name: string, body: Body, timeout?: number): void {
  if (timeout !== undefined && typeof timeout !== 'number') {
    throw new Error('the Node bun:test shim does not support a test options argument');
  }
  void nodeIt(name, { timeout }, withoutDone('test', body));
}

/** `bun:test`'s alias for {@link it}. */
export const test = it;

/** Run `body` before each test of the enclosing suite. */
export function beforeEach(body: Body): void {
  nodeBeforeEach(withoutDone('hook', body));
}

/** Run `body` after each test of the enclosing suite. */
export function afterEach(body: Body): void {
  nodeAfterEach(withoutDone('hook', body));
}

/** Run `body` once before the enclosing suite's tests. */
export function beforeAll(body: Body): void {
  before(withoutDone('hook', body));
}

/** Run `body` once after the enclosing suite's tests. */
export function afterAll(body: Body): void {
  after(withoutDone('hook', body));
}

/** Wrap `target` so that reading a member it does not define throws instead of yielding `undefined`. */
function strict<T extends object>(target: T, label: (property: string) => string): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || Object.hasOwn(object, property)) {
        return Reflect.get(object, property, receiver) as unknown;
      }
      throw new Error(`the Node bun:test shim does not implement ${label(property)}`);
    },
  });
}

/** The matchers the shared storage suites call. */
export interface Matchers {
  /** `Object.is(actual, expected)`. */
  toBe(expected: unknown): void;
  /** Deep, strict equality (`assert.deepStrictEqual`). */
  toEqual(expected: unknown): void;
  /** `actual === null`. */
  toBeNull(): void;
  /** `actual === undefined`. */
  toBeUndefined(): void;
  /** `actual !== undefined`. */
  toBeDefined(): void;
  /** `actual instanceof constructor`. */
  toBeInstanceOf(constructor: abstract new (...parameters: never[]) => unknown): void;
  /** An array or string `actual` includes `item`. */
  toContain(item: unknown): void;
  /** `actual.length === length`. */
  toHaveLength(length: number): void;
}

function matchers(actual: unknown, negated: boolean, message: string | undefined): Matchers {
  const check = (pass: boolean, description: string): void => {
    if (pass !== negated) return;
    const claim = `expected ${inspect(actual)} ${negated ? 'not ' : ''}${description}`;
    throw new assert.AssertionError({
      message: message === undefined ? claim : `${message}: ${claim}`,
    });
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `to be ${inspect(expected)}`),
    toEqual: (expected) => {
      // Node rejects an explicit `undefined` message, so it is passed only when there is one.
      const rest: [] | [string] = message === undefined ? [] : [message];
      if (negated) assert.notDeepStrictEqual(actual, expected, ...rest);
      else assert.deepStrictEqual(actual, expected, ...rest);
    },
    toBeNull: () => check(actual === null, 'to be null'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeInstanceOf: (constructor) =>
      check(actual instanceof constructor, `to be an instance of ${constructor.name}`),
    toContain: (item) => {
      if (!Array.isArray(actual) && typeof actual !== 'string') {
        throw new TypeError(`toContain needs an array or a string, got ${inspect(actual)}`);
      }
      const includes = Array.isArray(actual)
        ? actual.includes(item)
        : typeof item === 'string' && actual.includes(item);
      check(includes, `to contain ${inspect(item)}`);
    },
    toHaveLength: (length) =>
      check((actual as { length?: unknown } | null)?.length === length, `to have length ${length}`),
  };
}

/** Start an assertion on `actual`; `message` prefixes the failure, as in `bun:test`. */
export function expect(actual: unknown, message?: string): Matchers & { readonly not: Matchers } {
  const label = (property: string) => `expect().${property}`;
  const notLabel = (property: string) => `expect().not.${property}`;
  return strict(
    { ...matchers(actual, false, message), not: strict(matchers(actual, true, message), notLabel) },
    label,
  );
}

/**
 * `bun:test`'s `jest` namespace, as far as the helpers the suites use read it: `isFakeTimers`,
 * which is always false here, since the shim installs no fake timers.
 */
export const jest = strict({ isFakeTimers: () => false }, (property) => `jest.${property}`);
