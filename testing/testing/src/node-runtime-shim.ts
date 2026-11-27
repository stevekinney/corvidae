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

function withoutDone(kind: string, body: Body): () => Promise<void> {
  if (body.length > 0)
    throw new Error(`the Node bun:test shim does not support a ${kind} that takes a done callback`);
  return async () => {
    await body();
  };
}

export function describe(name: string, body: () => void): void {
  void nodeDescribe(name, () => body());
}
export function it(name: string, body: Body, timeout?: number): void {
  if (timeout !== undefined && typeof timeout !== 'number')
    throw new Error('the Node bun:test shim does not support a test options argument');
  void nodeIt(name, { timeout }, withoutDone('test', body));
}
export const test = it;
export function beforeEach(body: Body): void {
  nodeBeforeEach(withoutDone('hook', body));
}
export function afterEach(body: Body): void {
  nodeAfterEach(withoutDone('hook', body));
}
export function beforeAll(body: Body): void {
  before(withoutDone('hook', body));
}
export function afterAll(body: Body): void {
  after(withoutDone('hook', body));
}

function strict<T extends object>(target: T, label: (property: string) => string): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol' || Object.hasOwn(object, property))
        return Reflect.get(object, property, receiver) as unknown;
      throw new Error(`the Node bun:test shim does not implement ${label(property)}`);
    },
  });
}

export interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeInstanceOf(constructor: abstract new (...parameters: never[]) => unknown): void;
  toContain(item: unknown): void;
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
      if (!Array.isArray(actual) && typeof actual !== 'string')
        throw new TypeError(`toContain needs an array or a string, got ${inspect(actual)}`);
      const includes = Array.isArray(actual)
        ? actual.includes(item)
        : typeof item === 'string' && actual.includes(item);
      check(includes, `to contain ${inspect(item)}`);
    },
    toHaveLength: (length) =>
      check((actual as { length?: unknown } | null)?.length === length, `to have length ${length}`),
  };
}

export function expect(actual: unknown, message?: string): Matchers & { readonly not: Matchers } {
  const label = (property: string) => `expect().${property}`;
  const notLabel = (property: string) => `expect().not.${property}`;
  return strict(
    { ...matchers(actual, false, message), not: strict(matchers(actual, true, message), notLabel) },
    label,
  );
}

export const jest = strict({ isFakeTimers: () => false }, (property) => `jest.${property}`);
