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
import { holdApprovalPlacement } from './container/chat-approval-review.ts';
import { keepCommandFailureInView } from './container/command-failure-reveal.ts';
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

/** The surface whose end fades as a mask: the one where a transcript rests from its start. */
const MASKED = { scrollFadeVisible: true, surfaceMode: 'transparent' } as const;

/** A waiting approval, as an adapter's run leaves it. */
function approvalConversation() {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id: 'pinned' }), 'refund it'), {
      id: 'call',
      name: 'issue-refund',
      arguments: { orderId: '4471' },
    }),
    {
      callId: 'call',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: 'Refund order 4471 for $42.00?',
        risk: 'high',
        operation: { kind: 'command', command: 'refund --order 4471 --amount 42.00' },
        policyVersion: 'test-policy',
        idempotencyKey: 'test-approval',
      },
    },
  );
}

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
  const state = { ...layout, rowsEnd: 240 };
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
  let rests = 0;
  timeline.scrollTo = ((options: ScrollToOptions) => {
    rests += 1;
    // As a browser clamps it: a transcript that fits cannot scroll.
    state.scrollTop = Math.max(
      Math.min(options.top ?? 0, state.scrollHeight - state.clientHeight),
      0,
    );
  }) as typeof timeline.scrollTo;
  /** The box of `element` changed size, as the browser tells every observer that watches it. */
  const changed = (element: Element): void => {
    for (const entry of observers) {
      if (entry.targets.includes(element)) entry.callback();
    }
  };
  const lastRow = (): HTMLElement => {
    const last = [...timeline.children]
      .filter((child) => child.classList.contains('chat-message-wrapper'))
      .at(-1) as HTMLElement | undefined;
    if (last === undefined) throw new Error('No row.');
    return last;
  };
  /** Gives the transcript and its last row boxes, so the last row ends `state.rowsEnd` from the start. */
  const layOut = (): void => {
    timeline.getBoundingClientRect = () =>
      ({ top: 0, bottom: state.clientHeight, height: state.clientHeight }) as DOMRect;
    lastRow().getBoundingClientRect = () =>
      ({
        top: 180 - state.scrollTop,
        bottom: state.rowsEnd - state.scrollTop,
        height: state.rowsEnd - 180,
      }) as DOMRect;
  };
  /** The last row comes to end `rowsEnd` from the start (a panel in it sizes itself, a chunk streams). */
  const rowGrows = (rowsEnd: number): void => {
    state.rowsEnd = rowsEnd;
    state.scrollHeight = Math.max(rowsEnd + 60, state.clientHeight);
  };
  return {
    view,
    conversation,
    timeline,
    state,
    boxChanged: () => changed(timeline),
    rowChanged: () => changed(lastRow()),
    layOut,
    rowGrows,
    rests: () => rests,
  };
}

/** Lets the correction a message schedules run. */
async function corrected(): Promise<void> {
  await tick();
  await tick();
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
      MASKED,
      true,
    );
    boxChanged();
    expect(state.scrollTop).toBe(0);
  });
});

describe('Chat — where a transcript rests is read from its layout, whatever order it arrived in', () => {
  test('a transcript rests with its last row at the end of its reading box, not at its true end', () => {
    const { state, boxChanged, layOut } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
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

  test('a row that grows after the last rest is rested again, with no message and no change to the box', async () => {
    const { state, boxChanged, rowChanged, layOut, rowGrows } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
    layOut();
    await corrected();
    boxChanged();
    expect(state.scrollTop).toBe(0);
    // A panel in the last row sizes itself after it loads.
    rowGrows(520);
    rowChanged();
    expect(state.scrollTop).toBe(120);
  });

  test('the same rows in the same box rest in one place, whether they settled before the first rest or after it', async () => {
    // Settled before anything rested the transcript.
    const before = renderChat({ scrollHeight: 580, clientHeight: 400, scrollTop: 0 }, MASKED);
    before.state.rowsEnd = 520;
    before.layOut();
    await corrected();
    before.boxChanged();
    // Settled after: the transcript fitted when it was first rested.
    const after = renderChat({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 }, MASKED);
    after.layOut();
    await corrected();
    after.boxChanged();
    after.rowGrows(520);
    after.rowChanged();
    expect(before.state.scrollTop).toBe(120);
    expect(after.state.scrollTop).toBe(120);
  });

  test('a box that shrinks while the rows are still settling rests where it would have had they settled first', async () => {
    const settledFirst = renderChat({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 }, MASKED);
    settledFirst.layOut();
    await corrected();
    settledFirst.boxChanged();
    settledFirst.rowGrows(520);
    settledFirst.rowChanged();
    settledFirst.state.clientHeight = 300;
    settledFirst.boxChanged();

    const shrunkFirst = renderChat({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 }, MASKED);
    shrunkFirst.layOut();
    await corrected();
    shrunkFirst.boxChanged();
    shrunkFirst.state.clientHeight = 300;
    shrunkFirst.boxChanged();
    shrunkFirst.rowGrows(520);
    shrunkFirst.rowChanged();

    expect(settledFirst.state.scrollTop).toBe(220);
    expect(shrunkFirst.state.scrollTop).toBe(220);
  });

  test('what arrives rests the transcript in the same place as a row that grows by itself', async () => {
    const { view, conversation, timeline, state, boxChanged, layOut, rowGrows } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);
    // A streamed chunk, an outcome row: the same messages, more to hold.
    rowGrows(300);
    await view.rerender({ conversation: { ...conversation } });
    await corrected();
    expect(state.scrollTop).toBe(100);
    // The scroll is heard, and then the box shrinks: it is still followed.
    timeline.dispatchEvent(new Event('scroll'));
    state.clientHeight = 180;
    boxChanged();
    expect(state.scrollTop).toBe(120);
  });

  test('the same thread read again moves nothing', async () => {
    const { view, conversation, timeline, state, boxChanged, layOut } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);
    await view.rerender({ conversation: { ...conversation } });
    await corrected();
    expect(state.scrollTop).toBe(40);
    timeline.dispatchEvent(new Event('scroll'));
    state.clientHeight = 180;
    boxChanged();
    expect(state.scrollTop).toBe(60);
  });

  test('a transcript at its true end is rested where the layout says when a row grows', () => {
    const { timeline, state, boxChanged, rowChanged, layOut, rowGrows } = renderChat(
      { scrollHeight: 580, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
    state.rowsEnd = 520;
    layOut();
    boxChanged();
    expect(state.scrollTop).toBe(120);
    // Jump to latest, or the person's own scroll to the very end.
    state.scrollTop = 180;
    timeline.dispatchEvent(new Event('scroll'));
    rowGrows(560);
    rowChanged();
    expect(state.scrollTop).toBe(160);
  });

  test('with no fade it rests from its start too, and under the default surface with the fade at its true end', () => {
    for (const props of [{}, { surfaceMode: 'transparent' }]) {
      const { state, boxChanged, rowChanged, layOut, rowGrows } = renderChat(
        { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
        props,
      );
      layOut();
      boxChanged();
      state.clientHeight = 200;
      boxChanged();
      expect(state.scrollTop).toBe(40);
      rowGrows(300);
      rowChanged();
      expect(state.scrollTop).toBe(100);
      cleanup();
      observers.length = 0;
    }
    // The default surface's fade is an overlay with no room kept clear under the last row.
    const { state, boxChanged, rowChanged, layOut, rowGrows } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      { scrollFadeVisible: true },
    );
    layOut();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(100);
    rowGrows(300);
    rowChanged();
    expect(state.scrollTop).toBe(160);
  });

  test('a placement that holds the transcript rests it alone, and what it left is not remembered after', async () => {
    // A host that places a waiting approval itself holds the transcript the same way.
    for (const heardFirst of [true, false]) {
      const {
        view,
        conversation,
        timeline,
        state,
        boxChanged,
        rowChanged,
        layOut,
        rowGrows,
        rests,
      } = renderChat({ scrollHeight: 580, clientHeight: 400, scrollTop: 0 }, MASKED);
      state.rowsEnd = 520;
      layOut();
      boxChanged();
      expect(state.scrollTop).toBe(120);
      // A card that waits, drawn by the host in a row of its own, and the host's hold.
      const card = document.createElement('div');
      card.className = 'cinder-approval-card';
      card.dataset['cinderState'] = 'pending';
      timeline.querySelector('.chat-bottom-sentinel')!.before(card);
      holdApprovalPlacement(timeline);
      const before = rests();
      // The placement rests the card at the transcript's true end; a row then changes size.
      state.scrollTop = 180;
      if (heardFirst) timeline.dispatchEvent(new Event('scroll'));
      rowGrows(600);
      rowChanged();
      if (!heardFirst) timeline.dispatchEvent(new Event('scroll'));
      state.clientHeight = 380;
      boxChanged();
      expect(rests()).toBe(before);
      expect(state.scrollTop).toBe(180);
      // The approval is decided somewhere else (the host never lets go), and a message arrives:
      // one place, whenever the scroll was heard (600 held to 380; its true end is 280).
      card.dataset['cinderState'] = 'approved';
      await view.rerender({ conversation: { ...conversation } });
      await corrected();
      expect(state.scrollTop).toBe(220);
      cleanup();
      observers.length = 0;
    }
  });

  test("while a waiting approval's placement holds the transcript, the pin stands aside", async () => {
    const view = render(Chat, {
      id: 'pinned',
      variant: 'transcript',
      conversation: approvalConversation(),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
      ...MASKED,
    });
    const timeline = view.container.querySelector<HTMLElement>('.chat-timeline')!;
    const state = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 };
    Object.defineProperty(timeline, 'scrollHeight', { get: () => state.scrollHeight });
    Object.defineProperty(timeline, 'clientHeight', { get: () => state.clientHeight });
    Object.defineProperty(timeline, 'scrollTop', {
      get: () => state.scrollTop,
      set: (value: number) => {
        state.scrollTop = value;
      },
    });
    let rests = 0;
    timeline.scrollTo = () => {
      rests += 1;
    };
    const boxChanged = (): void => {
      for (const entry of observers) {
        if (entry.targets.includes(timeline)) entry.callback();
      }
    };
    await corrected();
    // The placement has looked, and found the card it holds.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(view.container.querySelector('.cinder-approval-card')).not.toBeNull();
    rests = 0;
    state.clientHeight = 320;
    boxChanged();
    expect(rests).toBe(0);
    // The person takes the transcript: the placement is over, and the pin rests it again.
    timeline.dispatchEvent(new Event('wheel'));
    state.clientHeight = 300;
    boxChanged();
    expect(rests).toBe(1);
  });
});

describe('Chat — a waiting approval is placed again in the frame its layout changes', () => {
  /**
   * The animation frames the page asks for, run only when a test says so: a page whose clock owns
   * them (a design-review capture), or the frame a browser paints before the next one runs.
   */
  const frames: Array<(() => void) | undefined> = [];
  const originalFrame = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  afterEach(() => {
    globalThis.requestAnimationFrame = originalFrame;
    globalThis.cancelAnimationFrame = originalCancel;
    frames.length = 0;
  });
  const holdFrames = (): void => {
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (handle: number): void => {
      frames[handle - 1] = undefined;
    };
  };
  /** Runs every frame asked for, and the frames those ask for, until none is left. */
  const runFrames = (): void => {
    for (let index = 0; index < frames.length && index < 60; index += 1) {
      const frame = frames[index];
      frames[index] = undefined;
      frame?.();
    }
  };
  /** Runs the frames asked for so far, and not the ones those ask for: one frame of the page. */
  const runOneFrame = (): void => {
    const asked = frames.length;
    for (let index = 0; index < asked; index += 1) {
      const frame = frames[index];
      frames[index] = undefined;
      frame?.();
    }
  };

  /**
   * Chat with a waiting approval of its own, laid out as a browser would: a transcript 400 tall
   * that holds `content` in all, and a card 200 tall that starts `cardTop` from the transcript's
   * start. Nothing is laid over the transcript, so a card that fits rests at the transcript's end
   * wherever the end still shows it whole (`approvalArrivalRestShift`).
   */
  async function renderApproval(layout: { content: number; cardTop: number }) {
    holdFrames();
    const view = render(Chat, {
      id: 'pinned',
      variant: 'transcript',
      conversation: approvalConversation(),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
      ...MASKED,
    });
    const timeline = view.container.querySelector<HTMLElement>('.chat-timeline')!;
    const state = { ...layout, clientHeight: 400, scrollTop: 0 };
    const extent = (): number => Math.max(state.content, state.clientHeight);
    Object.defineProperty(timeline, 'scrollHeight', { get: extent });
    Object.defineProperty(timeline, 'clientHeight', { get: () => state.clientHeight });
    Object.defineProperty(timeline, 'scrollTop', {
      get: () => state.scrollTop,
      // As a browser clamps it.
      set: (value: number) => {
        state.scrollTop = Math.min(Math.max(value, 0), extent() - state.clientHeight);
      },
    });
    timeline.scrollTo = ((options: ScrollToOptions) => {
      timeline.scrollTop = options.top ?? 0;
    }) as typeof timeline.scrollTo;
    timeline.getBoundingClientRect = () =>
      ({ top: 0, bottom: state.clientHeight, height: state.clientHeight }) as DOMRect;
    await corrected();
    const card = view.container.querySelector<HTMLElement>('.cinder-approval-card')!;
    const cardBox = (): DOMRect =>
      ({
        top: state.cardTop - state.scrollTop,
        bottom: state.cardTop + 200 - state.scrollTop,
        height: 200,
      }) as DOMRect;
    card.getBoundingClientRect = cardBox;
    // The row that labels the card is part of the unit that is placed: it starts where the card does.
    for (const label of timeline.querySelectorAll<HTMLElement>('.cinder-tool-call-rail__row')) {
      label.getBoundingClientRect = cardBox;
    }
    const rowAbove = [...timeline.children].find((child) =>
      child.classList.contains('chat-message-wrapper'),
    );
    if (rowAbove === undefined || rowAbove.contains(card))
      throw new Error('No row above the card.');
    const changed = (element: Element): void => {
      for (const entry of observers) {
        if (entry.targets.includes(element)) entry.callback();
      }
    };
    return { view, timeline, card, state, rowAbove, changed };
  }

  test('rows above the card that take their size after it was placed: the card is placed again in that frame (thirty tool calls, 1280)', async () => {
    // 600 in a box of 400, the card from 300 to 500: it rests at the transcript's end, 200.
    const { timeline, state, rowAbove, changed } = await renderApproval({
      content: 600,
      cardTop: 300,
    });
    changed(timeline);
    runFrames();
    expect(state.scrollTop).toBe(200);
    // The rows above the card take their final size, 70 more. No node is added, and neither the
    // transcript's box nor the card's changes: only the box of a row above the card does.
    state.content = 670;
    state.cardTop = 370;
    changed(rowAbove);
    // Placed where the rule says (the end, 270) in the frame the layout changed: no animation
    // frame has run, so no frame is painted with the rows settled and the card 70 lower.
    expect(state.scrollTop).toBe(270);
    runFrames();
    expect(state.scrollTop).toBe(270);
    cleanup();
    observers.length = 0;

    // The same rows, there in full before the card was first placed, rest in the same place.
    const settledFirst = await renderApproval({ content: 670, cardTop: 370 });
    settledFirst.changed(settledFirst.timeline);
    runFrames();
    expect(settledFirst.state.scrollTop).toBe(270);
  });

  test('a transcript that fitted whole when the card was placed and then holds 11 more rests 11 from its start (list beside the chat, 768)', async () => {
    // 366 in a box of 400: everything is in view, and the card (150 to 350) rests at 0.
    const { timeline, state, rowAbove, changed } = await renderApproval({
      content: 366,
      cardTop: 150,
    });
    changed(timeline);
    runFrames();
    expect(state.scrollTop).toBe(0);
    // The rows above the card take their final size, 45 more: 411 in a box of 400.
    state.content = 411;
    state.cardTop = 195;
    changed(rowAbove);
    expect(state.scrollTop).toBe(11);
    runFrames();
    expect(state.scrollTop).toBe(11);
    cleanup();
    observers.length = 0;

    const settledFirst = await renderApproval({ content: 411, cardTop: 195 });
    settledFirst.changed(settledFirst.timeline);
    runFrames();
    expect(settledFirst.state.scrollTop).toBe(11);
  });

  test('growth above the card that equals what the placement last scrolled is still a change, not a scroll that moved nothing', async () => {
    // 447 in a box of 400: the card (200 to 400) rests at the end, 47.
    const { timeline, state, rowAbove, changed } = await renderApproval({
      content: 447,
      cardTop: 200,
    });
    changed(timeline);
    runOneFrame();
    expect(state.scrollTop).toBe(47);
    // The rows above grow by those same 47: the card stands where it stood before the placement
    // scrolled, which says nothing about the new layout (it is not a scroll that moved nothing).
    state.content = 494;
    state.cardTop = 247;
    changed(rowAbove);
    expect(state.scrollTop).toBe(94);
    runFrames();
    expect(state.scrollTop).toBe(94);
  });

  test('a person who took the transcript is not moved when a row changes after', async () => {
    const { timeline, state, rowAbove, changed } = await renderApproval({
      content: 600,
      cardTop: 300,
    });
    changed(timeline);
    runFrames();
    expect(state.scrollTop).toBe(200);
    // They wheel up to read what came before: the placement is over.
    timeline.dispatchEvent(new Event('wheel'));
    state.scrollTop = 40;
    timeline.dispatchEvent(new Event('scroll'));
    state.content = 670;
    state.cardTop = 370;
    changed(rowAbove);
    runFrames();
    expect(state.scrollTop).toBe(40);
  });

  test('while the placement holds the transcript, a move it did not make itself does not bring Jump to latest', async () => {
    // 1000 in a box of 400, the card from 300 to 500: it rests with its bottom clear, at 112, far
    // from the transcript's end.
    const { view, timeline, state, changed } = await renderApproval({
      content: 1000,
      cardTop: 300,
    });
    const container = view.container.querySelector<HTMLElement>('.chat-container')!;
    changed(timeline);
    runFrames();
    expect(state.scrollTop).toBe(112);
    timeline.dispatchEvent(new Event('scroll'));
    runFrames();
    await tick();
    // The placement left the transcript here, so Jump to latest is not offered.
    expect(container.hasAttribute('data-jump-visible')).toBe(false);

    // The box shrinks by 20, and in that frame something else has already put the approval where
    // the rule says (a host's placement by the same rule, or the browser holding the content in
    // place): the transcript is at 132 when the pin looks, and its scroll is heard after.
    state.clientHeight = 380;
    state.scrollTop = 132;
    changed(timeline);
    timeline.dispatchEvent(new Event('scroll'));
    await tick();
    // Not the person moving away: no control appears, whose band would shrink the transcript
    // under the card and move it again.
    expect(container.hasAttribute('data-jump-visible')).toBe(false);
    expect(state.scrollTop).toBe(132);
  });

  test('after a press in the card, a box change leaves the transcript where the placement left it, whichever code placed it last', async () => {
    for (const placedBy of ['the layout step', 'a pass in an animation frame'] as const) {
      // 1000 in a box of 400, the card from 300 to 500: it rests with its bottom clear, at 112,
      // which is neither where the pin rests a transcript nor its true end.
      const { view, timeline, state, changed } = await renderApproval({
        content: 1000,
        cardTop: 300,
      });
      if (placedBy === 'the layout step') changed(timeline);
      else runFrames();
      expect(state.scrollTop, placedBy).toBe(112);
      timeline.dispatchEvent(new Event('scroll'));
      // The person presses Approve. Nothing scrolls, and the placement is over.
      await fireEvent.pointerDown(getByRole(view.container, 'button', { name: 'Approve' }));
      // The box changes. The transcript is where the placement left it, not where the pin would
      // rest one, and not one thing after a placement made in the layout step and another after
      // one made by a pass.
      state.clientHeight = 380;
      changed(timeline);
      runFrames();
      expect(state.scrollTop, placedBy).toBe(112);
      cleanup();
      observers.length = 0;
      frames.length = 0;
    }
  });

  test('Jump to latest is gone when an approval arrives, before any pass has run', async () => {
    holdFrames();
    const view = render(Chat, {
      id: 'pinned',
      variant: 'transcript',
      conversation: appendUserMessage(createConversationHistory({ id: 'pinned' }), 'refund it'),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
      ...MASKED,
    });
    const container = view.container.querySelector<HTMLElement>('.chat-container')!;
    const timeline = view.container.querySelector<HTMLElement>('.chat-timeline')!;
    // 1000 in a box of 400.
    const state = { scrollTop: 0 };
    Object.defineProperty(timeline, 'scrollHeight', { get: () => 1000 });
    Object.defineProperty(timeline, 'clientHeight', { get: () => 400 });
    Object.defineProperty(timeline, 'scrollTop', {
      get: () => state.scrollTop,
      set: (value: number) => {
        state.scrollTop = Math.min(Math.max(value, 0), 600);
      },
    });
    timeline.scrollTo = ((options: ScrollToOptions) => {
      timeline.scrollTop = options.top ?? 0;
    }) as typeof timeline.scrollTo;
    await corrected();
    // The person wheels back to its start, 600 from the end, so Jump to latest is offered.
    timeline.dispatchEvent(new Event('wheel'));
    state.scrollTop = 0;
    timeline.dispatchEvent(new Event('scroll'));
    runFrames();
    await tick();
    expect(container.hasAttribute('data-jump-visible')).toBe(true);

    // An approval arrives and its card is drawn. No animation frame runs.
    await view.rerender({ conversation: approvalConversation() });
    await corrected();
    expect(view.container.querySelector('.cinder-approval-card')).not.toBeNull();
    // The control is gone already: its band takes nothing from the box the card is placed in.
    expect(container.hasAttribute('data-jump-visible')).toBe(false);
  });

  test('a host that holds the transcript is told of every change, wherever its placement left the transcript, until it lets go', async () => {
    const { view, conversation, timeline, state, boxChanged, rowChanged, layOut, rowGrows, rests } =
      renderChat({ scrollHeight: 580, clientHeight: 400, scrollTop: 0 }, MASKED);
    state.rowsEnd = 520;
    layOut();
    boxChanged();
    expect(state.scrollTop).toBe(120);
    // A card that waits, drawn by the host in a row of its own, and the host's hold.
    const card = document.createElement('div');
    card.className = 'cinder-approval-card';
    card.dataset['cinderState'] = 'pending';
    timeline.querySelector('.chat-bottom-sentinel')!.before(card);
    let placed = 0;
    const letGo = holdApprovalPlacement(timeline, () => {
      placed += 1;
    });
    const before = rests();
    // Its placement left the transcript where neither the pin (120) nor its true end (180) is.
    state.scrollTop = 60;
    timeline.dispatchEvent(new Event('scroll'));
    rowGrows(600);
    rowChanged();
    expect(placed).toBe(1);
    state.clientHeight = 380;
    boxChanged();
    expect(placed).toBe(2);
    expect(state.scrollTop).toBe(60);
    // It leaves the transcript at its true end (600 and 60 held to 380), and a message arrives:
    // it is told of that too, and the pin still rests nothing.
    state.scrollTop = 280;
    timeline.dispatchEvent(new Event('scroll'));
    await view.rerender({ conversation: appendUserMessage(conversation, 'And 4399?') });
    // What a message that arrives schedules waits for the frame its row is laid out in.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await corrected();
    expect(placed).toBe(3);
    expect(rests()).toBe(before);
    expect(state.scrollTop).toBe(280);
    // It lets go (the person scrolled): it is told nothing more.
    const told = placed;
    letGo();
    rowChanged();
    expect(placed).toBe(told);
  });

  test('a refusal kept in view comes first: while it holds the transcript, the placement is told nothing', () => {
    const { timeline, state, boxChanged, rowChanged, layOut } = renderChat(
      { scrollHeight: 580, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
    state.rowsEnd = 520;
    layOut();
    boxChanged();
    const card = document.createElement('div');
    card.className = 'cinder-approval-card';
    card.dataset['cinderState'] = 'pending';
    timeline.querySelector('.chat-bottom-sentinel')!.before(card);
    let placed = 0;
    holdApprovalPlacement(timeline, () => {
      placed += 1;
    });
    // A command was refused, and its line is kept in view: that rests the transcript.
    const refusalCleared = keepCommandFailureInView(timeline);
    rowChanged();
    boxChanged();
    expect(placed).toBe(0);
    refusalCleared();
    rowChanged();
    expect(placed).toBe(1);
  });
});

describe('Chat — a transcript a person took to its true end is theirs there', () => {
  test('it stays at its end through a late row change, a box change and a message', async () => {
    const { view, conversation, timeline, state, boxChanged, rowChanged, layOut, rowGrows } =
      renderChat({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 }, MASKED);
    layOut();
    await corrected();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);

    // The person scrolls to the very end.
    timeline.dispatchEvent(new window.Event('pointerdown'));
    state.scrollTop = state.scrollHeight - state.clientHeight;
    timeline.dispatchEvent(new window.Event('scroll'));
    expect(state.scrollTop).toBe(100);

    // A panel in the last row sizes itself late: the end is followed, not the rest (320).
    rowGrows(520);
    rowChanged();
    expect(state.scrollTop).toBe(380);
    timeline.dispatchEvent(new window.Event('scroll'));
    // The box changes: still at its end.
    state.clientHeight = 180;
    boxChanged();
    expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight);
    // A history stabilization or the same messages again: still at its end.
    await view.rerender({ conversation: { ...conversation } });
    await corrected();
    expect(state.scrollTop).toBe(state.scrollHeight - state.clientHeight);
  });
});

describe('Chat — Jump to latest rests where every other rest does', () => {
  /** Puts back the page's `getComputedStyle` after a case that stood in for its stylesheet. */
  let restoreComputedStyle = (): void => {};
  afterEach(() => {
    restoreComputedStyle();
    restoreComputedStyle = () => {};
  });

  test('after Jump to latest, history that arrives late leaves the last row on the end of the reading box', async () => {
    const { view, timeline, state, boxChanged, rowChanged, layOut, rowGrows } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
    layOut();
    await corrected();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    expect(state.scrollTop).toBe(40);

    // The person presses a control inside the transcript (Load earlier messages), which is not
    // scrolling it, and then asks for the latest message.
    const row = [...timeline.children].find((child) =>
      child.classList.contains('chat-message-wrapper'),
    )!;
    row.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    const container = view.container.querySelector<HTMLElement>('.chat-container')!;
    await fireEvent.keyDown(container, { key: 'End' });
    expect(state.scrollTop).toBe(40);
    timeline.dispatchEvent(new Event('scrollend'));
    timeline.dispatchEvent(new window.Event('scroll'));

    // The history arrives: the browser's anchoring and the clamp to the new end are heard as a
    // scroll that lands at the true end. It is no person's, so the claim is not made.
    state.scrollTop = state.scrollHeight - state.clientHeight;
    timeline.dispatchEvent(new window.Event('scroll'));
    rowGrows(300);
    rowChanged();
    // The last row's end is on the end of the reading box (300 less the box of 200): the rest.
    expect(state.scrollTop).toBe(100);
  });

  test('after Jump to latest, a streamed chunk moves the transcript on and never back', async () => {
    const { view, timeline, state, boxChanged, rowChanged, layOut, rowGrows } = renderChat(
      { scrollHeight: 300, clientHeight: 400, scrollTop: 0 },
      MASKED,
    );
    layOut();
    await corrected();
    boxChanged();
    state.clientHeight = 200;
    boxChanged();
    // The rows fit the box less the end space; the transcript rests from its start.
    expect(state.scrollTop).toBe(40);

    // The person jumps to the latest message: it lands on the rest, not at the true end (100).
    const container = view.container.querySelector<HTMLElement>('.chat-container')!;
    await fireEvent.keyDown(container, { key: 'End' });
    const positions = [state.scrollTop];
    expect(state.scrollTop).toBe(40);
    // The jump's own guard settles, and its scroll is heard.
    timeline.dispatchEvent(new Event('scrollend'));
    timeline.dispatchEvent(new Event('scroll'));

    // A reply streams: its row grows by 10.
    rowGrows(250);
    rowChanged();
    positions.push(state.scrollTop);
    expect(state.scrollTop).toBe(50);
    rowGrows(300);
    rowChanged();
    positions.push(state.scrollTop);
    expect(state.scrollTop).toBe(100);
    // Never a step back.
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  // The rows end 840 from the start and 60 of space follows them. In a box of 400 the rest is 440
  // and the true end 500: the rest is 60 from the end. The control's band is 40. So the thresholds
  // are: below the band, between the gap and the gap with the band, and above both. Each is also
  // run with a band that is still laid out for a frame after the control has gone, as it was with
  // reduced motion before the transcript's box stopped transitioning, and as a host's own styles
  // could still have it: the jump is aimed by what is laid out, so it lands in the same place.
  for (const thresholds of [
    { jumpThreshold: 30, bottomThreshold: 20 },
    { jumpThreshold: 80, bottomThreshold: 50 },
    { jumpThreshold: 200, bottomThreshold: 150 },
  ]) {
    for (const bandLags of [false, true]) {
      const name = `jumpThreshold ${String(thresholds.jumpThreshold)}${bandLags ? ' and a band that leaves a frame late' : ''}`;
      test(`Jump to latest lands on the rest and a reply after it never steps back, with ${name}`, async () => {
        const frame = (): Promise<void> =>
          new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const asked = appendUserMessage(
          createConversationHistory({ id: 'pinned' }),
          'Look up 4398',
        );
        const view = render(Chat, {
          id: 'pinned',
          variant: 'transcript',
          conversation: appendAssistantMessage(asked, 'It shipped on Monday.'),
          ...MASKED,
          ...thresholds,
        });
        const container = view.container.querySelector<HTMLElement>('.chat-container')!;
        const timeline = view.container.querySelector<HTMLElement>('.chat-timeline')!;
        const state = { rowsEnd: 840, scrollTop: 0 };
        // The transcript gives 40 to the band Jump to latest floats in while the control is drawn,
        // as its end margin, as Chat's stylesheet has it (happy-dom applies none of it).
        const drawn = (): boolean => container.hasAttribute('data-jump-visible');
        let laidOut = drawn();
        const band = (): number => ((bandLags ? laidOut : drawn()) ? 40 : 0);
        const box = (): number => 400 - band();
        const extent = (): number => state.rowsEnd + 60;
        Object.defineProperty(timeline, 'scrollHeight', { get: extent });
        Object.defineProperty(timeline, 'clientHeight', { get: box });
        Object.defineProperty(timeline, 'scrollTop', {
          get: () => state.scrollTop,
          set: (value: number) => {
            state.scrollTop = Math.min(Math.max(value, 0), extent() - box());
          },
        });
        timeline.scrollTo = ((options: ScrollToOptions) => {
          timeline.scrollTop = options.top ?? 0;
        }) as typeof timeline.scrollTo;
        timeline.getBoundingClientRect = () =>
          ({ top: 0, bottom: box(), height: box() }) as DOMRect;
        const computed = globalThis.getComputedStyle;
        restoreComputedStyle = () => {
          globalThis.getComputedStyle = computed;
        };
        globalThis.getComputedStyle = (element: Element, pseudo?: string | null) => {
          const style = computed(element, pseudo);
          if (element !== timeline) return style;
          return new Proxy(style, {
            get: (target, key) => {
              if (key === 'marginBottom') return `${String(band())}px`;
              const value: unknown = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };
        const lastRow = [...timeline.children]
          .filter((child) => child.classList.contains('chat-message-wrapper'))
          .at(-1) as HTMLElement;
        lastRow.getBoundingClientRect = () =>
          ({
            top: 180 - state.scrollTop,
            bottom: state.rowsEnd - state.scrollTop,
            height: state.rowsEnd - 180,
          }) as DOMRect;
        const changed = (element: Element): void => {
          for (const entry of observers) {
            if (entry.targets.includes(element)) entry.callback();
          }
        };
        let seen = box();
        /** The scroll is heard, a frame passes, and the browser tells whoever watches the box. */
        const heard = async (): Promise<void> => {
          timeline.dispatchEvent(new Event('scroll'));
          await frame();
          await tick();
          laidOut = drawn();
          if (box() !== seen) {
            seen = box();
            changed(timeline);
          }
        };
        const atRest = (): boolean => state.scrollTop === state.rowsEnd - box();

        await corrected();
        changed(timeline);
        await heard();
        expect(atRest(), `${name}: at rest to begin with`).toBe(true);
        // At rest the control is not offered, however small the threshold: there is nothing later.
        expect(drawn(), `${name}: no control at rest`).toBe(false);

        // The person wheels up to read what came before, and Jump to latest shows.
        timeline.dispatchEvent(new Event('wheel'));
        state.scrollTop = 0;
        await heard();
        expect(drawn(), name).toBe(true);
        expect(state.scrollTop, name).toBe(0);

        // They jump. The control is gone at the press, and the jump lands on the rest of the box
        // of 400, which the transcript has again or has a frame later.
        await fireEvent.keyDown(container, { key: 'End' });
        expect(state.scrollTop, `${name}: where the jump lands`).toBe(440);
        const positions = [state.scrollTop];
        await heard();
        timeline.dispatchEvent(new Event('scrollend'));
        await heard();
        positions.push(state.scrollTop);
        // Settled, the last row ends on the end of the reading box and no control is offered.
        expect(atRest(), `${name}: at rest once the jump has settled`).toBe(true);
        expect(drawn(), `${name}: no control once the jump has settled`).toBe(false);

        // A reply streams, 30 at a time: more at once than the middle threshold leaves between
        // the rest and itself, so a scroll heard before the reply is rested is past that threshold.
        for (const rowsEnd of [870, 900, 930]) {
          state.rowsEnd = rowsEnd;
          // A scroll heard as the reply grows, before it is rested, as one is while a reply streams.
          await heard();
          changed(lastRow);
          positions.push(state.scrollTop);
          await heard();
          positions.push(state.scrollTop);
          expect(atRest(), `${name}: at rest with the rows at ${String(rowsEnd)}`).toBe(true);
          expect(drawn(), `${name}: no control with the rows at ${String(rowsEnd)}`).toBe(false);
        }
        // On, and never back.
        expect(positions, name).toEqual([...positions].sort((a, b) => a - b));
      });
    }
  }
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
