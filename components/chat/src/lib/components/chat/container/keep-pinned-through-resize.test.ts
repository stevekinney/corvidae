import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { keepPinnedThroughResize, startSideRest } from './keep-pinned-through-resize.ts';

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
  const state = { ...layout, startSide: 0 };
  Object.defineProperty(transcript, 'scrollHeight', { get: () => state.scrollHeight });
  Object.defineProperty(transcript, 'clientHeight', { get: () => state.clientHeight });
  Object.defineProperty(transcript, 'scrollTop', {
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
  });
  const asked: boolean[] = [];
  // What the page does: its true end, or, from its start, where the test says the last row is clear.
  const rest = (fromStart: boolean): void => {
    asked.push(fromStart);
    const end = state.scrollHeight - state.clientHeight;
    state.scrollTop = fromStart ? Math.min(state.startSide, end) : end;
  };
  return { transcript, state, rest, asked };
}

const resize = (): void => resizeCallback?.();

describe('keepPinnedThroughResize', () => {
  test('a transcript at its end is put back at its end when its box shrinks', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, rest);
    // A notice grows the composer: the box is 80 pixels shorter and nothing scrolls.
    state.clientHeight = 320;
    resize();
    expect(state.scrollTop).toBe(680);
    // The same transcript shrinks again (a keyboard): it rests at its end again.
    state.clientHeight = 120;
    resize();
    expect(state.scrollTop).toBe(880);
    expect(asked).toEqual([false, false]);
  });

  test('a transcript that fit and no longer does is asked to rest from its start', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 380,
      clientHeight: 400,
      scrollTop: 0,
    });
    keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 300;
    state.startSide = 20;
    resize();
    expect(state.scrollTop).toBe(20);
    state.clientHeight = 250;
    state.startSide = 70;
    resize();
    expect(state.scrollTop).toBe(70);
    expect(asked).toEqual([true, true]);
  });

  test("the pin's own scroll, heard after the box shrank again, does not end the rest", () => {
    const { transcript, state, rest } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 320;
    resize();
    expect(state.scrollTop).toBe(680);
    state.clientHeight = 200;
    transcript.dispatchEvent(new Event('scroll'));
    resize();
    expect(state.scrollTop).toBe(800);
  });

  test('a box that grows back is followed from the start in both directions', () => {
    const { transcript, state, rest } = transcriptOf({
      scrollHeight: 380,
      clientHeight: 400,
      scrollTop: 0,
    });
    keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 300;
    state.startSide = 20;
    resize();
    expect(state.scrollTop).toBe(20);
    state.clientHeight = 340;
    state.startSide = 0;
    resize();
    expect(state.scrollTop).toBe(0);
    state.clientHeight = 300;
    state.startSide = 20;
    resize();
    expect(state.scrollTop).toBe(20);
  });

  test('a box that grows pulls a transcript at its end back with it', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, rest);
    // The browser clamps the position to the new end.
    state.clientHeight = 500;
    state.scrollTop = 500;
    resize();
    expect(asked).toEqual([false]);
    expect(state.scrollTop).toBe(500);
  });

  test('a clamp does not turn a rest from the start into a rest at the end', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 364,
      clientHeight: 400,
      scrollTop: 0,
    });
    keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 287;
    state.startSide = 48;
    resize();
    expect(state.scrollTop).toBe(48);
    state.clientHeight = 334;
    state.scrollTop = 30;
    state.startSide = 1;
    resize();
    expect(asked.at(-1)).toBe(true);
    expect(state.scrollTop).toBe(1);
  });

  test('a clamp heard as a scroll first keeps the rest from the start too', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 364,
      clientHeight: 400,
      scrollTop: 0,
    });
    keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 287;
    state.startSide = 48;
    resize();
    state.clientHeight = 334;
    state.scrollTop = 30;
    transcript.dispatchEvent(new Event('scroll'));
    state.startSide = 1;
    resize();
    expect(asked.at(-1)).toBe(true);
    expect(state.scrollTop).toBe(1);
  });

  test('a person who scrolled up is not moved when the box shrinks', () => {
    const { transcript, state, rest } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, rest);
    state.scrollTop = 480;
    transcript.dispatchEvent(new Event('scroll'));
    state.clientHeight = 320;
    resize();
    expect(state.scrollTop).toBe(480);
    // Nor on a later shrink.
    state.clientHeight = 300;
    resize();
    expect(state.scrollTop).toBe(480);
  });

  test('a person who scrolled up from a rest at the start is not moved', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 364,
      clientHeight: 400,
      scrollTop: 0,
    });
    keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 287;
    state.startSide = 48;
    resize();
    state.scrollTop = 10;
    transcript.dispatchEvent(new Event('scroll'));
    state.clientHeight = 250;
    state.startSide = 85;
    resize();
    expect(state.scrollTop).toBe(10);
    expect(asked).toHaveLength(1);
  });

  test('a person who scrolled up and came back to the end is followed again', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, rest);
    state.scrollTop = 300;
    transcript.dispatchEvent(new Event('scroll'));
    state.scrollTop = 600;
    transcript.dispatchEvent(new Event('scroll'));
    state.clientHeight = 320;
    resize();
    expect(state.scrollTop).toBe(680);
    expect(asked.at(-1)).toBe(false);
  });

  test('a transcript resting from its start that is taken to its true end rests there from then on', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 364,
      clientHeight: 400,
      scrollTop: 0,
    });
    keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 287;
    state.startSide = 48;
    resize();
    state.scrollTop = 77;
    transcript.dispatchEvent(new Event('scroll'));
    state.clientHeight = 250;
    resize();
    expect(asked.at(-1)).toBe(false);
    expect(state.scrollTop).toBe(114);
  });

  test('the page saying it rested the transcript at its end is believed without a scroll', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 364,
      clientHeight: 400,
      scrollTop: 0,
    });
    const kept = keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 287;
    state.startSide = 48;
    resize();
    state.scrollTop = 77;
    kept.rested(false);
    expect(kept.restsUnchangedFromStart()).toBe(false);
    state.clientHeight = 250;
    resize();
    expect(asked.at(-1)).toBe(false);
    expect(state.scrollTop).toBe(114);
  });

  test('the page resting a transcript that fits at its end keeps it resting from its start', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 380,
      clientHeight: 400,
      scrollTop: 0,
    });
    const kept = keepPinnedThroughResize(transcript, rest);
    kept.rested(false);
    expect(kept.restsUnchangedFromStart()).toBe(true);
    state.clientHeight = 300;
    state.startSide = 20;
    resize();
    expect(asked).toEqual([true]);
  });

  test('a rest from the start that the page made is recorded: its scroll does not end the rest', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 364,
      clientHeight: 400,
      scrollTop: 0,
    });
    const kept = keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 287;
    state.startSide = 48;
    resize();
    // The page rests it from its start again, outside a resize, and the scroll is heard after.
    state.scrollTop = 60;
    kept.rested(true);
    transcript.dispatchEvent(new Event('scroll'));
    expect(kept.restsUnchangedFromStart()).toBe(true);
    state.clientHeight = 250;
    state.startSide = 85;
    resize();
    expect(asked.at(-1)).toBe(true);
    expect(state.scrollTop).toBe(85);
  });

  test('a transcript that holds more than when it rested is not unchanged', () => {
    const { transcript, state, rest } = transcriptOf({
      scrollHeight: 364,
      clientHeight: 400,
      scrollTop: 0,
    });
    const kept = keepPinnedThroughResize(transcript, rest);
    state.clientHeight = 287;
    state.startSide = 48;
    resize();
    expect(kept.restsUnchangedFromStart()).toBe(true);
    // A streamed chunk, an outcome row: more to hold, nothing scrolled.
    state.scrollHeight = 404;
    expect(kept.restsUnchangedFromStart()).toBe(false);
    state.scrollHeight = 364;
    expect(kept.restsUnchangedFromStart()).toBe(true);
    // Moved from where it was left, with the scroll not heard yet.
    state.scrollTop = 20;
    expect(kept.restsUnchangedFromStart()).toBe(false);
  });

  test('the page can refuse the move, and is asked again at the next change', () => {
    const { transcript, state } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    let counted = 0;
    keepPinnedThroughResize(transcript, () => {
      counted += 1;
    });
    state.clientHeight = 320;
    resize();
    state.clientHeight = 300;
    resize();
    expect(counted).toBe(2);
    expect(state.scrollTop).toBe(600);
  });

  test('a transcript with no layout yet is followed, and rests at its end once it has one', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 0,
      clientHeight: 0,
      scrollTop: 0,
    });
    keepPinnedThroughResize(transcript, rest);
    state.scrollHeight = 1000;
    state.clientHeight = 400;
    resize();
    expect(asked).toEqual([false]);
    expect(state.scrollTop).toBe(600);
  });

  test('something that takes the transcript back toward its start in the frame of a resize is not undone', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, rest);
    // The attention lift, say: moved, with its scroll not heard yet, as the box shrinks.
    state.scrollTop = 450;
    state.clientHeight = 320;
    resize();
    expect(state.scrollTop).toBe(450);
    expect(asked).toEqual([]);
  });

  // The sequence the capture logged for "reply failed partway", at the phone layout.
  test('the logged sequence of reply failed partway ends with the last row at the end of the reading box', () => {
    // A new element that overflows by 73 for a moment, then fits.
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 762,
      clientHeight: 689,
      scrollTop: 0,
    });
    const kept = keepPinnedThroughResize(transcript, rest);
    expect(kept.restsUnchangedFromStart()).toBe(false);
    state.scrollHeight = 689;
    resize();
    expect(kept.restsUnchangedFromStart()).toBe(true);
    // 375 wide: 587 in 581, the rows fit.
    state.scrollHeight = 587;
    state.clientHeight = 581;
    state.startSide = 0;
    resize();
    expect(state.scrollTop).toBe(0);
    // 320 wide, the box still 581.
    state.scrollHeight = 633;
    state.startSide = 23;
    resize();
    expect(state.scrollTop).toBe(23);
    // The box is 409 tall now, and the pin's own scroll is heard.
    state.scrollHeight = 629;
    state.clientHeight = 409;
    transcript.dispatchEvent(new Event('scroll'));
    state.startSide = 192;
    resize();
    expect(state.scrollTop).toBe(192);
    // The window grows by 24 and goes back.
    state.clientHeight = 433;
    state.startSide = 168;
    resize();
    expect(state.scrollTop).toBe(168);
    state.clientHeight = 409;
    state.startSide = 192;
    resize();
    expect(state.scrollTop).toBe(192);
    expect(asked.every((fromStart) => fromStart)).toBe(true);
  });

  test('stops looking once stop is called, and needs no ResizeObserver', () => {
    const { transcript, state, rest, asked } = transcriptOf({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600,
    });
    keepPinnedThroughResize(transcript, rest).stop();
    state.clientHeight = 320;
    transcript.dispatchEvent(new Event('scroll'));
    expect(asked).toEqual([]);

    const resizes = globalThis.ResizeObserver;
    // @ts-expect-error A host with no ResizeObserver: nothing is watched, nothing is thrown.
    globalThis.ResizeObserver = undefined;
    try {
      expect(() => keepPinnedThroughResize(transcript, rest).stop()).not.toThrow();
    } finally {
      globalThis.ResizeObserver = resizes;
    }
  });
});

/**
 * A transcript box laid out from `layout`: rows, then the empty typing region and trailing slot, then
 * the sentinel, with rects that move as the transcript scrolls. The numbers are the measured ones.
 */
function laidOut(layout: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop?: number;
  rows: Array<{ top: number; bottom: number; paddingBottom?: number }>;
}): HTMLElement {
  const transcript = document.createElement('div');
  document.body.append(transcript);
  let scrolled = layout.scrollTop ?? 0;
  const top = 52;
  transcript.style.scrollPaddingBottom = '32px';
  transcript.getBoundingClientRect = () =>
    ({ top, bottom: top + layout.clientHeight, height: layout.clientHeight }) as DOMRect;
  Object.defineProperty(transcript, 'clientHeight', { get: () => layout.clientHeight });
  Object.defineProperty(transcript, 'scrollHeight', { get: () => layout.scrollHeight });
  Object.defineProperty(transcript, 'scrollTop', {
    get: () => scrolled,
    set: (value: number) => {
      scrolled = value;
    },
  });
  const add = (className: string, edges: { top: number; bottom: number }, paddingBottom = 0) => {
    const element = document.createElement('div');
    element.className = className;
    if (paddingBottom > 0) element.style.paddingBottom = `${String(paddingBottom)}px`;
    element.getBoundingClientRect = () =>
      ({
        top: top + edges.top - scrolled,
        bottom: top + edges.bottom - scrolled,
        height: edges.bottom - edges.top,
      }) as DOMRect;
    transcript.append(element);
  };
  for (const row of layout.rows) add('chat-message-wrapper', row, row.paddingBottom);
  const end = layout.rows.at(-1)?.bottom ?? 0;
  add('chat-participant-typing', { top: end + 8, bottom: end + 8 });
  add('chat-trailing', { top: end + 16, bottom: end + 16 });
  add('chat-bottom-sentinel', { top: end + 24, bottom: end + 25 });
  return transcript;
}

describe('startSideRest', () => {
  afterEach(() => document.body.replaceChildren());

  test('the stopped turn on a touch phone rests 7 from its start', () => {
    expect(
      startSideRest(
        laidOut({
          clientHeight: 409,
          scrollHeight: 473,
          rows: [{ top: 310.5, bottom: 411.5, paddingBottom: 28 }],
        }),
      ),
    ).toBe(7);
  });

  test('the same turn with a fine pointer fits and rests at its start', () => {
    expect(
      startSideRest(
        laidOut({
          clientHeight: 425,
          scrollHeight: 457,
          rows: [{ top: 310.5, bottom: 395.5, paddingBottom: 28 }],
        }),
      ),
    ).toBe(0);
  });

  test('a row that takes no room is not the last row', () => {
    expect(
      startSideRest(
        laidOut({
          clientHeight: 287,
          scrollHeight: 364,
          rows: [
            { top: 246.5, bottom: 302.5, paddingBottom: 4 },
            { top: 302.5, bottom: 302.5 },
          ],
        }),
      ),
    ).toBe(44);
  });

  test('it is the same wherever the transcript is scrolled', () => {
    expect(
      startSideRest(
        laidOut({
          clientHeight: 409,
          scrollHeight: 473,
          scrollTop: 64,
          rows: [{ top: 310.5, bottom: 411.5, paddingBottom: 28 }],
        }),
      ),
    ).toBe(7);
  });

  test('never past the transcripts end', () => {
    expect(
      startSideRest(
        laidOut({ clientHeight: 200, scrollHeight: 230, rows: [{ top: 500, bottom: 600 }] }),
      ),
    ).toBe(30);
  });

  test('the sentinel is never the row, and no row means no rest', () => {
    expect(startSideRest(laidOut({ clientHeight: 400, scrollHeight: 400, rows: [] }))).toBeNull();
  });
});
