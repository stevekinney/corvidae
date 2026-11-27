import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import {
  commandFailureShift,
  commandFailureUnit,
  findCommandFailureLine,
  keepCommandFailureInView,
  transcriptReadingBox,
} from './command-failure-reveal.ts';

setupHappyDom();

// The 320 by 640 capture, coarse pointer: timeline 52..461, scroll padding 78 / 32, outcome top
// about 365, line box 447..466.5, and 28 + 36 pixels of end padding after it.
const coarse = {
  unit: { top: 365, bottom: 466.5 },
  box: { top: 130, bottom: 429 },
  toEnd: 466.5 - 52 + 64 - 409,
};
// The same page with a fine pointer: the tool row is 26 pixels tall, not 44.
const fine = {
  unit: { top: 365, bottom: 448.5 },
  box: { top: 130, bottom: 429 },
  toEnd: 448.5 - 52 + 64 - 409,
};

describe('commandFailureShift', () => {
  test.each([
    ['a coarse pointer', coarse],
    ['a fine pointer', fine],
  ])('brings a unit cut off at the end into view in one move, on %s', (_name, input) => {
    const first = commandFailureShift(input.unit, input.box, input.toEnd);
    expect(first).toBeGreaterThan(0);
    const moved = { top: input.unit.top - first, bottom: input.unit.bottom - first };
    expect(moved.bottom).toBeLessThanOrEqual(input.box.bottom + 0.5);
    expect(commandFailureShift(moved, input.box, input.toEnd - first)).toBe(0);
  });

  test('leaves a unit that fits where it is', () => {
    expect(commandFailureShift({ top: 345, bottom: 447.5 }, { top: 135, bottom: 601 }, 0)).toBe(0);
  });

  test('leaves a unit above the box alone: it was scrolled past', () => {
    expect(commandFailureShift({ top: -200, bottom: -100 }, { top: 130, bottom: 429 }, 500)).toBe(0);
  });

  test('brings a unit taller than the box up by what is hidden, so its controls stay in view', () => {
    expect(commandFailureShift({ top: 100, bottom: 600 }, { top: 130, bottom: 429 }, 400)).toBe(171);
  });

  test('moves no further than the transcript can scroll', () => {
    expect(commandFailureShift({ top: 300, bottom: 460 }, { top: 130, bottom: 429 }, 10)).toBe(10);
  });

  test('does not carry the unit top above the box start to reach the end', () => {
    expect(commandFailureShift({ top: 140, bottom: 460 }, { top: 130, bottom: 429 }, 300)).toBe(31);
  });

  test('never moves toward the start, and does nothing for a box that is not measured', () => {
    expect(commandFailureShift({ top: 0, bottom: 0 }, { top: 0, bottom: 0 }, 0)).toBe(0);
    expect(commandFailureShift({ top: 0, bottom: 10 }, { top: 0, bottom: 100 }, 50)).toBe(0);
    expect(commandFailureShift({ top: 300, bottom: 460 }, { top: 130, bottom: 429 }, -20)).toBe(0);
  });
});

function box(top: number, bottom: number): DOMRect {
  return { top, bottom, height: bottom - top } as DOMRect;
}

function transcriptWith(html: string): HTMLElement {
  const transcript = document.createElement('div');
  transcript.innerHTML = html;
  document.body.append(transcript);
  return transcript;
}

describe('the line and its controls', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test('the last refusal line drawn is the one kept in view, and none is none', () => {
    expect(findCommandFailureLine(transcriptWith('<p>nothing</p>'))).toBeNull();
    const transcript = transcriptWith(
      '<p class="chat-turn-command-failure" id="first"></p><p class="chat-turn-command-failure" id="last"></p>',
    );
    expect(findCommandFailureLine(transcript)?.id).toBe('last');
  });

  test('the unit is the line and the outcome controls drawn directly above it', () => {
    const transcript = transcriptWith(
      '<div class="chat-turn-outcome" id="controls"></div><p class="chat-turn-command-failure" id="line"></p>',
    );
    const line = transcript.querySelector<HTMLElement>('#line')!;
    transcript.querySelector<HTMLElement>('#controls')!.getBoundingClientRect = () => box(365, 400);
    line.getBoundingClientRect = () => box(447, 466.5);
    expect(commandFailureUnit(line)).toEqual({ top: 365, bottom: 466.5 });
  });

  test('the unit is the line alone when something else stands above it', () => {
    const transcript = transcriptWith('<p id="other"></p><p class="chat-turn-command-failure" id="line"></p>');
    const line = transcript.querySelector<HTMLElement>('#line')!;
    line.getBoundingClientRect = () => box(447, 466.5);
    expect(commandFailureUnit(line)).toEqual({ top: 447, bottom: 466.5 });
  });

  test('the reading box is the transcript less its scroll padding', () => {
    const transcript = transcriptWith('');
    transcript.style.scrollPaddingTop = '78px';
    transcript.style.scrollPaddingBottom = '32px';
    transcript.getBoundingClientRect = () => box(52, 461);
    expect(transcriptReadingBox(transcript)).toEqual({ top: 130, bottom: 429 });
  });
});

describe('keepCommandFailureInView', () => {
  type Placed = { readonly transcript: HTMLElement; readonly line: HTMLElement };

  let resizeCallback: (() => void) | undefined;
  const frames: Array<() => void> = [];
  const original = {
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };

  beforeAll(() => {
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  });

  afterAll(() => {
    globalThis.ResizeObserver = original.ResizeObserver;
    globalThis.requestAnimationFrame = original.requestAnimationFrame;
    globalThis.cancelAnimationFrame = original.cancelAnimationFrame;
  });

  afterEach(() => {
    document.body.replaceChildren();
    frames.length = 0;
    resizeCallback = undefined;
  });

  /** Runs the frames asked for so far, and those they ask for, until none is left. */
  function settle(): void {
    for (let guard = 0; guard < 20 && frames.length > 0; guard += 1) frames.shift()!();
  }

  /** A transcript whose line sits `lineBottom` and whose box is `bottom`, with `toEnd` left to scroll. */
  function place(lineBottom: number, bottom: number, toEnd: number): Placed {
    const transcript = transcriptWith('<p class="chat-turn-command-failure"></p>');
    const line = transcript.querySelector<HTMLElement>('p')!;
    let top = 0;
    const lineHeight = 20;
    transcript.getBoundingClientRect = () => box(0, bottom);
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, get: () => bottom });
    Object.defineProperty(transcript, 'scrollHeight', {
      configurable: true,
      get: () => bottom + toEnd,
    });
    Object.defineProperty(transcript, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.min(Math.max(value, 0), toEnd);
      },
    });
    line.getBoundingClientRect = () =>
      box(lineBottom - top - lineHeight, lineBottom - top);
    return { transcript, line };
  }

  test('puts the line in view when it is said, and a resize that finds it placed moves nothing', () => {
    const { transcript } = place(480, 400, 100);
    const stop = keepCommandFailureInView(transcript);
    settle();
    // The end still shows the top of the line, so the transcript goes to its end.
    expect(transcript.scrollTop).toBe(100);
    resizeCallback?.();
    settle();
    expect(transcript.scrollTop).toBe(100);
    stop();
  });

  test('the person taking the transcript ends it for good', () => {
    const { transcript } = place(480, 400, 100);
    const stop = keepCommandFailureInView(transcript);
    transcript.dispatchEvent(new Event('wheel'));
    settle();
    expect(transcript.scrollTop).toBe(0);
    stop();
  });

  test('a function that stops it leaves the transcript where it is', () => {
    const { transcript } = place(480, 400, 100);
    const stop = keepCommandFailureInView(transcript);
    stop();
    settle();
    expect(transcript.scrollTop).toBe(0);
  });
});
