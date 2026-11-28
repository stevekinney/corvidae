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
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import { resolveTurnOutcome, turnStateOf } from './message/turn-outcome.ts';
import { CINDER_NOTES_METADATA_KEY } from './utilities/index.ts';

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

const { render, cleanup, fireEvent, getByRole, waitFor } = await import('@testing-library/svelte');
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

describe('Chat — a refusal held in view and the pin to the end agree on one resting position', () => {
  /** The frames a placement asks for, run when a test says the layout has settled. */
  const frames: Array<() => void> = [];
  const originalFrame = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  afterEach(() => {
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.cancelAnimationFrame = originalCancel;
    frames.length = 0;
  });
  const settle = (): void => {
    for (let guard = 0; guard < 20 && frames.length > 0; guard += 1) frames.shift()!();
  };

  // The content, from its start: the steps, then the outcome's controls at 120 to 170 and the
  // refusal line under them at 172 to 192, and 108 more of end padding; 300 in all. The transcript
  // is 400 tall at first, so nothing scrolls, and then 176 tall: its true end is at 124, which
  // would carry the controls (120) above the box (to -4) while the line (192) needs only 16.
  const CONTROLS = { top: 120, bottom: 170 };
  const LINE = { top: 172, bottom: 192 };
  const CONTENT = 300;

  test('a refusal held in view is not pushed out of the box by the pin when the box shrinks', async () => {
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = () => {};

    const asked = appendUserMessage(createConversationHistory({ id: 'held' }), 'Look up 4398');
    const called = appendToolCall(asked, { id: 'call-1', name: 'lookup', arguments: {} });
    const steps = appendToolResult(called, { callId: 'call-1', outcome: 'success', content: 'ok' });
    const lastId = steps.ids.at(-1)!;
    const last = steps.messages[lastId]!;
    const stopped = {
      ...steps,
      messages: {
        ...steps.messages,
        [lastId]: {
          ...last,
          metadata: {
            ...last.metadata,
            [CINDER_NOTES_METADATA_KEY]: [{ kind: 'stopped', id: 'stopped:r', reason: 'Stopped.' }],
          },
        },
      },
    };
    const outcome = resolveTurnOutcome(stopped, { running: false, now: 0 });
    const { container } = render(Chat, {
      id: 'held',
      variant: 'transcript',
      conversation: outcome.conversation,
      messageTurnState: (message: Parameters<typeof turnStateOf>[1]) =>
        turnStateOf(outcome, message),
      onDiscardTurn: () => false,
    });
    const timeline = container.querySelector<HTMLElement>('.chat-timeline')!;
    const layout = { clientHeight: 400, scrollTop: 0 };
    const scrollHeight = (): number => Math.max(CONTENT, layout.clientHeight);
    Object.defineProperty(timeline, 'clientHeight', { get: () => layout.clientHeight });
    Object.defineProperty(timeline, 'scrollHeight', { get: scrollHeight });
    Object.defineProperty(timeline, 'scrollTop', {
      get: () => layout.scrollTop,
      set: (value: number) => {
        layout.scrollTop = Math.min(Math.max(value, 0), scrollHeight() - layout.clientHeight);
      },
    });
    timeline.scrollTo = ((options: ScrollToOptions) => {
      timeline.scrollTop = options.top ?? 0;
    }) as typeof timeline.scrollTo;
    timeline.getBoundingClientRect = () =>
      ({ top: 0, bottom: layout.clientHeight, height: layout.clientHeight }) as DOMRect;
    const rectOf = (edges: { top: number; bottom: number }) => () =>
      ({
        top: edges.top - layout.scrollTop,
        bottom: edges.bottom - layout.scrollTop,
        height: edges.bottom - edges.top,
      }) as DOMRect;

    await fireEvent.click(getByRole(container, 'button', { name: 'Discard' }));
    const line = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.chat-turn-command-failure');
      if (found === null) throw new Error('No refusal yet.');
      return found;
    });
    const controls = container.querySelector<HTMLElement>('.chat-turn-outcome')!;
    controls.getBoundingClientRect = rectOf(CONTROLS);
    line.getBoundingClientRect = rectOf(LINE);
    settle();
    // Everything is in view, so nothing has moved.
    expect(layout.scrollTop).toBe(0);

    // The box shrinks with the transcript resting at its end: every observer of it is told.
    layout.clientHeight = 176;
    for (const entry of observers) {
      if (entry.targets.includes(timeline)) entry.callback();
    }
    settle();

    // The line is at the end of the reading box and the controls are inside it: not the true end
    // (124), which would carry the controls above the box.
    expect(layout.scrollTop).toBe(LINE.bottom - layout.clientHeight);
    expect(CONTROLS.top - layout.scrollTop).toBeGreaterThanOrEqual(0);
    expect(LINE.bottom - layout.scrollTop).toBeLessThanOrEqual(layout.clientHeight);
  });
});
