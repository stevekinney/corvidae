import { expect, it } from 'bun:test';
import { activateResource, loadMoreWhenVisible } from './attachments.ts';

it('releases resources and the sentinel observer on teardown', () => {
  let released = false;
  const release = activateResource({
    activate: () => () => {
      released = true;
    },
  })(new EventTarget());
  release?.();
  expect(released).toBe(true);
  const original = globalThis.IntersectionObserver;
  let disconnected = false;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {
      disconnected = true;
    }
  } as unknown as typeof IntersectionObserver;
  try {
    const detach = loadMoreWhenVisible({ loadMore: async () => {} })({} as Element);
    detach?.();
    expect(disconnected).toBe(true);
  } finally {
    globalThis.IntersectionObserver = original;
  }
});
