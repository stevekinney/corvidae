/**
 * COR-2725: a transcript that rests at its end stays at its end when its own box shrinks with no
 * message arriving (a notice that grows the composer, a keyboard, a smaller window). Only a new
 * message pinned it before, so the last row was left in the fade at the end of the transcript.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

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
function renderChat(
  layout: { scrollHeight: number; clientHeight: number; scrollTop: number },
  props: Record<string, unknown> = {},
  empty = false,
) {
  const asked = appendUserMessage(createConversationHistory({ id: 'pinned' }), 'Look up 4398');
  const conversation = empty
    ? createConversationHistory({ id: 'pinned' })
    : appendAssistantMessage(asked, 'It shipped on Monday.');
  const view = render(Chat, { id: 'pinned', variant: 'transcript', conversation, ...props });
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
    // As a browser clamps it: a transcript that fits cannot scroll.
    state.scrollTop = Math.max(
      Math.min(options.top ?? 0, state.scrollHeight - state.clientHeight),
      0,
    );
  }) as typeof timeline.scrollTo;
  /** The box changed size, as the browser tells every observer that watches the transcript. */
  const boxChanged = (): void => {
    for (const entry of observers) {
      if (entry.targets.includes(timeline)) entry.callback();
    }
  };
  /** Gives the transcript and its last row boxes, so the last row ends 240 from the start. */
  const layOut = (): void => {
    timeline.getBoundingClientRect = () =>
      ({ top: 0, bottom: state.clientHeight, height: state.clientHeight }) as DOMRect;
    const last = [...timeline.children]
      .filter((child) => child.classList.contains('chat-message-wrapper'))
      .at(-1) as HTMLElement | undefined;
    if (last === undefined) throw new Error('No row.');
    last.getBoundingClientRect = () =>
      ({ top: 180 - state.scrollTop, bottom: 240 - state.scrollTop, height: 60 }) as DOMRect;
  };
  return { view, conversation, timeline, state, boxChanged, layOut };
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

  test('an empty transcript is not scrolled when its box shrinks', () => {
    const { state, boxChanged } = renderChat(
      { scrollHeight: 300, clientHeight: 200, scrollTop: 0 },
      {},
      true,
    );
    boxChanged();
    expect(state.scrollTop).toBe(0);
  });

  test('a transcript that fit rests with its last row at the end of its reading box, not at its true end', () => {
    const { state, boxChanged, layOut } = renderChat({
      scrollHeight: 300,
      clientHeight: 400,
      scrollTop: 0,
    });
    layOut();
    boxChanged();
    expect(state.scrollTop).toBe(0);
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);
    state.clientHeight = 230;
    boxChanged();
    expect(state.scrollTop).toBe(10);
  });

  test('with nothing new arriving, the transcript is rested again where it rests', async () => {
    const { view, conversation, state, boxChanged, layOut } = renderChat({
      scrollHeight: 300,
      clientHeight: 400,
      scrollTop: 0,
    });
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);
    await view.rerender({ conversation: { ...conversation } });
    await tick();
    await tick();
    expect(state.scrollTop).toBe(40);
  });

  test('what arrives with the same number of messages still takes the transcript to its true end, and it is followed after', async () => {
    const { view, conversation, timeline, state, boxChanged, layOut } = renderChat({
      scrollHeight: 300,
      clientHeight: 400,
      scrollTop: 0,
    });
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);
    // The last row grows by 60 (a streamed chunk, an outcome row): the same messages, more to hold.
    const last = [...timeline.children]
      .filter((child) => child.classList.contains('chat-message-wrapper'))
      .at(-1) as HTMLElement;
    last.getBoundingClientRect = () =>
      ({ top: 180 - state.scrollTop, bottom: 300 - state.scrollTop, height: 120 }) as DOMRect;
    state.scrollHeight = 360;
    await view.rerender({ conversation: { ...conversation } });
    await tick();
    await tick();
    // Its true end, as an arrival always went.
    expect(state.scrollTop).toBe(160);
    // The scroll is heard, and then the box shrinks: it is still followed.
    timeline.dispatchEvent(new Event('scroll'));
    state.clientHeight = 180;
    boxChanged();
    expect(state.scrollTop).toBe(180);
  });

  test('a rest made with nothing new is recorded: its scroll does not end the rest', async () => {
    const { view, conversation, timeline, state, boxChanged, layOut } = renderChat({
      scrollHeight: 300,
      clientHeight: 400,
      scrollTop: 0,
    });
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);
    await view.rerender({ conversation: { ...conversation } });
    await tick();
    await tick();
    timeline.dispatchEvent(new Event('scroll'));
    state.clientHeight = 180;
    boxChanged();
    expect(state.scrollTop).toBe(60);
  });

  test('on the default surface with the scroll fade, a transcript that fit rests at its true end', () => {
    const { state, boxChanged, layOut } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      { scrollFadeVisible: true },
    );
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(100);
  });

  test('on the transparent surface with the scroll fade, it rests from its start', () => {
    const { state, boxChanged, layOut } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      { scrollFadeVisible: true, surfaceMode: 'transparent' },
    );
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);
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
