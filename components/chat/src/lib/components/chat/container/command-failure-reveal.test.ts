import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { commandFailureHeld, keepCommandFailureInView } from './command-failure-reveal.ts';

setupHappyDom();

/** A block's edges in CSS pixels, with the transcript scrolled to its start. */
type Edges = { readonly top: number; readonly bottom: number };

interface Scenario {
  /** The transcript's own box. */
  readonly transcript: Edges;
  /** Its scroll padding: what the header and the fade at its edges hide. */
  readonly padding: { readonly start: number; readonly end: number };
  /** The refusal line and the controls directly above it, from the top of the controls. */
  readonly unit: Edges;
  /** How far the transcript can scroll. */
  readonly toEnd: number;
}

// The 320 by 640 capture, coarse pointer: timeline 52..461, scroll padding 78 / 32, outcome top
// about 365, line box 447..466.5, and 28 + 36 pixels of end padding after it.
const COARSE: Scenario = {
  transcript: { top: 52, bottom: 461 },
  padding: { start: 78, end: 32 },
  unit: { top: 365, bottom: 466.5 },
  toEnd: 466.5 - 52 + 64 - 409,
};
// The same page with a fine pointer: the tool row is 26 pixels tall, not 44.
const FINE: Scenario = {
  ...COARSE,
  unit: { top: 365, bottom: 448.5 },
  toEnd: 448.5 - 52 + 64 - 409,
};
const READABLE_BOX: Pick<Scenario, 'transcript' | 'padding'> = {
  transcript: { top: 130, bottom: 429 },
  padding: { start: 0, end: 0 },
};

function box(top: number, bottom: number): DOMRect {
  return { top, bottom, height: bottom - top } as DOMRect;
}

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
  globalThis.cancelAnimationFrame = () => {};
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

/** A transcript that lays its refusal line and the controls above it out as `scenario` says. */
function transcriptOf(scenario: Scenario): HTMLElement {
  const transcript = document.createElement('div');
  transcript.innerHTML =
    '<div class="chat-turn-outcome"></div><p class="chat-turn-command-failure"></p>';
  document.body.append(transcript);
  const controls = transcript.querySelector<HTMLElement>('.chat-turn-outcome')!;
  const line = transcript.querySelector<HTMLElement>('p')!;
  const { top, bottom } = scenario.transcript;
  let scrolled = 0;
  transcript.style.scrollPaddingTop = `${String(scenario.padding.start)}px`;
  transcript.style.scrollPaddingBottom = `${String(scenario.padding.end)}px`;
  transcript.getBoundingClientRect = () => box(top, bottom);
  Object.defineProperty(transcript, 'clientHeight', {
    configurable: true,
    get: () => bottom - top,
  });
  Object.defineProperty(transcript, 'scrollHeight', {
    configurable: true,
    get: () => bottom - top + scenario.toEnd,
  });
  Object.defineProperty(transcript, 'scrollTop', {
    configurable: true,
    get: () => scrolled,
    set: (value: number) => {
      scrolled = Math.min(Math.max(value, 0), scenario.toEnd);
    },
  });
  controls.getBoundingClientRect = () =>
    box(scenario.unit.top - scrolled, scenario.unit.top + 20 - scrolled);
  line.getBoundingClientRect = () =>
    box(scenario.unit.bottom - 20 - scrolled, scenario.unit.bottom - scrolled);
  return transcript;
}

/** How far the transcript scrolled once the line was said and the placement settled. */
function scrolledBy(scenario: Scenario): number {
  const transcript = transcriptOf(scenario);
  const stop = keepCommandFailureInView(transcript);
  settle();
  const moved = transcript.scrollTop;
  stop();
  return moved;
}

describe('keepCommandFailureInView', () => {
  test.each([
    ['a coarse pointer, the 320 by 640 capture', COARSE, COARSE.toEnd],
    ['a fine pointer', FINE, FINE.toEnd],
  ])(
    'brings a unit cut off at the end into view in one move, with %s',
    (_name, scenario, moved) => {
      expect(scrolledBy(scenario)).toBe(moved);
      // The line ends above the readable end of the transcript, and the controls stay below its start.
      const readableEnd = scenario.transcript.bottom - scenario.padding.end;
      expect(scenario.unit.bottom - moved).toBeLessThanOrEqual(readableEnd + 0.5);
      expect(scenario.unit.top - moved).toBeGreaterThanOrEqual(
        scenario.transcript.top + scenario.padding.start,
      );
    },
  );

  test('leaves a unit that fits where it is', () => {
    expect(
      scrolledBy({
        transcript: { top: 135, bottom: 601 },
        padding: { start: 0, end: 0 },
        unit: { top: 345, bottom: 447.5 },
        toEnd: 0,
      }),
    ).toBe(0);
  });

  test('leaves a unit above the box alone: it was scrolled past', () => {
    expect(scrolledBy({ ...READABLE_BOX, unit: { top: -200, bottom: -100 }, toEnd: 500 })).toBe(0);
  });

  test('brings a unit taller than the box up by what is hidden, so its controls stay in view', () => {
    expect(scrolledBy({ ...READABLE_BOX, unit: { top: 100, bottom: 600 }, toEnd: 400 })).toBe(171);
  });

  test('moves no further than the transcript can scroll', () => {
    expect(scrolledBy({ ...READABLE_BOX, unit: { top: 300, bottom: 460 }, toEnd: 10 })).toBe(10);
  });

  test('does not carry the controls above the start of the box to reach the end', () => {
    expect(scrolledBy({ ...READABLE_BOX, unit: { top: 140, bottom: 460 }, toEnd: 300 })).toBe(31);
  });

  test('does nothing for a transcript that is not measured', () => {
    expect(
      scrolledBy({
        transcript: { top: 0, bottom: 0 },
        padding: { start: 0, end: 0 },
        unit: { top: 0, bottom: 0 },
        toEnd: 0,
      }),
    ).toBe(0);
  });

  test('a resize that finds the line placed moves nothing, and one that finds it cut off places it', () => {
    const transcript = transcriptOf(COARSE);
    const stop = keepCommandFailureInView(transcript);
    settle();
    expect(transcript.scrollTop).toBe(COARSE.toEnd);
    resizeCallback?.();
    settle();
    expect(transcript.scrollTop).toBe(COARSE.toEnd);
    stop();
  });

  test('the person taking the transcript ends it for good', () => {
    const transcript = transcriptOf(COARSE);
    const stop = keepCommandFailureInView(transcript);
    transcript.dispatchEvent(new Event('wheel'));
    settle();
    expect(transcript.scrollTop).toBe(0);
    stop();
  });

  test('a transcript is held while a refusal is kept in view, and not once it is released or stopped', () => {
    const transcript = transcriptOf(COARSE);
    expect(commandFailureHeld(transcript)).toBe(false);
    const stop = keepCommandFailureInView(transcript);
    expect(commandFailureHeld(transcript)).toBe(true);
    transcript.dispatchEvent(new Event('wheel'));
    expect(commandFailureHeld(transcript)).toBe(false);
    stop();

    const again = transcriptOf(COARSE);
    const stopAgain = keepCommandFailureInView(again);
    expect(commandFailureHeld(again)).toBe(true);
    stopAgain();
    expect(commandFailureHeld(again)).toBe(false);
  });

  test('the function it returns stops it, and the transcript stays where it is', () => {
    const transcript = transcriptOf(COARSE);
    const stop = keepCommandFailureInView(transcript);
    stop();
    settle();
    expect(transcript.scrollTop).toBe(0);
  });

  test('says nothing and does nothing where there is no observer to watch the transcript with', () => {
    const resizes = globalThis.ResizeObserver;
    // @ts-expect-error A host with no ResizeObserver: the placement is skipped, never thrown.
    globalThis.ResizeObserver = undefined;
    try {
      const transcript = transcriptOf(COARSE);
      keepCommandFailureInView(transcript)();
      settle();
      expect(transcript.scrollTop).toBe(0);
    } finally {
      globalThis.ResizeObserver = resizes;
    }
  });
});
