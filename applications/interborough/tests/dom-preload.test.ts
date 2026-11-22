import { describe, expect, test } from 'bun:test';

describe('the DOM preload (tests/setup.ts)', () => {
  test('installs a document and a window', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
  });

  // happy-dom's XMLHttpRequest answers a synchronous request with a child process that makes a real
  // HTTP request to http://localhost/…, and the source-map support Playwright bundles takes a
  // process that has both `window` and `XMLHttpRequest` for a browser, so it read each stack frame
  // that way: a connection to a closed port, printed as an `AggregateError` from a socket, in a
  // lane that must reach no network (COR-2643).
  test('leaves no XMLHttpRequest global, so nothing in this lane can reach a network by it', () => {
    expect(Reflect.has(globalThis, 'XMLHttpRequest')).toBe(false);
  });
});
