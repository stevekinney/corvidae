import { afterEach, beforeEach } from 'bun:test';

const TEST_LOCK = Symbol.for('cinder.chat-room.server-owned.test-lock');

type TestLockState = {
  tail: Promise<void>;
};

type TestLockHost = typeof globalThis & {
  [TEST_LOCK]?: TestLockState | undefined;
};

function testLockState(): TestLockState {
  const host: TestLockHost = globalThis;
  const existing = host[TEST_LOCK];
  if (existing !== undefined) return existing;
  const created = { tail: Promise.resolve() };
  host[TEST_LOCK] = created;
  return created;
}

export function installServerOwnedTestIsolation(reset: () => Promise<void>): void {
  let releaseCurrent: (() => void) | undefined;

  beforeEach(async () => {
    const state = testLockState();
    const previous = state.tail;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    state.tail = previous.then(() => current);
    await previous;
    try {
      await reset();
    } catch (cause) {
      releaseCurrent?.();
      releaseCurrent = undefined;
      throw cause;
    }
  });

  afterEach(async () => {
    try {
      await reset();
    } finally {
      releaseCurrent?.();
      releaseCurrent = undefined;
    }
  });
}
