/**
 * COR-2725: a transcript that rests at its end stays at its end when its own box shrinks with no
 * message arriving (a notice that grows the composer, a keyboard, a smaller window). Only a new
 * message pinned it before, so the last row was left in the fade at the end of the transcript.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';

setupHappyDom();

/** The observers Chat makes, by what each watches, so a test can say a box changed size. */
const observers: Array<{ readonly callback: () => void; readonly targets: Element[] }> = [];
class RecordingResizeObserver {
  readonly #entry: { readonly callback: () => void; readonly targets: Element[] };
  constructor(callback: () => void) {
    this.#entry = { callback, targets: [] };
    observers.push(this.#entry);
  }
  observe(target: Element): void {
    this.#entry.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { render, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  observers.length = 0;
});

/** A Chat whose transcript has the scroll geometry `layout` says (happy-dom has none of its own). */
function renderChat(layout: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  const asked = appendUserMessage(createConversationHistory({ id: 'pinned' }), 'Look up 4398');
  const conversation = appendAssistantMessage(asked, 'It shipped on Monday.');
  const view = render(Chat, { id: 'pinned', variant: 'transcript', conversation });
  const timeline = view.container.querySelector<HTMLElement>('.chat-timeline');
  if (timeline === null) throw new Error('Chat drew no transcript.');
  const state = { ...layout };
  Object.defineProperty(timeline, 'scrollHeight', {
    configurable: true,
    get: () => state.scrollHeight,
  });
  Object.defineProperty(timeline, 'clientHeight', {
    configurable: true,
    get: () => state.clientHeight,
  });
  Object.defineProperty(timeline, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
  });
  timeline.scrollTo = ((options: ScrollToOptions) => {
    state.scrollTop = Math.min(options.top ?? 0, state.scrollHeight - state.clientHeight);
  }) as typeof timeline.scrollTo;
  /** The box changed size, as the browser tells every observer that watches the transcript. */
  const boxChanged = (): void => {
    for (const entry of observers) {
      if (entry.targets.includes(timeline)) entry.callback();
    }
  };
  return { timeline, state, boxChanged };
}

describe('Chat — a transcript at its end stays at its end when its box shrinks', () => {
  test('a notice that grows the composer leaves the last row clear of the end', () => {
    const { state, boxChanged } = renderChat({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    state.clientHeight = 320;
    boxChanged();
    expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight);
    // A keyboard on top of it.
    state.clientHeight = 150;
    boxChanged();
    expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight);
  });

  test('a person who scrolled up is not moved when the notice appears', () => {
    const { timeline, state, boxChanged } = renderChat({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    state.scrollTop = 480;
    timeline.dispatchEvent(new Event('scroll'));
    state.clientHeight = 320;
    boxChanged();
    expect(state.scrollTop).toBe(480);
  });
});
