import { afterEach, describe, expect, test } from 'bun:test';

import {
  dispatchComposition,
  emitBinaryReport,
  keyEvent,
  typeKey,
} from '../../input/input-test-support.ts';
import { createCapturedEngine, type CapturedEngine } from './terminal-corpus-test-support.ts';
import type { EngineInputReport } from './terminal-engine-adapter.ts';
import { waitFor } from './terminal-test-support.ts';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

const hosts: HTMLElement[] = [];
const captures: CapturedEngine[] = [];

function mounted(options: Parameters<typeof createCapturedEngine>[0] = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const captured = createCapturedEngine(options);
  captured.engine.mount(host);
  captures.push(captured);
  const reports: EngineInputReport[] = [];
  const stop = captured.engine.onInput((report) => reports.push(report));
  return { captured, reports, stop, textarea: captured.terminal.textarea! };
}

afterEach(() => {
  for (const captured of captures.splice(0)) captured.engine.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

describe('onInput', () => {
  test('reports typed keys as text, in order', () => {
    const { reports, textarea } = mounted();
    typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    typeKey(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 });
    expect(reports).toEqual([
      { kind: 'text', data: '\r' },
      { kind: 'text', data: '\u001b[A' },
    ]);
  });

  test('reports binary reports as binary, distinct from text', () => {
    const { captured, reports } = mounted();
    emitBinaryReport(captured.terminal, '\u0080ÿ');
    captured.terminal.input('\u0080', true);
    expect(reports).toEqual([
      { kind: 'binary', data: '\u0080ÿ' },
      { kind: 'text', data: '\u0080' },
    ]);
  });

  test('stops reporting once unsubscribed, for both shapes', () => {
    const { captured, reports, stop, textarea } = mounted();
    stop();
    typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    emitBinaryReport(captured.terminal, 'x');
    expect(reports).toEqual([]);
  });

  test('a read-only engine reports nothing, neither typing nor automatic replies', async () => {
    const { captured, reports, textarea } = mounted({ readOnly: true });
    typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    emitBinaryReport(captured.terminal, 'x');
    await captured.deliver([bytes('\u001b[c\u001b[6n')]);
    expect(reports).toEqual([]);
  });

  test('a writable engine reports the automatic reply to a terminal query', async () => {
    const { captured, reports } = mounted();
    await captured.deliver([bytes('\u001b[c')]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe('text');
    expect(reports[0]!.data.startsWith('\u001b[?')).toBe(true);
  });

  test('reports an IME commit once', async () => {
    const { reports, textarea } = mounted();
    textarea.focus();
    dispatchComposition(textarea, 'compositionstart');
    dispatchComposition(textarea, 'compositionupdate', 'あ');
    textarea.value = 'あ';
    dispatchComposition(textarea, 'compositionend', 'あ');
    await waitFor(() => reports.length > 0, 'the composition commit');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reports).toEqual([{ kind: 'text', data: 'あ' }]);
  });
});

describe('setKeyHook', () => {
  test('skips an event only when the hook returns exactly false', () => {
    const { reports, textarea, captured } = mounted();
    const seen: string[] = [];
    captured.engine.setKeyHook((event) => {
      seen.push(event.type);
      return false;
    });
    const typed = typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(reports).toEqual([]);
    expect(seen).toEqual(['keydown', 'keyup']);
    // The engine skips the event; it never prevents the browser's own action itself.
    expect(typed.keydown.defaultPrevented).toBe(false);
  });

  test.each([true, undefined, null, 0, ''])(
    'processes the event when the hook returns %p, which is not false',
    (value) => {
      const { reports, textarea, captured } = mounted();
      captured.engine.setKeyHook(() => value as unknown as boolean);
      const typed = typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
      expect(reports).toEqual([{ kind: 'text', data: '\r' }]);
      expect(typed.keydown.defaultPrevented).toBe(true);
    },
  );

  test('asks the hook for keypress as well when the keydown was not handled', () => {
    const { textarea, captured } = mounted();
    const seen: string[] = [];
    captured.engine.setKeyHook((event) => {
      seen.push(event.type);
      return true;
    });
    // Uppercase letters are left to keypress by the engine, which is why that path needs a veto.
    typeKey(textarea, { key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true, charCode: 65 });
    expect(seen).toEqual(['keydown', 'keypress', 'keyup']);
  });

  test('a hook that vetoes keydown does not stop the engine reading a later keypress', () => {
    // The hook is asked per event type, so a veto must be repeated for keypress to hold.
    const { reports, textarea, captured } = mounted();
    captured.engine.setKeyHook((event) => event.type !== 'keydown');
    textarea.dispatchEvent(keyEvent('keydown', { key: 'A', keyCode: 65, shiftKey: true }));
    textarea.dispatchEvent(
      keyEvent('keypress', { key: 'A', keyCode: 65, shiftKey: true, charCode: 65 }),
    );
    expect(reports).toEqual([{ kind: 'text', data: 'A' }]);
  });

  test('removing the hook restores plain processing', () => {
    const { reports, textarea, captured } = mounted();
    captured.engine.setKeyHook(() => false);
    captured.engine.setKeyHook(undefined);
    typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(reports).toEqual([{ kind: 'text', data: '\r' }]);
  });
});

describe('application modes', () => {
  test('application cursor keys change the arrow sequences the engine reports', async () => {
    const { captured, reports, textarea } = mounted();
    await captured.deliver([bytes('\u001b[?1h')]);
    typeKey(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 });
    await captured.deliver([bytes('\u001b[?1l')]);
    typeKey(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 });
    expect(reports.map((report) => report.data)).toEqual(['\u001bOA', '\u001b[A']);
  });

  test('the engine tracks application keypad mode but does not use it to encode keys', async () => {
    // xterm.js 6.0.0 records DECKPAM in `decPrivateModes.applicationKeypad` and
    // `common/input/Keyboard.ts` never reads it, so the numeric keypad reports the same either way.
    const { captured, reports, textarea } = mounted();
    typeKey(textarea, { key: '5', code: 'Numpad5', keyCode: 101, charCode: 53 });
    await captured.deliver([bytes('\u001b=')]);
    typeKey(textarea, { key: '5', code: 'Numpad5', keyCode: 101, charCode: 53 });
    typeKey(textarea, { key: 'Enter', code: 'NumpadEnter', keyCode: 13 });
    expect(reports.map((report) => report.data)).toEqual(['5', '5', '\r']);
  });

  test('function keys, Home and End, and modifier chords keep their sequences', () => {
    const { reports, textarea } = mounted();
    typeKey(textarea, { key: 'F1', code: 'F1', keyCode: 112 });
    typeKey(textarea, { key: 'F12', code: 'F12', keyCode: 123 });
    typeKey(textarea, { key: 'Home', code: 'Home', keyCode: 36 });
    typeKey(textarea, { key: 'End', code: 'End', keyCode: 35 });
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true });
    typeKey(textarea, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, shiftKey: true });
    typeKey(textarea, { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    expect(reports.map((report) => report.data)).toEqual([
      '\u001bOP',
      '\u001b[24~',
      '\u001b[H',
      '\u001b[F',
      '\u0001',
      '\u001b[1;2C',
      '\u007f',
    ]);
  });
});

describe('selection and paste', () => {
  test('hasSelection follows the engine selection', async () => {
    const { captured } = mounted();
    expect(captured.engine.hasSelection()).toBe(false);
    await captured.deliver([bytes('hello')]);
    captured.terminal.select(0, 0, 5);
    expect(captured.engine.hasSelection()).toBe(true);
    captured.terminal.clearSelection();
    expect(captured.engine.hasSelection()).toBe(false);
  });

  test('paste converts line breaks to carriage returns and reports one text report', () => {
    const { captured, reports } = mounted();
    captured.engine.paste('one\ntwo\r\nthree\n');
    expect(reports).toEqual([{ kind: 'text', data: 'one\rtwo\rthree\r' }]);
  });

  test('paste is bracketed when the program asked for it, keeping the trailing newline', async () => {
    const { captured, reports } = mounted();
    await captured.deliver([bytes('\u001b[?2004h')]);
    captured.engine.paste('rm -rf x\n');
    expect(reports).toEqual([{ kind: 'text', data: '\u001b[200~rm -rf x\r\u001b[201~' }]);
  });

  test('a read-only engine takes no paste', () => {
    const { captured, reports } = mounted({ readOnly: true });
    captured.engine.paste('x');
    expect(reports).toEqual([]);
  });

  test('paste, focus and the key hook are inert after dispose', () => {
    const { captured, reports } = mounted();
    captured.engine.dispose();
    captured.engine.paste('x');
    captured.engine.focus();
    expect(reports).toEqual([]);
  });
});

describe('focus', () => {
  test('moves focus to the input element', () => {
    const { captured, textarea } = mounted();
    expect(document.activeElement).not.toBe(textarea);
    captured.engine.focus();
    expect(document.activeElement).toBe(textarea);
  });
});
