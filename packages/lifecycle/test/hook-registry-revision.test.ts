/**
 * `HookRegistry.revision` — the monotonic membership counter COR-581's
 * effective-context epoch digests the hook plan by.
 *
 * It counts membership changes, not behavior: the question a
 * reconciliation boundary asks is "has the set of registered handlers
 * changed since I last looked", and these tests pin exactly that, including
 * the cases that must NOT advance it.
 */
import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../src/hooks/hook-registry.ts';

interface TestHooks {
  [key: string]: (...args: never[]) => unknown;
  alpha: () => void;
  beta: () => void;
}

describe('HookRegistry.revision', () => {
  it('starts at zero on a fresh registry', () => {
    expect(new HookRegistry<TestHooks>().revision).toBe(0);
  });

  it('advances by exactly one per registration', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('alpha', () => {});
    expect(registry.revision).toBe(1);
    registry.on('alpha', () => {});
    expect(registry.revision).toBe(2);
    registry.on('beta', () => {});
    expect(registry.revision).toBe(3);
  });

  it('advances on unregistration', () => {
    const registry = new HookRegistry<TestHooks>();
    const off = registry.on('alpha', () => {});
    expect(registry.revision).toBe(1);
    off();
    expect(registry.revision).toBe(2);
  });

  it('does not advance when the same unregister is called twice', () => {
    // Idempotent unregistration must not look like two distinct plan
    // changes to a boundary comparing revisions.
    const registry = new HookRegistry<TestHooks>();
    const off = registry.on('alpha', () => {});
    off();
    const afterFirst = registry.revision;
    off();
    off();
    expect(registry.revision).toBe(afterFirst);
  });

  it('does not advance when clearing a hook name that has no handlers', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.clear('alpha');
    expect(registry.revision).toBe(0);
  });

  it('does not advance when clearing an already-empty registry', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.clear();
    expect(registry.revision).toBe(0);
  });

  it('advances once for a clear that actually removed handlers', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('alpha', () => {});
    registry.on('beta', () => {});
    const before = registry.revision;
    registry.clear();
    expect(registry.revision).toBe(before + 1);
  });

  it('never decrements across a register/unregister cycle', () => {
    // Monotonic by contract: a boundary that saw revision N must never see
    // N again for a different plan.
    const registry = new HookRegistry<TestHooks>();
    const seen: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const off = registry.on('alpha', () => {});
      seen.push(registry.revision);
      off();
      seen.push(registry.revision);
    }
    const sorted = [...seen].sort((a, b) => a - b);
    expect(seen).toEqual(sorted);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not advance when a handler merely runs', () => {
    // The revision tracks membership, not invocation or captured state.
    const registry = new HookRegistry<TestHooks>();
    registry.on('alpha', () => {});
    const before = registry.revision;
    void registry.run('alpha');
    expect(registry.revision).toBe(before);
  });
});
