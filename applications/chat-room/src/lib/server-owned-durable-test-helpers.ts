import { expect } from 'bun:test';
import {
  EngineRetirementError,
  RuntimeDisposedDuringBuildError,
  UnrecognisedDurableSlotError,
  durableRuntime,
  forgetDurableRuntime,
} from './server-owned-durable.ts';
import { disposeServerOwnedRuntime, serverOwnedRuntime } from './server-owned-runtime.ts';
import { installServerOwnedTestIsolation } from './server-owned-test-lock.ts';

export {
  EngineRetirementError,
  RuntimeDisposedDuringBuildError,
  UnrecognisedDurableSlotError,
  disposeServerOwnedRuntime,
  durableRuntime,
  forgetDurableRuntime,
  serverOwnedRuntime,
};

/**
 * The durable engine holds the process open until `shutdown()`, so every test
 * here disposes — including on the failure path, via `afterEach`. A test that
 * throws before its cleanup would otherwise hang the whole `bun test` run
 * rather than fail it, which is the worst possible way to learn this.
 */
export function installServerOwnedDurableTestIsolation(): void {
  installServerOwnedTestIsolation(async () => {
    await disposeServerOwnedRuntime();
    forgetDurableRuntime();
  });
}

export async function expectRejectsWith(
  promise: Promise<unknown>,
  check: (error: unknown) => void,
): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    check(error);
  }
  expect(rejected).toBe(true);
}
