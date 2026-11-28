/**
 * A waiting approval stays under the chat header while the header grows after the approval was
 * placed (320 by 640: the header was 59px tall when the approval was placed and 115px once its
 * title wrapped and its status row rendered, which left the rail row at y=123 under a header that
 * reaches y=167). The placement follows the header's height until the person's first scrolling
 * input; the placement's own scrolling never ends it.
 */
import { approvalPlacementShift } from '@lostgradient/chat';
import { afterEach, describe, expect, test } from 'bun:test';

import { createApprovalPlacement } from './approval-placement.ts';

const stubBox = (element: Element, top: number, bottom: number): void => {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom,
      left: 0,
      right: 320,
      x: 0,
      y: top,
      width: 320,
      height: bottom - top,
    }) as DOMRect;
};

let nodes: HTMLElement[] = [];
afterEach(() => {
  for (const node of nodes) node.remove();
  nodes = [];
});

/** The 320 by 640 layout: transcript 52 to 487, the rail row 123 to 175 and the card 180 to 425. */
function layout(): { transcript: HTMLElement; card: HTMLElement } {
  const transcript = document.createElement('div');
  const message = document.createElement('article');
  message.setAttribute('data-message-id', 'm1');
  const label = document.createElement('button');
  label.className = 'cinder-tool-call-rail__row';
  const card = document.createElement('div');
  message.append(label, card);
  transcript.append(message);
  document.body.append(transcript);
  nodes.push(transcript);
  stubBox(transcript, 52, 487);
  stubBox(label, 123, 175);
  stubBox(card, 180, 425);
  Object.defineProperty(transcript, 'scrollHeight', { value: 700, configurable: true });
  Object.defineProperty(transcript, 'clientHeight', { value: 435, configurable: true });
  return { transcript, card };
}

const setHeader = (transcript: HTMLElement, height: number): void => {
  transcript.style.setProperty('--cinder-chat-overlay-inset-start', `${height}px`);
  transcript.style.paddingTop = `${height + 12}px`;
};

describe('placing the approval again when the header grows', () => {
  test('a header that grew from 59px to 115px with no input puts the unit under the new line', () => {
    const { transcript, card } = layout();
    // Placed against the 59px header: the box starts at 52 + 71 = 123, where the row already is.
    setHeader(transcript, 59);
    expect(approvalPlacementShift(transcript, card)).toBe(0);

    // The header settles at 115px: the line is 52 + 127 = 179. From there to the end fade's line
    // (487 less 32) is 276px and the unit is 302px, so it cannot all show. The decision row, the
    // card's bottom, outranks the row that labels it: it is whole above the fade line where it
    // stands, so nothing moves, the card's top is clear of the header, and the label is what
    // passes under it. (Scrolling up to give the label back brings Jump to latest, which shrinks
    // the transcript and feeds the placement.)
    setHeader(transcript, 115);
    expect(approvalPlacementShift(transcript, card)).toBe(0);
    expect(425).toBeLessThanOrEqual(487 - 32);
    expect(180).toBeGreaterThanOrEqual(179);
  });

  test('a unit that fits under the grown header rests with its labelling row clear of it', () => {
    const { transcript, card } = layout();
    // A shorter card: the unit is 222px and the room under the 115px header is 276px.
    card.getBoundingClientRect = () => ({ top: 180, bottom: 345, left: 0, right: 320 }) as DOMRect;
    setHeader(transcript, 115);
    const shift = approvalPlacementShift(transcript, card);
    expect(123 - shift!).toBeGreaterThanOrEqual(179);
    expect(345 - shift!).toBeLessThanOrEqual(487 - 32);
  });

  test('the header changing places it again while the placement is in force, with no other gate', () => {
    const { transcript } = layout();
    let placements = 0;
    const placement = createApprovalPlacement(() => (placements += 1));

    // Nothing placed yet: a header change places nothing.
    placement.headerChanged();
    expect(placements).toBe(0);

    placement.placed(transcript);
    // The placement's own scroll, and the transcript's pin to its end, are programmatic scroll
    // events; they never end it.
    transcript.dispatchEvent(new window.Event('scroll'));
    placement.headerChanged();
    expect(placements).toBe(1);
    // Focus is on the card, or on nothing: it is not a gate.
    (document.activeElement as HTMLElement | null)?.blur();
    placement.headerChanged();
    expect(placements).toBe(2);
    placement.release();
  });

  test('a narrower transcript places the approval again until the person scrolls', () => {
    const { transcript } = layout();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    let onResize: (() => void) | undefined;
    let target: Element | undefined;
    let disconnected = false;
    class TranscriptResizeObserver {
      constructor(callback: () => void) {
        onResize = callback;
      }
      observe(element: Element) {
        target = element;
      }
      disconnect() {
        disconnected = true;
      }
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: TranscriptResizeObserver,
    });
    let placements = 0;
    const placement = createApprovalPlacement(() => (placements += 1));
    try {
      placement.placed(transcript);
      expect(target).toBe(transcript);
      onResize?.();
      expect(placements).toBe(1);

      transcript.dispatchEvent(new window.Event('wheel'));
      expect(disconnected).toBe(true);
      onResize?.();
      expect(placements).toBe(1);
    } finally {
      placement.release();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver');
      else Object.defineProperty(globalThis, 'ResizeObserver', descriptor);
    }
  });

  test('the person’s own scrolling ends it, and the header then leaves the transcript where it is', () => {
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
      const { transcript } = layout();
      let placements = 0;
      const placement = createApprovalPlacement(() => (placements += 1));
      placement.placed(transcript);
      transcript.dispatchEvent(new window.Event(type, { bubbles: true }));
      placement.headerChanged();
      expect(placements, type).toBe(0);
    }
  });

  test('a header that shrank keeps the unit where it is, with no gap pulled in', () => {
    const { transcript, card } = layout();
    setHeader(transcript, 115);
    setHeader(transcript, 59);
    // The line moved up to 123; the row stands at 123 already, so nothing moves.
    expect(approvalPlacementShift(transcript, card)).toBe(0);
  });
});

describe('createApprovalPlacement, holding the transcript', () => {
  test('holds the transcript from its first placement until the person scrolls it', () => {
    const transcript = document.createElement('div');
    document.body.append(transcript);
    const said: string[] = [];
    const placement = createApprovalPlacement(
      () => {},
      () => {
        said.push('hold');
        return () => said.push('let go');
      },
    );
    placement.placed(transcript);
    placement.placed(transcript);
    expect(said).toEqual(['hold']);
    transcript.dispatchEvent(new window.Event('wheel'));
    expect(said).toEqual(['hold', 'let go']);
    placement.release();
    expect(said).toEqual(['hold', 'let go']);
    transcript.remove();
  });
});
