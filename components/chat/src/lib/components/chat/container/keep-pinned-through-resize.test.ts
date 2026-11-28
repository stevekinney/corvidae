import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { keepPinnedThroughResize, startSideRest } from './keep-pinned-through-resize.ts';

setupHappyDom();

/** The observers the pin makes, by what each watches, so a test can say whose box changed. */
const observers: Array<{ readonly callback: () => void; readonly targets: Set<Element> }> = [];
const original = globalThis.ResizeObserver;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    readonly #entry: { readonly callback: () => void; readonly targets: Set<Element> };
    constructor(callback: () => void) {
      this.#entry = { callback, targets: new Set() };
      observers.push(this.#entry);
    }
    observe(target: Element): void {
      this.#entry.targets.add(target);
    }
    unobserve(target: Element): void {
      this.#entry.targets.delete(target);
    }
    disconnect(): void {
      this.#entry.targets.clear();
    }
  } as unknown as typeof ResizeObserver;
});

afterAll(() => {
  globalThis.ResizeObserver = original;
});

afterEach(() => {
  observers.length = 0;
  document.body.replaceChildren();
});

/** The box of `element` changed size, as the browser tells every observer that watches it. */
function changed(element: Element): void {
  for (const entry of observers) {
    if (entry.targets.has(element)) entry.callback();
  }
}

/** Lets the observer of the transcript's rows hear what was added or taken away. */
async function rowsHeard(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * A transcript whose rows end `rowsEnd` from its start, with `endSpace` after them, in a box
 * `clientHeight` tall: one row that holds everything, then the sentinel. The page rests it as Chat
 * does: from its start where the pin says so, and at its true end otherwise.
 */
function transcriptOf(layout: { rowsEnd: number; clientHeight: number; scrollTop?: number }) {
  const transcript = document.createElement('div');
  document.body.append(transcript);
  const state = { endSpace: 60, scrollTop: 0, ...layout };
  const extent = (): number => Math.max(state.rowsEnd + state.endSpace, state.clientHeight);
  Object.defineProperty(transcript, 'scrollHeight', { get: extent });
  Object.defineProperty(transcript, 'clientHeight', { get: () => state.clientHeight });
  Object.defineProperty(transcript, 'scrollTop', {
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
  });
  transcript.getBoundingClientRect = () =>
    ({ top: 0, bottom: state.clientHeight, height: state.clientHeight }) as DOMRect;
  const row = document.createElement('div');
  row.className = 'chat-message-wrapper';
  row.getBoundingClientRect = () =>
    ({
      top: -state.scrollTop,
      bottom: state.rowsEnd - state.scrollTop,
      height: state.rowsEnd,
    }) as DOMRect;
  const sentinel = document.createElement('div');
  sentinel.className = 'chat-bottom-sentinel';
  transcript.append(row, sentinel);

  let asked = 0;
  let refuse = false;
  const kept = keepPinnedThroughResize(transcript, () => {
    asked += 1;
    if (refuse) return;
    const end = extent() - state.clientHeight;
    state.scrollTop = startSideRest(transcript) ?? end;
    kept.rested();
  });
  /** The transcript is scrolled to `top`, and the scroll is heard. */
  const scrolledTo = (top: number): void => {
    state.scrollTop = top;
    transcript.dispatchEvent(new Event('scroll'));
  };
  return {
    transcript,
    row,
    state,
    kept,
    scrolledTo,
    asked: () => asked,
    refuseRests: () => {
      refuse = true;
    },
  };
}

describe('keepPinnedThroughResize', () => {
  test('a row that grows after the last rest is rested again, with no change to the box', () => {
    const { row, state } = transcriptOf({ rowsEnd: 240, clientHeight: 400 });
    // A panel in the row sizes itself after it loads: nothing arrived, and no box but the row's changed.
    state.rowsEnd = 520;
    changed(row);
    expect(state.scrollTop).toBe(120);
    // And shrinks again (a section folds): the transcript rests from its start once more.
    state.rowsEnd = 300;
    changed(row);
    expect(state.scrollTop).toBe(0);
  });

  test('the same rows in the same box rest in one place, whichever settled first', () => {
    // The rows settle, then the box shrinks.
    const first = transcriptOf({ rowsEnd: 240, clientHeight: 400 });
    first.state.rowsEnd = 520;
    changed(first.row);
    first.state.clientHeight = 300;
    changed(first.transcript);
    // The box shrinks while the rows are still settling, and they settle after.
    const second = transcriptOf({ rowsEnd: 240, clientHeight: 400 });
    second.state.clientHeight = 300;
    changed(second.transcript);
    second.state.rowsEnd = 520;
    changed(second.row);
    // The rows were there in full before anything looked.
    const third = transcriptOf({ rowsEnd: 520, clientHeight: 300 });
    changed(third.transcript);
    expect(first.state.scrollTop).toBe(220);
    expect(second.state.scrollTop).toBe(220);
    expect(third.state.scrollTop).toBe(220);
  });

  test('a transcript that overflowed for a moment and then fits rests as one that always fitted', () => {
    // The phone layout's new element: its box is tall for a few frames while the header and the
    // composer land, and its rows are in before or after that.
    const before = transcriptOf({ rowsEnd: 526, clientHeight: 689 });
    changed(before.transcript);
    before.state.clientHeight = 581;
    changed(before.transcript);
    const after = transcriptOf({ rowsEnd: 0, clientHeight: 581 });
    after.state.rowsEnd = 526;
    changed(after.row);
    // 587 held in 581: the rows fit the reading box, so it shows from its start either way.
    expect(before.state.scrollTop).toBe(0);
    expect(after.state.scrollTop).toBe(0);
  });

  test("a rest's own scroll, heard after the layout changed again, does not end the rest", () => {
    const { transcript, row, state } = transcriptOf({ rowsEnd: 520, clientHeight: 400 });
    changed(transcript);
    expect(state.scrollTop).toBe(120);
    state.clientHeight = 300;
    transcript.dispatchEvent(new Event('scroll'));
    changed(transcript);
    expect(state.scrollTop).toBe(220);
    state.rowsEnd = 560;
    transcript.dispatchEvent(new Event('scroll'));
    changed(row);
    expect(state.scrollTop).toBe(260);
  });

  test('a box that grows back is followed in both directions', () => {
    const { transcript, state } = transcriptOf({ rowsEnd: 520, clientHeight: 300 });
    changed(transcript);
    expect(state.scrollTop).toBe(220);
    state.clientHeight = 400;
    changed(transcript);
    expect(state.scrollTop).toBe(120);
    state.clientHeight = 300;
    changed(transcript);
    expect(state.scrollTop).toBe(220);
  });

  test('a box that grows pulls the transcript back with it, and that is no one taking it', () => {
    const { transcript, state } = transcriptOf({ rowsEnd: 320, clientHeight: 300 });
    changed(transcript);
    expect(state.scrollTop).toBe(20);
    // The box grows to 375: all there is to scroll is 5, and the browser pulls the transcript back.
    state.clientHeight = 375;
    state.scrollTop = 5;
    changed(transcript);
    expect(state.scrollTop).toBe(0);
    // Heard as a scroll first, it is the same.
    state.clientHeight = 300;
    changed(transcript);
    expect(state.scrollTop).toBe(20);
    state.clientHeight = 375;
    state.scrollTop = 5;
    transcript.dispatchEvent(new Event('scroll'));
    changed(transcript);
    expect(state.scrollTop).toBe(0);
  });

  test('the browser holding the end of the content in place is no one taking the transcript', () => {
    const { transcript, row, state, asked } = transcriptOf({ rowsEnd: 520, clientHeight: 400 });
    changed(transcript);
    expect(state.scrollTop).toBe(120);
    // A row grows by 40 and the browser moves the transcript by the same 40, in one layout.
    state.rowsEnd = 560;
    state.scrollTop = 160;
    transcript.dispatchEvent(new Event('scroll'));
    state.clientHeight = 380;
    changed(transcript);
    expect(state.scrollTop).toBe(180);
    // A row shrinks by 30 and the browser moves the transcript back by 30, heard only after.
    const before = asked();
    state.rowsEnd = 530;
    state.scrollTop = 150;
    changed(row);
    expect(asked()).toBe(before + 1);
    expect(state.scrollTop).toBe(150);
  });

  test('a person who scrolled up is not moved, by the box or by a row', () => {
    const { transcript, row, state, scrolledTo, asked } = transcriptOf({
      rowsEnd: 1000,
      clientHeight: 400,
    });
    changed(transcript);
    expect(state.scrollTop).toBe(600);
    const before = asked();
    scrolledTo(480);
    state.clientHeight = 320;
    changed(transcript);
    state.rowsEnd = 1100;
    changed(row);
    expect(state.scrollTop).toBe(480);
    expect(asked()).toBe(before);
  });

  test('a person who came back to where the transcript rests is followed again', () => {
    const { transcript, state, scrolledTo } = transcriptOf({ rowsEnd: 1000, clientHeight: 400 });
    changed(transcript);
    scrolledTo(300);
    scrolledTo(600);
    state.clientHeight = 320;
    changed(transcript);
    expect(state.scrollTop).toBe(680);
  });

  test('a transcript at its true end is still followed, and rests where the layout says at the next change', () => {
    // Whether a placement, Jump to latest or the person put it there, and whether its scroll is
    // heard before the layout changes or after: nothing is remembered but that nobody took it away.
    for (const heardFirst of [true, false]) {
      const { transcript, row, state } = transcriptOf({ rowsEnd: 1000, clientHeight: 400 });
      changed(transcript);
      expect(state.scrollTop).toBe(600);
      // The end of the scrollable area, 60 further.
      state.scrollTop = 660;
      if (heardFirst) transcript.dispatchEvent(new Event('scroll'));
      state.rowsEnd = 1100;
      changed(row);
      if (!heardFirst) transcript.dispatchEvent(new Event('scroll'));
      expect(state.scrollTop).toBe(700);
      state.clientHeight = 320;
      changed(transcript);
      expect(state.scrollTop).toBe(780);
    }
  });

  test('something that takes the transcript back toward its start in the frame of a change is not undone', () => {
    const { transcript, state, asked } = transcriptOf({ rowsEnd: 1000, clientHeight: 400 });
    changed(transcript);
    const before = asked();
    // A lift of a waiting item's top into view, in this frame; its scroll is not heard yet.
    state.scrollTop = 450;
    state.clientHeight = 320;
    changed(transcript);
    expect(state.scrollTop).toBe(450);
    expect(asked()).toBe(before);
  });

  test('a transcript with no layout yet rests once it has one', () => {
    const { transcript, state } = transcriptOf({ rowsEnd: 0, clientHeight: 0 });
    state.endSpace = 0;
    state.rowsEnd = 1000;
    state.endSpace = 60;
    state.clientHeight = 400;
    changed(transcript);
    expect(state.scrollTop).toBe(600);
  });

  test('the page can refuse the rest, and is asked again at the next change', () => {
    const { transcript, row, state, asked, refuseRests } = transcriptOf({
      rowsEnd: 1000,
      clientHeight: 400,
    });
    changed(transcript);
    refuseRests();
    const before = asked();
    state.clientHeight = 320;
    changed(transcript);
    state.rowsEnd = 1100;
    changed(row);
    expect(asked()).toBe(before + 2);
    expect(state.scrollTop).toBe(600);
  });

  test('a row that is added is watched, and one that is taken away is looked at', async () => {
    const { transcript, row, state } = transcriptOf({ rowsEnd: 520, clientHeight: 400 });
    changed(transcript);
    expect(state.scrollTop).toBe(120);
    // A typing line appears after the rows: a new child, which then grows.
    const added = document.createElement('div');
    added.getBoundingClientRect = () =>
      ({ top: 520 - state.scrollTop, bottom: 580 - state.scrollTop, height: 60 }) as DOMRect;
    row.after(added);
    await rowsHeard();
    state.endSpace = 120;
    changed(added);
    expect(state.scrollTop).toBe(180);
    // It is taken away: no box that is watched changes, and the transcript is rested again.
    added.remove();
    state.endSpace = 60;
    await rowsHeard();
    expect(state.scrollTop).toBe(120);
  });

  test('stops looking once stop is called, and needs no ResizeObserver', () => {
    const { transcript, row, state, kept, asked } = transcriptOf({
      rowsEnd: 520,
      clientHeight: 400,
    });
    kept.stop();
    state.clientHeight = 300;
    changed(transcript);
    changed(row);
    transcript.dispatchEvent(new Event('scroll'));
    expect(asked()).toBe(0);

    const resizes = globalThis.ResizeObserver;
    // @ts-expect-error A host with no ResizeObserver: nothing is watched, nothing is thrown.
    globalThis.ResizeObserver = undefined;
    try {
      const none = keepPinnedThroughResize(transcript, () => {});
      expect(() => none.stop()).not.toThrow();
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
