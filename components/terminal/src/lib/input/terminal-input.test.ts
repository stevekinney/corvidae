import { afterEach, describe, expect, test } from 'bun:test';

import type { FailureCode } from '@lostgradient/ventriloquist';
import {
  createFakeInputController,
  createFakeInputEngine,
  createInputSettings,
  keyEvent,
  pasteEvent,
  sentBytes,
  sentText,
  type FakeInputController,
  type FakeInputEngine,
} from './input-test-support.ts';

import type { InputRefusal, InputRefusalReason, InputSettings } from './input-types.ts';
import type { PasteReview } from './paste-review.ts';
import { createTerminalInput, type TerminalInput } from './terminal-input.ts';

type Fixture = {
  host: HTMLElement;
  inner: HTMLTextAreaElement;
  engine: FakeInputEngine;
  controller: FakeInputController;
  input: TerminalInput;
  settings: InputSettings;
  refusals: InputRefusal[];
  captures: boolean[];
  mouse: Array<[boolean, boolean]>;
  reviews: Array<PasteReview | undefined>;
  copies: number[];
};

const hosts: HTMLElement[] = [];

function fixture(
  options: {
    settings?: Partial<InputSettings>;
    controller?: FakeInputController | undefined;
    withoutController?: boolean;
    isTerminalControl?: (node: Node) => boolean;
    withMouseListener?: boolean;
  } = {},
): Fixture {
  const host = document.createElement('div');
  const inner = document.createElement('textarea');
  host.append(inner);
  document.body.append(host);
  hosts.push(host);
  const engine = createFakeInputEngine();
  engine.focusTarget = inner;
  const controller = options.controller ?? createFakeInputController();
  const settings = createInputSettings(options.settings);
  const refusals: InputRefusal[] = [];
  const captures: boolean[] = [];
  const mouse: Array<[boolean, boolean]> = [];
  const reviews: Array<PasteReview | undefined> = [];
  const copies: number[] = [];
  const input = createTerminalInput({
    engine,
    host,
    controller: options.withoutController ? undefined : controller,
    readSettings: () => settings,
    ...(options.isTerminalControl === undefined
      ? {}
      : { isTerminalControl: options.isTerminalControl }),
    onMouseReportingChange: (active, announce) => mouse.push([active, announce]),
    onCaptureChange: (captured) => captures.push(captured),
    onReview: (review) => reviews.push(review),
    onRefused: (refusal) => refusals.push(refusal),
    onCopy: () => copies.push(copies.length + 1),
  });
  return {
    host,
    inner,
    engine,
    controller,
    input,
    settings,
    refusals,
    captures,
    mouse,
    reviews,
    copies,
  };
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

function press(
  context: Fixture,
  type: 'keydown' | 'keypress' | 'keyup',
  init: KeyboardEventInit,
): { event: KeyboardEvent; process: boolean } {
  const event = keyEvent(type, init);
  const process = context.engine.hook!(event);
  return { event, process };
}

describe('reports become bytes', () => {
  test('a text report goes out as UTF-8, in order', () => {
    const context = fixture();
    context.engine.report({ kind: 'text', data: 'a' });
    context.engine.report({ kind: 'text', data: 'é' });
    context.engine.report({ kind: 'text', data: '\u001b[A' });
    expect(context.controller.sent.map((chunk) => [...chunk])).toEqual([
      [0x61],
      [0xc3, 0xa9],
      [0x1b, 0x5b, 0x41],
    ]);
  });

  test('a binary report goes out as one byte per character, distinct from text', () => {
    const context = fixture();
    context.engine.report({ kind: 'binary', data: '\u0080ÿ' });
    context.engine.report({ kind: 'text', data: '\u0080' });
    expect(context.controller.sent.map((chunk) => [...chunk])).toEqual([
      [0x80, 0xff],
      [0xc2, 0x80],
    ]);
  });

  test('a report that cannot be encoded exactly is refused, not rewritten', () => {
    const context = fixture();
    context.engine.report({ kind: 'text', data: '\ud800' });
    context.engine.report({ kind: 'binary', data: 'Ā' });
    expect(context.controller.sent).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'malformed' }, { reason: 'malformed' }]);
  });
});

describe('authority is enforced in the client', () => {
  test('a view that takes no input sends nothing, whatever the engine reports', () => {
    const context = fixture({ settings: { writable: false } });
    context.engine.report({ kind: 'text', data: 'typed' });
    context.engine.report({ kind: 'text', data: '\u001b[?62;c' });
    context.engine.report({ kind: 'binary', data: 'x' });
    expect(context.controller.sent).toEqual([]);
    expect(context.refusals.map((refusal) => refusal.reason)).toEqual([
      'read-only',
      'read-only',
      'read-only',
    ]);
  });

  test('automatic query replies are suppressed in read-only mode and forwarded when writable', () => {
    const reply = '\u001b[?62;22c';
    const readOnly = fixture({ settings: { writable: false } });
    readOnly.engine.report({ kind: 'text', data: reply });
    expect(readOnly.controller.sent).toEqual([]);
    const writable = fixture();
    writable.engine.report({ kind: 'text', data: reply });
    expect(sentText(writable.controller)).toBe(reply);
  });

  test('the state changing to read-only takes effect at the next report', () => {
    const context = fixture();
    context.engine.report({ kind: 'text', data: 'a' });
    context.settings.writable = false;
    context.engine.report({ kind: 'text', data: 'b' });
    expect(sentText(context.controller)).toBe('a');
  });

  test('a controller that revoked authority gets nothing', () => {
    const context = fixture();
    context.controller.authorityRevoked = true;
    context.engine.report({ kind: 'text', data: 'a' });
    expect(context.controller.sent).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'read-only' }]);
  });

  test('no controller, or one without negotiated terms, is closed', () => {
    const none = fixture({ withoutController: true });
    none.engine.report({ kind: 'text', data: 'a' });
    expect(none.refusals).toEqual([{ reason: 'closed' }]);
    const unattached = fixture();
    unattached.controller.terms = undefined;
    unattached.engine.report({ kind: 'text', data: 'a' });
    expect(unattached.refusals).toEqual([{ reason: 'closed' }]);
    expect(unattached.controller.sent).toEqual([]);
  });
});

describe('splitting input to the frame budget', () => {
  test('splits at the advertised frame limit without splitting a character or a sequence', () => {
    const controller = createFakeInputController({ maxFrameBytes: 8, maxQueuedOperations: 16 });
    const context = fixture({ controller });
    const text = `\u001b[200~あいう\u001b[201~`;
    context.engine.report({ kind: 'text', data: text });
    for (const chunk of controller.sent) expect(chunk.length).toBeLessThanOrEqual(8);
    expect(sentText(controller)).toBe(text);
    expect(controller.sent.length).toBeGreaterThan(1);
    // A chunk never starts mid-character and never ends mid-sequence.
    expect(
      controller.sent.map((chunk) => new TextDecoder('utf-8', { fatal: true }).decode(chunk)),
    ).toEqual(['\u001b[200~', 'あい', 'う', '\u001b[201~']);
  });

  test('sends a payload of exactly the limit as one operation', () => {
    const controller = createFakeInputController({ maxFrameBytes: 4, maxQueuedOperations: 4 });
    const context = fixture({ controller });
    context.engine.report({ kind: 'text', data: 'abcd' });
    expect(controller.sent).toHaveLength(1);
  });

  test('refuses, and sends nothing, when more operations are needed than the queue can hold', () => {
    const controller = createFakeInputController({ maxFrameBytes: 2, maxQueuedOperations: 2 });
    const context = fixture({ controller });
    context.engine.report({ kind: 'text', data: 'abcdef' });
    expect(controller.sent).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'oversized' }]);
  });

  test('refuses, and sends nothing, when one sequence cannot fit one frame', () => {
    const controller = createFakeInputController({ maxFrameBytes: 4, maxQueuedOperations: 16 });
    const context = fixture({ controller });
    context.engine.report({ kind: 'text', data: 'ab\u001b[200~' });
    expect(controller.sent).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'oversized' }]);
  });

  test('a binary report over the limit is refused whole', () => {
    const controller = createFakeInputController({ maxFrameBytes: 2, maxQueuedOperations: 4 });
    const context = fixture({ controller });
    context.engine.report({ kind: 'binary', data: '\u0080\u0081\u0082' });
    expect(controller.sent).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'oversized' }]);
  });
});

describe('the mouse reporting indicator', () => {
  function ready() {
    const context = fixture({ settings: { mouseReporting: true } });
    context.inner.focus();
    return context;
  }

  test('is reported only when opted in, tracked, captured and writable, announcing engine changes', () => {
    const context = ready();
    expect(context.mouse).toEqual([]);
    context.input.capture();
    expect(context.mouse).toEqual([]);
    context.engine.setMouseTracking(true);
    expect(context.mouse).toEqual([[true, true]]);
    context.engine.setMouseTracking(false);
    expect(context.mouse).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  test('capture changing it is reported without an announcement of its own', () => {
    const context = ready();
    context.engine.mouseTracking = true;
    context.input.capture();
    context.input.release();
    expect(context.mouse).toEqual([
      [true, false],
      [false, false],
    ]);
  });

  test('stays off without the opt-in, however the other conditions stand', () => {
    const context = fixture();
    context.inner.focus();
    context.input.capture();
    context.engine.setMouseTracking(true);
    expect(context.mouse).toEqual([]);
  });

  test('ends quietly when the view stops taking input, and when disposed', () => {
    const context = ready();
    context.input.capture();
    context.engine.setMouseTracking(true);
    context.settings.writable = false;
    context.input.refresh();
    expect(context.mouse.at(-1)).toEqual([false, false]);
    context.settings.writable = true;
    context.input.refresh();
    context.input.capture();
    expect(context.mouse.at(-1)).toEqual([true, false]);
    context.input.dispose();
    expect(context.mouse.at(-1)).toEqual([false, false]);
    context.engine.setMouseTracking(false);
    expect(context.mouse).toHaveLength(4);
  });

  test('repeated mode changes that leave it unchanged report nothing', () => {
    const context = ready();
    context.input.capture();
    context.engine.setMouseTracking(true);
    context.engine.setMouseTracking(true);
    context.input.refresh();
    expect(context.mouse).toEqual([[true, true]]);
  });
});

describe('focus checks across realms', () => {
  /**
   * An element from another realm (a same-origin iframe) is an instance of that realm's `Node` and
   * `Element`, not of this module's. The happy-dom windows share their classes, so the globals are
   * swapped for unrelated ones while `body` runs: every element is then foreign to them.
   */
  function inForeignRealm(body: () => void): void {
    const realNode = globalThis.Node;
    const realElement = globalThis.Element;
    globalThis.Node = class ForeignNode {
      readonly foreign = true;
    } as unknown as typeof Node;
    globalThis.Element = class ForeignElement {
      readonly foreign = true;
    } as unknown as typeof Element;
    try {
      body();
    } finally {
      globalThis.Node = realNode;
      globalThis.Element = realElement;
    }
  }

  function outsideElement(id: string): HTMLElement {
    const element = document.createElement('button');
    element.id = id;
    document.body.append(element);
    hosts.push(element);
    return element;
  }

  test('the swapped globals make a real element foreign', () => {
    inForeignRealm(() => expect(document.body instanceof Node).toBe(false));
  });

  test('focus moving to a terminal control from another realm keeps capture', () => {
    const context = fixture({ isTerminalControl: (node) => 'id' in node && node.id === 'control' });
    const control = outsideElement('control');
    const elsewhere = outsideElement('elsewhere');
    context.inner.focus();
    context.input.capture();
    inForeignRealm(() => {
      context.input.focusLeft(control);
      expect(context.input.captured).toBe(true);
      context.input.focusLeft(elsewhere);
    });
    expect(context.input.captured).toBe(false);
  });

  test('focus moving to an element of another realm inside the host keeps capture', () => {
    const context = fixture();
    context.inner.focus();
    context.input.capture();
    const inside = document.createElement('input');
    context.host.append(inside);
    inForeignRealm(() => context.input.focusLeft(inside));
    expect(context.input.captured).toBe(true);
  });

  test('focus moving to nothing, or to a non-node, releases capture', () => {
    const context = fixture();
    context.inner.focus();
    context.input.capture();
    context.input.focusLeft(null);
    expect(context.input.captured).toBe(false);
    context.input.capture();
    context.input.focusLeft(window);
    expect(context.input.captured).toBe(false);
  });
});

describe('failures freeze input and never replay', () => {
  const codes: Array<[FailureCode, InputRefusalReason]> = [
    ['read-only', 'read-only'],
    ['fifo-full', 'paused'],
    ['frame-too-large', 'oversized'],
    ['transport-failed', 'unknown-delivery'],
    ['backend-failed', 'unknown-delivery'],
    ['stale-generation', 'closed'],
    ['malformed-frame', 'closed'],
  ];

  test.each(codes)('maps the controller failure %s to the refusal %s', (code, reason) => {
    const context = fixture();
    context.controller.outcome = () => ({ ok: false, code });
    context.engine.report({ kind: 'text', data: 'a' });
    expect(context.refusals[0]).toMatchObject({
      reason,
      acceptedOperations: 0,
      totalOperations: 1,
    });
  });

  test('a full queue freezes input: later keystrokes are not sent, not even once capacity returns', () => {
    const context = fixture();
    context.controller.outcome = (index) =>
      index === 0 ? undefined : { ok: false, code: 'fifo-full' };
    context.engine.report({ kind: 'text', data: 'a' });
    context.engine.report({ kind: 'text', data: 'b' });
    // The controller would now accept input again; the view has not been told so.
    context.controller.outcome = () => undefined;
    context.engine.report({ kind: 'text', data: 'c' });
    expect(sentText(context.controller)).toBe('a');
    expect(context.refusals).toEqual([
      { reason: 'paused', acceptedOperations: 0, totalOperations: 1 },
      { reason: 'paused' },
    ]);
  });

  test('input resumes only when the view returns to writable after leaving it', () => {
    const context = fixture();
    context.controller.outcome = (index) =>
      index === 0 ? undefined : { ok: false, code: 'fifo-full' };
    context.engine.report({ kind: 'text', data: 'a' });
    context.engine.report({ kind: 'text', data: 'b' });
    context.controller.outcome = () => undefined;
    // Refreshing while still writable is not a recovery signal.
    context.input.refresh();
    context.engine.report({ kind: 'text', data: 'c' });
    expect(sentText(context.controller)).toBe('a');
    // The host reports the backpressure, then that capacity returned.
    context.settings.writable = false;
    context.input.refresh();
    context.engine.report({ kind: 'text', data: 'd' });
    expect(sentText(context.controller)).toBe('a');
    context.settings.writable = true;
    context.input.refresh();
    context.engine.report({ kind: 'text', data: 'e' });
    expect(sentText(context.controller)).toBe('ae');
  });

  test('a full queue also holds back a paste and a reviewed paste until recovery', () => {
    const context = fixture();
    context.controller.outcome = () => ({ ok: false, code: 'fifo-full' });
    context.engine.report({ kind: 'text', data: 'a' });
    context.host.querySelector('textarea')!.dispatchEvent(pasteEvent('x\ny'));
    expect(context.reviews).toEqual([]);
    expect(context.refusals.at(-1)).toEqual({ reason: 'paused', source: 'paste' });
  });

  test('a failure part-way through an input freezes input and drops the rest, without retry', () => {
    const controller = createFakeInputController({ maxFrameBytes: 2, maxQueuedOperations: 16 });
    const context = fixture({ controller });
    controller.outcome = (index) => (index === 1 ? { ok: false, code: 'fifo-full' } : undefined);
    context.engine.report({ kind: 'text', data: 'abcdef' });
    expect(sentText(controller)).toBe('ab');
    expect(context.refusals).toEqual([
      { reason: 'paused', acceptedOperations: 1, totalOperations: 3 },
    ]);
    // Frozen: later input is dropped, and the failed operation is not tried again.
    controller.outcome = () => undefined;
    context.engine.report({ kind: 'text', data: 'z' });
    expect(sentText(controller)).toBe('ab');
    expect(context.refusals.at(-1)).toEqual({ reason: 'frozen' });
  });

  test('a delivery of unknown outcome freezes input even when nothing else was sent', () => {
    const context = fixture();
    context.controller.outcome = () => ({ throws: new Error('socket closed') });
    context.engine.report({ kind: 'text', data: 'a' });
    context.controller.outcome = () => undefined;
    context.engine.report({ kind: 'text', data: 'b' });
    expect(context.controller.sent).toEqual([]);
    expect(context.refusals).toEqual([
      { reason: 'unknown-delivery', acceptedOperations: 0, totalOperations: 1 },
      { reason: 'frozen' },
    ]);
  });

  test('authority revoked between operations drops the remaining operations', () => {
    const controller = createFakeInputController({ maxFrameBytes: 2, maxQueuedOperations: 16 });
    const context = fixture({ controller });
    controller.outcome = (index) => {
      if (index === 0) controller.authorityRevoked = true;
      return undefined;
    };
    context.engine.report({ kind: 'text', data: 'abcdef' });
    expect(sentText(controller)).toBe('ab');
    expect(context.refusals).toEqual([
      { reason: 'read-only', acceptedOperations: 1, totalOperations: 3 },
    ]);
  });

  test('freezing leaves capture', () => {
    const context = fixture();
    expect(context.input.capture()).toBe(true);
    context.controller.outcome = () => ({ throws: new Error('x') });
    context.engine.report({ kind: 'text', data: 'a' });
    expect(context.input.captured).toBe(false);
    expect(context.captures).toEqual([true, false]);
  });
});

describe('key routing', () => {
  test('page-navigation mode leaves Tab and Shift+Tab to the page; capture sends them on', () => {
    const context = fixture();
    expect(press(context, 'keydown', { key: 'Tab' }).process).toBe(false);
    expect(press(context, 'keydown', { key: 'Tab', shiftKey: true }).process).toBe(false);
    context.input.capture();
    expect(press(context, 'keydown', { key: 'Tab' }).process).toBe(true);
    expect(press(context, 'keydown', { key: 'Tab', shiftKey: true }).process).toBe(true);
  });

  test('the page-navigation Tab is not prevented, so the browser moves focus', () => {
    const context = fixture();
    expect(press(context, 'keydown', { key: 'Tab' }).event.defaultPrevented).toBe(false);
  });

  test('Ctrl+Shift+Escape releases capture once and is consumed on every event of the key', () => {
    const context = fixture();
    context.input.capture();
    const chord = { key: 'Escape', code: 'Escape', ctrlKey: true, shiftKey: true };
    const down = press(context, 'keydown', chord);
    expect(down).toMatchObject({ process: false });
    expect(down.event.defaultPrevented).toBe(true);
    expect(context.input.captured).toBe(false);
    expect(press(context, 'keyup', chord).process).toBe(false);
    expect(context.captures).toEqual([true, false]);
  });

  test('bare Escape is shell input', () => {
    const context = fixture();
    context.input.capture();
    expect(press(context, 'keydown', { key: 'Escape' }).process).toBe(true);
    expect(context.input.captured).toBe(true);
  });

  test('a copy chord with a selection is native: no bytes, no default prevented, no clipboard write', () => {
    const writes: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => writes.push(text) },
    });
    try {
      for (const platform of ['mac', 'other'] as const) {
        const context = fixture({ settings: { platform } });
        context.engine.selection = true;
        const chord = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
        for (const type of ['keydown', 'keypress', 'keyup'] as const) {
          const result = press(context, type, { key: 'c', ...chord });
          expect(result.process).toBe(false);
          expect(result.event.defaultPrevented).toBe(false);
        }
        expect(context.controller.sent).toEqual([]);
      }
      expect(writes).toEqual([]);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  test('Cmd+C without a selection on a Mac sends the interrupt byte once, on keydown only', () => {
    const context = fixture({ settings: { platform: 'mac' } });
    const down = press(context, 'keydown', { key: 'c', metaKey: true });
    expect(down.process).toBe(false);
    expect(down.event.defaultPrevented).toBe(true);
    press(context, 'keypress', { key: 'c', metaKey: true });
    press(context, 'keyup', { key: 'c', metaKey: true });
    expect(sentBytes(context.controller)).toEqual([0x03]);
  });

  test('Ctrl+C without a selection elsewhere is left to the engine, which sends ETX itself', () => {
    const context = fixture();
    expect(press(context, 'keydown', { key: 'c', ctrlKey: true }).process).toBe(true);
    expect(context.controller.sent).toEqual([]);
  });

  test('a read-only view never interrupts', () => {
    const context = fixture({ settings: { platform: 'mac', writable: false } });
    expect(press(context, 'keydown', { key: 'c', metaKey: true }).process).toBe(false);
    expect(context.controller.sent).toEqual([]);
  });

  test('a throwing selection check rejects the key, sends nothing, and is reported', () => {
    const context = fixture({ settings: { platform: 'mac' } });
    context.engine.selection = new Error('selection failed');
    const result = press(context, 'keydown', { key: 'c', metaKey: true });
    expect(result.process).toBe(false);
    expect(result.event.defaultPrevented).toBe(true);
    expect(context.controller.sent).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'hook-failed' }]);
  });

  test('capture is released when the view stops taking input, and not otherwise', () => {
    const context = fixture();
    context.input.capture();
    context.input.refresh();
    expect(context.input.captured).toBe(true);
    context.settings.writable = false;
    context.input.refresh();
    expect(context.input.captured).toBe(false);
    context.input.refresh();
    expect(context.captures).toEqual([true, false]);
  });
});

describe('capture', () => {
  test('enters capture only after focus actually landed in the terminal', () => {
    const context = fixture();
    expect(document.activeElement).not.toBe(context.inner);
    expect(context.input.capture()).toBe(true);
    expect(document.activeElement).toBe(context.inner);
    expect(context.input.captured).toBe(true);
    // Entering again is not another transition.
    expect(context.input.capture()).toBe(true);
    expect(context.captures).toEqual([true]);
  });

  test('does not enter capture when focus cannot land', () => {
    const context = fixture();
    context.engine.focusTarget = undefined;
    expect(context.input.capture()).toBe(false);
    expect(context.input.captured).toBe(false);
    expect(context.captures).toEqual([]);
  });

  test('does not enter capture for a view that takes no input', () => {
    const context = fixture({ settings: { writable: false } });
    expect(context.input.capture()).toBe(false);
    expect(document.activeElement).not.toBe(context.inner);
  });

  test('leaves capture when focus leaves the terminal, and stays when it moves inside', () => {
    const context = fixture();
    const outside = document.createElement('button');
    document.body.append(outside);
    const second = document.createElement('input');
    context.host.append(second);
    context.input.capture();
    second.focus();
    expect(context.input.captured).toBe(true);
    outside.focus();
    expect(context.input.captured).toBe(false);
    outside.remove();
  });

  test('release leaves capture, and is quiet when not captured', () => {
    const context = fixture();
    context.input.release();
    context.input.capture();
    context.input.release();
    expect(context.captures).toEqual([true, false]);
  });
});

describe('interrupt', () => {
  test('sends the interrupt byte', () => {
    const context = fixture();
    context.input.interrupt();
    expect(sentBytes(context.controller)).toEqual([0x03]);
  });

  test('sends nothing for a view that takes no input', () => {
    const context = fixture({ settings: { writable: false } });
    context.input.interrupt();
    expect(context.controller.sent).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'read-only', source: 'interrupt' }]);
  });
});

describe('paste', () => {
  function paste(context: Fixture, text: string | undefined): Event {
    const event = pasteEvent(text);
    context.inner.dispatchEvent(event);
    return event;
  }

  test('intercepts the event before the engine can see it', () => {
    const context = fixture();
    let engineSaw = 0;
    context.inner.addEventListener('paste', () => (engineSaw += 1));
    const event = paste(context, 'one line');
    expect(event.defaultPrevented).toBe(true);
    expect(engineSaw).toBe(0);
  });

  test('sends a plain single line straight through the engine, with no review', () => {
    const context = fixture();
    paste(context, 'echo hello');
    expect(context.engine.pastes).toEqual(['echo hello']);
    expect(context.reviews).toEqual([]);
  });

  test('holds a multiline paste for review and sends nothing yet', () => {
    const context = fixture();
    paste(context, 'ls\nrm -rf build\n');
    expect(context.engine.pastes).toEqual([]);
    expect(context.reviews).toHaveLength(1);
    expect(context.reviews[0]).toMatchObject({
      kind: 'confirm',
      text: 'ls\nrm -rf build\n',
      visibleText: 'ls␊\nrm -rf build␊\n',
      endsWithNewline: true,
      lines: 2,
    });
  });

  test('holds a control-bearing paste for review', () => {
    const context = fixture();
    paste(context, 'echo \u001b[31mred');
    expect(context.reviews[0]).toMatchObject({ kind: 'confirm', controlCount: 1 });
  });

  test('accepting sends the exact text through the engine once, and closes the review', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    context.input.acceptPaste();
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual(['a\nb\n']);
    expect(context.reviews.at(-1)).toBeUndefined();
  });

  test('cancelling sends nothing and closes the review', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    context.input.cancelPaste();
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual([]);
    expect(context.reviews).toHaveLength(2);
    expect(context.reviews.at(-1)).toBeUndefined();
  });

  test('cancelling with no review open does nothing', () => {
    const context = fixture();
    context.input.cancelPaste();
    expect(context.reviews).toEqual([]);
  });

  test('a paste over the size limit is shown as rejected, keeps none of its text, and cannot be accepted', () => {
    const context = fixture({ settings: { maximumPasteBytes: 8 } });
    paste(context, 'x'.repeat(9));
    expect(context.reviews[0]).toEqual({ kind: 'rejected', bytes: 9, maximumBytes: 8 });
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual([]);
    expect(context.refusals).toEqual([]);
  });

  test('a single line over the size limit is also rejected', () => {
    const context = fixture({ settings: { maximumPasteBytes: 4 } });
    paste(context, 'abcde');
    expect(context.reviews[0]).toMatchObject({ kind: 'rejected' });
    expect(context.engine.pastes).toEqual([]);
  });

  test('a read-only view takes no paste and shows no review', () => {
    const context = fixture({ settings: { writable: false } });
    const event = paste(context, 'a\nb');
    expect(event.defaultPrevented).toBe(true);
    expect(context.reviews).toEqual([]);
    expect(context.engine.pastes).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'read-only', source: 'paste' }]);
  });

  test('permission revoked while the reader decides drops the paste, without queueing it', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    context.controller.authorityRevoked = true;
    context.input.acceptPaste();
    context.controller.authorityRevoked = false;
    expect(context.engine.pastes).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'read-only', source: 'paste' }]);
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual([]);
  });

  test('a limit lowered while the reader decides still applies', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    context.settings.maximumPasteBytes = 3;
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual([]);
    expect(context.refusals).toEqual([{ reason: 'oversized', source: 'paste' }]);
  });

  test('capture that was on when the review opened returns when asked to resume', () => {
    const context = fixture();
    context.inner.focus();
    context.input.capture();
    paste(context, 'a\nb\n');
    // The dialog took focus, which ended capture.
    context.host.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
    expect(context.input.captured).toBe(false);
    context.input.cancelPaste();
    expect(context.input.captured).toBe(false);
    context.input.resumeCapture();
    expect(context.input.captured).toBe(true);
    // It resumes once: a second call finds nothing pending.
    context.input.release();
    context.input.resumeCapture();
    expect(context.input.captured).toBe(false);
  });

  test('resuming does nothing when capture was off, or the view stopped taking input', () => {
    const context = fixture();
    context.inner.focus();
    paste(context, 'a\nb\n');
    context.input.cancelPaste();
    context.input.resumeCapture();
    expect(context.input.captured).toBe(false);
    context.input.capture();
    paste(context, 'c\nd\n');
    context.input.cancelPaste();
    context.settings.writable = false;
    context.input.refresh();
    context.input.resumeCapture();
    expect(context.input.captured).toBe(false);
  });

  test('an accepted paste is sent exactly as read, markers included, even when the engine brackets', () => {
    const context = fixture();
    context.engine.bracketedPaste = true;
    paste(context, 'a\n\u001b[201~rm -rf ~\n\u001b[200~b');
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual(['a\n\u001b[201~rm -rf ~\n\u001b[200~b']);
  });

  test('a plain single line is reviewed when the engine brackets, and not otherwise', () => {
    const context = fixture();
    paste(context, 'ls -la');
    expect(context.reviews).toEqual([]);
    expect(context.engine.pastes).toEqual(['ls -la']);
    context.engine.bracketedPaste = true;
    paste(context, 'ls -la');
    expect(context.reviews).toHaveLength(1);
    expect(context.engine.pastes).toEqual(['ls -la']);
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual(['ls -la', 'ls -la']);
  });

  test.each([
    [false, true],
    [true, false],
  ])(
    'a review opened with bracketed paste %p is shown again, not sent, when the mode becomes %p',
    (before, after) => {
      const context = fixture();
      context.engine.bracketedPaste = before;
      paste(context, 'a\n\u001b[201~b\n');
      expect(context.reviews).toHaveLength(1);
      context.engine.bracketedPaste = after;
      context.input.acceptPaste();
      // What the reader approved described the old mode, so nothing is sent yet.
      expect(context.engine.pastes).toEqual([]);
      expect(context.reviews).toHaveLength(2);
      expect(context.reviews.at(-1)).toMatchObject({ kind: 'confirm', bracketedPaste: after });
      context.input.acceptPaste();
      expect(context.engine.pastes).toEqual(['a\n\u001b[201~b\n']);
      expect(context.reviews.at(-1)).toBeUndefined();
    },
  );

  test('a paste is sent as read when the engine does not bracket', () => {
    const context = fixture();
    paste(context, 'a\n\u001b[201~b');
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual(['a\n\u001b[201~b']);
  });

  test('another paste while one is under review is ignored', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    const second = paste(context, 'c\nd\n');
    expect(second.defaultPrevented).toBe(true);
    expect(context.reviews).toHaveLength(1);
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual(['a\nb\n']);
  });

  test('an empty or missing clipboard is ignored', () => {
    const context = fixture();
    paste(context, '');
    paste(context, undefined);
    expect(context.reviews).toEqual([]);
    expect(context.engine.pastes).toEqual([]);
    expect(context.refusals).toEqual([]);
  });

  test('the keyboard belongs to the review while it is open', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    for (const init of [{ key: 'Escape' }, { key: 'Enter' }, { key: 'a' }, { key: 'Tab' }]) {
      expect(press(context, 'keydown', init).process).toBe(false);
    }
    expect(context.controller.sent).toEqual([]);
    context.input.cancelPaste();
    expect(press(context, 'keydown', { key: 'a' }).process).toBe(true);
  });

  test('the press that closed the review does not reach the shell when it continues', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    document.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter' }));
    context.input.acceptPaste();
    // Focus returned to the terminal mid-press: its keypress and keyup arrive at the engine.
    expect(press(context, 'keydown', { key: 'Enter', code: 'Enter' }).process).toBe(false);
    expect(press(context, 'keypress', { key: 'Enter', code: 'Enter' }).process).toBe(false);
    expect(press(context, 'keyup', { key: 'Enter', code: 'Enter' }).process).toBe(false);
    // The next press of the same key is ordinary input again.
    expect(press(context, 'keydown', { key: 'Enter', code: 'Enter' }).process).toBe(true);
    expect(press(context, 'keyup', { key: 'Enter', code: 'Enter' }).process).toBe(true);
  });

  test('a latched key whose keyup never arrives is forgotten when focus leaves the terminal', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    document.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter' }));
    context.input.acceptPaste();
    // Focus goes elsewhere before the key comes up, so the keyup is never seen here.
    context.inner.focus();
    context.inner.blur();
    expect(press(context, 'keydown', { key: 'Enter', code: 'Enter' }).process).toBe(true);
  });

  test('a latched key whose keyup lands outside the terminal is forgotten', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    document.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter' }));
    context.input.acceptPaste();
    // The dialog is still fading out and holds focus when the key comes up.
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.dispatchEvent(keyEvent('keyup', { key: 'Enter', code: 'Enter' }));
    outside.remove();
    expect(press(context, 'keydown', { key: 'Enter', code: 'Enter' }).process).toBe(true);
  });

  test('a key released before the review closed leaves no latch', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    document.dispatchEvent(keyEvent('keydown', { key: 'Escape', code: 'Escape' }));
    document.dispatchEvent(keyEvent('keyup', { key: 'Escape', code: 'Escape' }));
    context.input.cancelPaste();
    expect(press(context, 'keydown', { key: 'Escape', code: 'Escape' }).process).toBe(true);
  });

  test('a key with no code is tracked by its key name', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    document.dispatchEvent(keyEvent('keydown', { key: 'Enter' }));
    context.input.cancelPaste();
    expect(press(context, 'keydown', { key: 'Enter' }).process).toBe(false);
  });

  test('stops tracking keys once the review closed', () => {
    const context = fixture();
    paste(context, 'a\nb\n');
    context.input.cancelPaste();
    document.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter' }));
    expect(press(context, 'keydown', { key: 'Enter', code: 'Enter' }).process).toBe(true);
  });
});

describe('dispose', () => {
  test('stops reporting, routing and pasting, and is safe to repeat', () => {
    const context = fixture();
    context.input.capture();
    const hook = context.engine.hook!;
    context.input.dispose();
    context.input.dispose();
    expect(context.engine.listeners.size).toBe(0);
    expect(context.engine.hook).toBeUndefined();
    expect(hook(keyEvent('keydown', { key: 'a' }))).toBe(false);
    context.engine.report({ kind: 'text', data: 'late' });
    expect(context.controller.sent).toEqual([]);
    expect(context.captures).toEqual([true, false]);
  });

  test('drops an open review and never sends it later', () => {
    const context = fixture();
    context.inner.dispatchEvent(pasteEvent('a\nb\n'));
    context.input.dispose();
    expect(context.reviews.at(-1)).toBeUndefined();
    context.input.acceptPaste();
    expect(context.engine.pastes).toEqual([]);
  });

  test('stops intercepting paste and tracking focus', () => {
    const context = fixture();
    context.input.dispose();
    let engineSaw = 0;
    context.inner.addEventListener('paste', () => (engineSaw += 1));
    const event = pasteEvent('x');
    context.inner.dispatchEvent(event);
    expect(engineSaw).toBe(1);
    expect(event.defaultPrevented).toBe(false);
    context.input.capture();
    expect(context.input.captured).toBe(false);
  });
});

describe('copying the terminal selection', () => {
  test('the copy chord with a selection reports the copy on keydown only, and the copy event that follows is not reported again', () => {
    const context = fixture();
    context.engine.selection = true;
    const keydown = keyEvent('keydown', { key: 'c', ctrlKey: true });
    expect(context.engine.hook!(keydown)).toBe(false);
    expect(keydown.defaultPrevented).toBe(false);
    context.engine.hook!(keyEvent('keyup', { key: 'c', ctrlKey: true }));
    expect(context.copies).toEqual([1]);
    context.inner.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
    expect(context.copies).toEqual([1]);
    expect(context.controller.sent).toEqual([]);
  });

  test('the copy chord with no selection reports nothing', () => {
    const context = fixture({ settings: { platform: 'mac' } });
    context.engine.selection = false;
    context.engine.hook!(keyEvent('keydown', { key: 'c', metaKey: true }));
    expect(context.copies).toEqual([]);
  });

  const copyEvent = () => new Event('copy', { bubbles: true, cancelable: true });

  test('reports a copy of the engine selection once, and leaves the native copy alone', () => {
    const context = fixture();
    context.engine.selection = true;
    const event = copyEvent();
    context.inner.dispatchEvent(event);
    expect(context.copies).toEqual([1]);
    expect(event.defaultPrevented).toBe(false);
    expect(context.controller.sent).toEqual([]);
    expect(context.refusals).toEqual([]);
  });

  test('reports each copy, so a second copy is announced again', () => {
    const context = fixture();
    context.engine.selection = true;
    context.inner.dispatchEvent(copyEvent());
    context.inner.dispatchEvent(copyEvent());
    expect(context.copies).toEqual([1, 2]);
  });

  test('says nothing when the engine has no selection', () => {
    const context = fixture();
    context.engine.selection = false;
    context.inner.dispatchEvent(copyEvent());
    expect(context.copies).toEqual([]);
  });

  test('says nothing for a copy that began outside the terminal', () => {
    const context = fixture();
    context.engine.selection = true;
    const outside = document.createElement('p');
    document.body.append(outside);
    outside.dispatchEvent(copyEvent());
    outside.remove();
    expect(context.copies).toEqual([]);
  });

  test('reports a copy from a view that takes no input, and still sends nothing', () => {
    const context = fixture({ settings: { writable: false } });
    context.engine.selection = true;
    context.inner.dispatchEvent(copyEvent());
    expect(context.copies).toEqual([1]);
    expect(context.controller.sent).toEqual([]);
  });

  test('stops listening once disposed', () => {
    const context = fixture();
    context.engine.selection = true;
    context.input.dispose();
    context.inner.dispatchEvent(copyEvent());
    expect(context.copies).toEqual([]);
  });
});
