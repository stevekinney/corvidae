import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { keepPinnedThroughResize } from './keep-pinned-through-resize.ts';

setupHappyDom();

let resizeCallback: (() => void) | undefined;
const original = globalThis.ResizeObserver;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resizeCallback = callback;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterAll(() => {
  globalThis.ResizeObserver = original;
});

afterEach(() => {
  resizeCallback = undefined;
});

/** A transcript of `scrollHeight` content in a box of `clientHeight`, scrolled to `scrollTop`. */
function transcriptOf(layout: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const transcript = document.createElement('div');
  const state = { ...layout };
  Object.defineProperty(transcript, 'scrollHeight', { get: () => state.scrollHeight });
  Object.defineProperty(transcript, 'clientHeight', { get: () => state.clientHeight });
  Object.defineProperty(transcript, 'scrollTop', {
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
  });
  // What the page does to put the transcript at its end.
  const repin = (): void => {
    state.scrollTop = state.scrollHeight - state.clientHeight;
  };
  return { transcript, state, repin };
}

describe('keepPinnedThroughResize', () => {
  test('a transcript at its end is put back at its end when its box shrinks', () => {
    const { transcript, state, repin } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    const stop = keepPinnedThroughResize(transcript, repin);
    // A notice grows the composer: the box is 80 pixels shorter and nothing scrolls.
    state.clientHeight = 320;
    resizeCallback?.();
    expect(state.scrollTop).toBe(680);
    // The same transcript shrinks again (a keyboard): it rests at its end again.
    state.clientHeight = 120;
    resizeCallback?.();
    expect(state.scrollTop).toBe(880);
    stop();
  });

  test('a transcript that fit and no longer does is put at its end', () => {
    const { transcript, state, repin } = transcriptOf({
      scrollHeight: 380,
      clientHeight: 400,
      scrollTop: 0,
    });
    const stop = keepPinnedThroughResize(transcript, repin);
    state.clientHeight = 300;
    resizeCallback?.();
    expect(state.scrollTop).toBe(80);
    stop();
  });

  test('a person who scrolled up is not moved when the box shrinks', () => {
    const { transcript, state, repin } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    const stop = keepPinnedThroughResize(transcript, repin);
    state.scrollTop = 480;
    transcript.dispatchEvent(new Event('scroll'));
    state.clientHeight = 320;
    resizeCallback?.();
    expect(state.scrollTop).toBe(480);
    // Nor on a later shrink, and not by a resize that happens to leave them near the end.
    state.clientHeight = 300;
    resizeCallback?.();
    expect(state.scrollTop).toBe(480);
    stop();
  });

  test('a person who scrolled up and came back to the end is followed again', () => {
    const { transcript, state, repin } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    const stop = keepPinnedThroughResize(transcript, repin);
    state.scrollTop = 300;
    transcript.dispatchEvent(new Event('scroll'));
    state.scrollTop = 600;
    transcript.dispatchEvent(new Event('scroll'));
    state.clientHeight = 320;
    resizeCallback?.();
    expect(state.scrollTop).toBe(680);
    stop();
  });

  test('the page can refuse the move, and then the transcript is not followed after', () => {
    const { transcript, state } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    let asked = 0;
    const stop = keepPinnedThroughResize(transcript, () => {
      asked += 1;
    });
    state.clientHeight = 320;
    resizeCallback?.();
    expect(asked).toBe(1);
    expect(state.scrollTop).toBe(600);
    // It is not at its end now, and nothing says it came back: it is left alone.
    state.clientHeight = 300;
    resizeCallback?.();
    expect(asked).toBe(1);
    stop();
  });

  test('stops looking once the function it returns is called, and needs no ResizeObserver', () => {
    const { transcript, state, repin } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, repin)();
    state.clientHeight = 320;
    state.scrollTop = 600;
    transcript.dispatchEvent(new Event('scroll'));
    expect(state.scrollTop).toBe(600);

    const resizes = globalThis.ResizeObserver;
    // @ts-expect-error A host with no ResizeObserver: nothing is watched, nothing is thrown.
    globalThis.ResizeObserver = undefined;
    try {
      expect(() => keepPinnedThroughResize(transcript, repin)()).not.toThrow();
    } finally {
      globalThis.ResizeObserver = resizes;
    }
  });
});
