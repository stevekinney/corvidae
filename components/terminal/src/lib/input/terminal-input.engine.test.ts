import { afterEach, describe, expect, test } from 'bun:test';

import {
  createCapturedEngine,
  type CapturedEngine,
} from '../components/terminal/terminal-corpus-test-support.ts';
import { settle, waitFor } from '../components/terminal/terminal-test-support.ts';
import {
  createFakeInputController,
  createInputSettings,
  dispatchComposition,
  emitBinaryReport,
  keyEvent,
  pasteEvent,
  recordScrollRequests,
  sentBytes,
  sentText,
  typeKey,
  type FakeInputController,
} from './input-test-support.ts';
import type { InputRefusal, InputSettings } from './input-types.ts';
import type { PasteReview } from './paste-review.ts';
import { createTerminalInput, type TerminalInput } from './terminal-input.ts';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

type Session = {
  captured: CapturedEngine;
  host: HTMLElement;
  textarea: HTMLTextAreaElement;
  controller: FakeInputController;
  input: TerminalInput;
  settings: InputSettings;
  refusals: InputRefusal[];
  reviews: Array<PasteReview | undefined>;
};

const sessions: Session[] = [];

function session(
  options: {
    readOnly?: boolean;
    settings?: Partial<InputSettings>;
    terms?: FakeInputController['terms'];
    engine?: (
      engine: CapturedEngine['engine'],
    ) => Parameters<typeof createTerminalInput>[0]['engine'];
  } = {},
): Session {
  const host = document.createElement('div');
  document.body.append(host);
  const captured = createCapturedEngine({ readOnly: options.readOnly ?? false });
  captured.engine.mount(host);
  const controller = createFakeInputController(options.terms);
  const settings = createInputSettings({
    writable: !(options.readOnly ?? false),
    ...options.settings,
  });
  const refusals: InputRefusal[] = [];
  const reviews: Array<PasteReview | undefined> = [];
  const input = createTerminalInput({
    engine: options.engine?.(captured.engine) ?? captured.engine,
    host,
    controller,
    readSettings: () => settings,
    onCaptureChange: () => {},
    onReview: (review) => reviews.push(review),
    onRefused: (refusal) => refusals.push(refusal),
  });
  const created = {
    captured,
    host,
    textarea: captured.terminal.textarea!,
    controller,
    input,
    settings,
    refusals,
    reviews,
  };
  sessions.push(created);
  return created;
}

afterEach(() => {
  for (const created of sessions.splice(0)) {
    created.input.dispose();
    created.captured.engine.dispose();
    created.host.remove();
  }
});

const ENTER = { key: 'Enter', code: 'Enter', keyCode: 13 };

describe('exact outbound bytes from the real engine', () => {
  test('printable keys, Enter, Backspace and arrows', () => {
    const { textarea, controller } = session();
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    typeKey(textarea, { key: 'Z', code: 'KeyZ', keyCode: 90, shiftKey: true, charCode: 90 });
    typeKey(textarea, ENTER);
    typeKey(textarea, { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    typeKey(textarea, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 });
    expect(sentBytes(controller)).toEqual([0x61, 0x5a, 0x0d, 0x7f, 0x1b, 0x5b, 0x44]);
  });

  test('control and function keys keep their sequences', () => {
    const { textarea, controller } = session();
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true });
    typeKey(textarea, { key: 'F1', code: 'F1', keyCode: 112 });
    typeKey(textarea, { key: 'F12', code: 'F12', keyCode: 123 });
    typeKey(textarea, { key: 'Home', code: 'Home', keyCode: 36 });
    expect(sentText(controller)).toBe('\u0001\u001bOP\u001b[24~\u001b[H');
  });

  test('application cursor mode changes what an arrow sends', async () => {
    const { textarea, controller, captured } = session();
    await captured.deliver([bytes('\u001b[?1h')]);
    typeKey(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 });
    expect(sentText(controller)).toBe('\u001bOA');
  });

  test('the numeric keypad sends what the engine reports, with application keypad mode set', async () => {
    const { textarea, controller, captured } = session();
    await captured.deliver([bytes('\u001b=')]);
    typeKey(textarea, { key: '7', code: 'Numpad7', keyCode: 103, charCode: 55 });
    typeKey(textarea, { key: 'Enter', code: 'NumpadEnter', keyCode: 13 });
    expect(sentText(controller)).toBe('7\r');
  });

  test('a binary report goes out as raw bytes and a text report as UTF-8', () => {
    const { captured, controller } = session();
    emitBinaryReport(captured.terminal, '\u0080ÿ');
    captured.terminal.input('\u0080', true);
    expect(controller.sent.map((chunk) => [...chunk])).toEqual([
      [0x80, 0xff],
      [0xc2, 0x80],
    ]);
  });
});

describe('IME composition and dead keys', () => {
  test('an IME commit is sent once, with nothing sent while composing', async () => {
    const { textarea, controller } = session();
    textarea.focus();
    dispatchComposition(textarea, 'compositionstart');
    // Keys typed during composition belong to the input method: keyCode 229, no bytes.
    typeKey(textarea, { key: 'Process', code: 'KeyA', keyCode: 229, isComposing: true });
    dispatchComposition(textarea, 'compositionupdate', 'あ');
    typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 229, isComposing: true });
    expect(controller.sent).toEqual([]);
    textarea.value = 'あ';
    dispatchComposition(textarea, 'compositionend', 'あ');
    // The engine commits a composition on its next timer turn: wait for that, then for one more
    // turn, in which a duplicate commit would have been sent.
    await waitFor(() => controller.sent.length > 0, 'the composition to be committed');
    await settle();
    expect(sentBytes(controller)).toEqual([0xe3, 0x81, 0x82]);
    expect(controller.sent).toHaveLength(1);
  });

  test('a dead key then its base letter sends the one composed character', () => {
    const { textarea, controller } = session();
    typeKey(textarea, { key: 'Dead', code: 'Quote', keyCode: 222 });
    typeKey(textarea, { key: 'é', code: 'KeyE', keyCode: 69, charCode: 233 });
    expect(sentBytes(controller)).toEqual([0xc3, 0xa9]);
  });

  test('typing Tab during composition does not leave the terminal', () => {
    const { textarea } = session();
    const { keydown } = typeKey(textarea, {
      key: 'Tab',
      code: 'Tab',
      keyCode: 229,
      isComposing: true,
    });
    expect(keydown.defaultPrevented).toBe(false);
  });
});

describe('read-only', () => {
  test('typing sends nothing and automatic query replies are suppressed, separately', async () => {
    const typed = session({ readOnly: true });
    typeKey(typed.textarea, ENTER);
    typeKey(typed.textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(typed.controller.sent).toEqual([]);

    const queried = session({ readOnly: true });
    await queried.captured.deliver([bytes('\u001b[c\u001b[6n\u001b[>c')]);
    expect(queried.controller.sent).toEqual([]);
    expect(queried.captured.replies).toEqual([]);

    const writable = session();
    await writable.captured.deliver([bytes('\u001b[c')]);
    expect(sentText(writable.controller).startsWith('\u001b[?')).toBe(true);
  });

  test('stale settings cannot let a reply through before the engine is updated', async () => {
    // The engine is still writable but the state already says read-only: the client gate holds.
    const { captured, controller, settings, refusals } = session();
    settings.writable = false;
    await captured.deliver([bytes('\u001b[c')]);
    expect(controller.sent).toEqual([]);
    expect(refusals[0]).toMatchObject({ reason: 'read-only' });
  });

  test('scrolling keys still scroll, and the selection survives, with no bytes sent', async () => {
    const { captured, textarea, controller } = session({ readOnly: true });
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index}\r\n`).join('');
    await captured.deliver([bytes(lines)]);
    captured.terminal.select(0, 0, 4);
    expect(captured.engine.hasSelection()).toBe(true);
    // happy-dom has no layout, so the scroll position cannot move; the engine's scroll request is
    // observable instead.
    const requests = recordScrollRequests(captured.terminal);
    const typed = typeKey(textarea, {
      key: 'PageUp',
      code: 'PageUp',
      keyCode: 33,
      shiftKey: true,
    });
    expect(requests).toEqual([-(captured.terminal.rows - 1)]);
    expect(typed.keydown.defaultPrevented).toBe(true);
    expect(captured.engine.hasSelection()).toBe(true);
    expect(controller.sent).toEqual([]);
  });

  test('Tab and Shift+Tab are left to the page', () => {
    const { textarea } = session({ readOnly: true });
    expect(
      typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9 }).keydown.defaultPrevented,
    ).toBe(false);
  });
});

describe('Tab and capture against the real engine', () => {
  test('page-navigation mode leaves Tab to the page; capture mode sends it to the shell', () => {
    const { textarea, controller, input } = session();
    const page = typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(page.keydown.defaultPrevented).toBe(false);
    expect(controller.sent).toEqual([]);
    input.capture();
    const captured = typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(captured.keydown.defaultPrevented).toBe(true);
    const shifted = typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true });
    expect(shifted.keydown.defaultPrevented).toBe(true);
    expect(sentText(controller)).toBe('\t\u001b[Z');
  });

  test('Ctrl+Shift+Escape releases capture; bare Escape reaches the shell', () => {
    const { textarea, controller, input } = session();
    input.capture();
    typeKey(textarea, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(input.captured).toBe(true);
    typeKey(textarea, {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      ctrlKey: true,
      shiftKey: true,
    });
    expect(input.captured).toBe(false);
    expect(sentText(controller)).toBe('\u001b');
  });

  test('a copy chord with a selection sends nothing and leaves the default alone', async () => {
    const { captured, textarea, controller } = session({ settings: { platform: 'other' } });
    await captured.deliver([bytes('selected text')]);
    captured.terminal.select(0, 0, 8);
    const copy = typeKey(textarea, { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true });
    expect(copy.keydown.defaultPrevented).toBe(false);
    expect(controller.sent).toEqual([]);
    captured.terminal.clearSelection();
    typeKey(textarea, { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true });
    expect(sentBytes(controller)).toEqual([0x03]);
  });

  test('Cmd+C with no selection on a Mac sends one interrupt, and a selection suppresses it', async () => {
    const { captured, textarea, controller } = session({ settings: { platform: 'mac' } });
    typeKey(textarea, { key: 'c', code: 'KeyC', keyCode: 67, metaKey: true });
    expect(sentBytes(controller)).toEqual([0x03]);
    await captured.deliver([bytes('text')]);
    captured.terminal.select(0, 0, 4);
    typeKey(textarea, { key: 'c', code: 'KeyC', keyCode: 67, metaKey: true });
    expect(controller.sent).toHaveLength(1);
  });

  test('reserved chords reach neither the shell nor the default handler', () => {
    const { textarea, controller } = session({ settings: { platform: 'mac' } });
    for (const key of ['l', 't', 'w']) {
      const typed = typeKey(textarea, { key, code: `Key${key.toUpperCase()}`, metaKey: true });
      expect(typed.keydown.defaultPrevented).toBe(false);
    }
    expect(controller.sent).toEqual([]);
  });
});

describe('a throwing key hook rejects the operation', () => {
  test('sends no bytes, prevents the key, and the engine skips it', () => {
    const { textarea, controller, refusals } = session({
      settings: { platform: 'mac' },
      engine: (engine) => ({
        onInput: (listener) => engine.onInput(listener),
        setKeyHook: (hook) => engine.setKeyHook(hook),
        focus: () => engine.focus(),
        paste: (text) => engine.paste(text),
        bracketedPaste: engine.bracketedPaste,
        mouseTracking: engine.mouseTracking,
        onModeChange: (listener) => engine.onModeChange(listener),
        hasSelection: () => {
          throw new Error('selection exploded');
        },
      }),
    });
    const typed = typeKey(textarea, { key: 'c', code: 'KeyC', keyCode: 67, metaKey: true });
    expect(typed.keydown.defaultPrevented).toBe(true);
    expect(controller.sent).toEqual([]);
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.every((refusal) => refusal.reason === 'hook-failed')).toBe(true);
  });
});

describe('paste against the real engine', () => {
  function pasteInto(context: Session, text: string): Event {
    const event = pasteEvent(text);
    context.textarea.dispatchEvent(event);
    return event;
  }

  test('a bracketed multiline paste is reviewed, then sent exactly with its trailing newline', async () => {
    const context = session();
    await context.captured.deliver([bytes('\u001b[?2004h')]);
    pasteInto(context, 'echo one\necho two\n');
    expect(context.controller.sent).toEqual([]);
    expect(context.reviews[0]).toMatchObject({ kind: 'confirm', endsWithNewline: true, lines: 2 });
    context.input.acceptPaste();
    expect(sentText(context.controller)).toBe('\u001b[200~echo one\recho two\r\u001b[201~');
  });

  test('a bracketed paste keeps its payload exactly, embedded markers included', async () => {
    const context = session();
    await context.captured.deliver([bytes('\u001b[?2004h')]);
    pasteInto(context, 'echo hi\n\u001b[201~rm -rf ~\n\u001b[200~echo done\n');
    expect(context.reviews[0]).toMatchObject({
      kind: 'confirm',
      containsPasteTerminator: true,
      bracketedPaste: true,
    });
    context.input.acceptPaste();
    expect(sentText(context.controller)).toBe(
      '\u001b[200~echo hi\r\u001b[201~rm -rf ~\r\u001b[200~echo done\r\u001b[201~',
    );
  });

  test('a plain single line is reviewed when bracketed mode is on, and sent exactly once accepted', async () => {
    const context = session();
    await context.captured.deliver([bytes('\u001b[?2004h')]);
    pasteInto(context, 'ls -la');
    expect(context.controller.sent).toEqual([]);
    expect(context.reviews[0]).toMatchObject({ kind: 'confirm', lines: 1 });
    context.input.acceptPaste();
    expect(sentText(context.controller)).toBe('\u001b[200~ls -la\u001b[201~');
  });

  test('without bracketed paste mode the text goes as pasted, markers included', () => {
    const context = session();
    pasteInto(context, 'a\n\u001b[201~b');
    context.input.acceptPaste();
    expect(sentText(context.controller)).toBe('a\r\u001b[201~b');
  });

  test('an unbracketed multiline paste is reviewed too and keeps its line structure', () => {
    const context = session();
    pasteInto(context, 'a\nb');
    context.input.acceptPaste();
    expect(sentText(context.controller)).toBe('a\rb');
  });

  test('a single plain line is sent without review', () => {
    const context = session();
    pasteInto(context, 'ls -la');
    expect(context.reviews).toEqual([]);
    expect(sentText(context.controller)).toBe('ls -la');
  });

  test('cancelling a review sends nothing, then or later', () => {
    const context = session();
    pasteInto(context, 'a\nb');
    context.input.cancelPaste();
    context.input.acceptPaste();
    expect(context.controller.sent).toEqual([]);
  });

  test('a read-only view takes no paste at all', () => {
    const context = session({ readOnly: true });
    pasteInto(context, 'a\nb');
    expect(context.reviews).toEqual([]);
    expect(context.controller.sent).toEqual([]);
  });

  test('a large paste is chunked between atoms and every byte arrives in order', async () => {
    const context = session({ terms: { maxFrameBytes: 64, maxQueuedOperations: 256 } });
    await context.captured.deliver([bytes('\u001b[?2004h')]);
    const text = 'line ありがとう \u001b[31mred\u001b[0m\n'.repeat(30);
    pasteInto(context, text);
    context.input.acceptPaste();
    const expected = `\u001b[200~${text.replaceAll('\n', '\r')}\u001b[201~`;
    expect(sentText(context.controller)).toBe(expected);
    expect(context.controller.sent.length).toBeGreaterThan(5);
    for (const chunk of context.controller.sent) expect(chunk.length).toBeLessThanOrEqual(64);
    // The bracket markers each travel whole.
    const sequence = context.controller.sent.map((chunk) => new TextDecoder().decode(chunk));
    expect(sequence[0]!.startsWith('\u001b[200~')).toBe(true);
    expect(sequence.at(-1)!.endsWith('\u001b[201~')).toBe(true);
  });

  test('revocation during a chunked paste stops it, sends the rest to nobody, and freezes input', async () => {
    const context = session({ terms: { maxFrameBytes: 16, maxQueuedOperations: 256 } });
    context.controller.outcome = (index) => {
      if (index === 1) context.controller.authorityRevoked = true;
      return undefined;
    };
    pasteInto(context, 'first line\nsecond line\nthird line\n');
    context.input.acceptPaste();
    const sentSoFar = context.controller.sent.length;
    expect(sentSoFar).toBe(2);
    expect(context.refusals.at(-1)).toMatchObject({ reason: 'read-only', acceptedOperations: 2 });
    // Nothing more is sent later, even when authority comes back: the paste is not replayed.
    context.controller.authorityRevoked = false;
    typeKey(context.textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(context.controller.sent).toHaveLength(sentSoFar);
  });

  test('an ambiguous delivery mid-paste is never retried or replayed', () => {
    const context = session({ terms: { maxFrameBytes: 8, maxQueuedOperations: 256 } });
    context.controller.outcome = (index) =>
      index === 2 ? { throws: new Error('socket closed mid-send') } : undefined;
    pasteInto(context, 'aaaaaaaa\nbbbbbbbb\ncccccccc\n');
    context.input.acceptPaste();
    expect(context.controller.sent).toHaveLength(2);
    expect(context.refusals.at(-1)).toMatchObject({
      reason: 'unknown-delivery',
      acceptedOperations: 2,
    });
    context.controller.outcome = () => undefined;
    typeKey(context.textarea, ENTER);
    expect(context.controller.sent).toHaveLength(2);
  });
});

describe('resize and dispose', () => {
  test('resizing the engine sends no input', () => {
    const { captured, controller } = session();
    captured.engine.resize({ columns: 100, rows: 30 });
    captured.engine.resize({ columns: 40, rows: 10 });
    expect(controller.sent).toEqual([]);
  });

  test('after dispose the engine still types but nothing is sent, and a pending review is gone', () => {
    const context = session();
    pasteInto(context, 'a\nb');
    context.input.dispose();
    typeKey(context.textarea, ENTER);
    context.input.acceptPaste();
    expect(context.controller.sent).toEqual([]);
    expect(context.reviews.at(-1)).toBeUndefined();
  });

  function pasteInto(context: Session, text: string): void {
    context.textarea.dispatchEvent(pasteEvent(text));
  }

  test('a key that was down when the engine is disposed is not decided by a dead hook', () => {
    const context = session();
    const down = keyEvent('keydown', { key: 'a' });
    context.input.dispose();
    context.textarea.dispatchEvent(down);
    expect(context.controller.sent).toEqual([]);
  });
});
