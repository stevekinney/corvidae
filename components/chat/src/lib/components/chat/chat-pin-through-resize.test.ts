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
