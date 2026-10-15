import { afterEach, describe, expect, test } from 'bun:test';

import { createCapturedEngine } from '../components/terminal/terminal-corpus-test-support.ts';
import {
  createFakeInputController,
  createInputSettings,
  emitMouseReport,
  pasteEvent,
  sentBytes,
  sentText,
  typeKey,
  type MouseReportInit,
} from './input-test-support.ts';
import type { InputRefusal, InputSettings } from './input-types.ts';
import { createTerminalInput } from './terminal-input.ts';

const encoder = new TextEncoder();

/** The mouse modes a program turns on, and the exact report the engine makes for a left press. */
const MODES = [
  { name: 'X10 (default encoding, binary)', set: '\u001b[?1000h', expected: '\u001b[M "$' },
  { name: 'SGR', set: '\u001b[?1000h\u001b[?1006h', expected: '\u001b[<0;2;4M' },
  { name: 'SGR pixels', set: '\u001b[?1000h\u001b[?1016h', expected: '\u001b[<0;20;30M' },
] as const;

const PRESS: MouseReportInit = { button: 'left', action: 'down', column: 1, row: 3 };

const sessions: Array<{ stop: () => void }> = [];

async function mouseSession(mode: string, settings: Partial<InputSettings> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const captured = createCapturedEngine({ readOnly: false });
  captured.engine.mount(host);
  const controller = createFakeInputController();
  const current = createInputSettings({ mouseReporting: true, ...settings });
  const refusals: InputRefusal[] = [];
  const input = createTerminalInput({
    engine: captured.engine,
    host,
    controller,
    readSettings: () => current,
    onCaptureChange: () => {},
    onReview: () => {},
    onRefused: (refusal) => refusals.push(refusal),
  });
  await captured.deliver([encoder.encode(mode)]);
  sessions.push({
    stop() {
      input.dispose();
      captured.engine.dispose();
      host.remove();
    },
  });
  return { captured, controller, input, settings: current, refusals, host };
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.stop();
});

for (const { name, set, expected } of MODES) {
  describe(`mouse reports in ${name} mode`, () => {
    test('are sent when the host opted in, capture is on and the view is writable', async () => {
      const { captured, controller, input } = await mouseSession(set);
      expect(input.capture()).toBe(true);
      expect(emitMouseReport(captured.terminal, PRESS)).toBe(true);
      expect(sentText(controller)).toBe(expected);
    });

    test('are dropped, not refused, while capture is off', async () => {
      const { captured, controller, refusals } = await mouseSession(set);
      emitMouseReport(captured.terminal, PRESS);
      expect(controller.sent).toEqual([]);
      expect(refusals).toEqual([]);
    });

    test('are dropped when the host did not opt in, even with capture on', async () => {
      const { captured, controller, input } = await mouseSession(set, { mouseReporting: false });
      input.capture();
      emitMouseReport(captured.terminal, PRESS);
      expect(controller.sent).toEqual([]);
    });

    test('are dropped when the view is not writable', async () => {
      const { captured, controller, input, settings } = await mouseSession(set);
      input.capture();
      settings.writable = false;
      emitMouseReport(captured.terminal, PRESS);
      expect(controller.sent).toEqual([]);
    });

    test('leave the mode the program set untouched, so reporting resumes with capture', async () => {
      const { captured, controller, input } = await mouseSession(set);
      emitMouseReport(captured.terminal, PRESS);
      expect(captured.terminal.modes.mouseTrackingMode).toBe('vt200');
      input.capture();
      emitMouseReport(captured.terminal, { ...PRESS, row: 3 });
      expect(sentText(controller)).toBe(expected);
    });
  });
}

describe('what is and is not a mouse report', () => {
  test('wheel, release and move reports follow the same rule', async () => {
    const { captured, controller, input } = await mouseSession('\u001b[?1003h\u001b[?1006h');
    emitMouseReport(captured.terminal, { button: 'wheel', action: 'down' });
    emitMouseReport(captured.terminal, { button: 'left', action: 'up' });
    emitMouseReport(captured.terminal, { button: 'none', action: 'move', column: 5 });
    expect(controller.sent).toEqual([]);
    input.capture();
    emitMouseReport(captured.terminal, { button: 'wheel', action: 'down' });
    emitMouseReport(captured.terminal, { button: 'left', action: 'up' });
    emitMouseReport(captured.terminal, { button: 'none', action: 'move', column: 5 });
    expect(sentText(controller)).toBe('\u001b[<65;3;4M\u001b[<0;3;4m\u001b[<35;6;4M');
  });

  test('typing is untouched by mouse tracking, with or without capture', async () => {
    const { captured, controller } = await mouseSession('\u001b[?1000h');
    typeKey(captured.terminal.textarea!, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(sentBytes(controller)).toEqual([0x61]);
  });

  test('report-shaped text is only held back while the program tracks the mouse', async () => {
    const lookalike = '\u001b[<0;2;4M';
    const tracking = await mouseSession('\u001b[?1000h');
    tracking.captured.terminal.input(lookalike);
    // No key produces exactly a mouse report; while tracking is on, that shape is the engine's.
    expect(sentText(tracking.controller)).toBe('');
    const plain = await mouseSession('\u001b[?1000l');
    plain.captured.terminal.input(lookalike);
    expect(sentText(plain.controller)).toBe(lookalike);
  });

  test('an accepted paste of report-shaped text is sent in full', async () => {
    const { captured, controller, input } = await mouseSession('\u001b[?1000h');
    captured.terminal.textarea!.dispatchEvent(pasteEvent('\u001b[<0;2;4M'));
    input.acceptPaste();
    expect(sentText(controller)).toBe('\u001b[<0;2;4M');
  });
});

describe('selection while reporting is not permitted', () => {
  function pressMouse(
    captured: Awaited<ReturnType<typeof mouseSession>>['captured'],
    init: MouseEventInit = {},
  ): MouseEvent[] {
    const element = captured.terminal.element!;
    const seen: MouseEvent[] = [];
    element.addEventListener('mousedown', (event) => seen.push(event));
    element.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }),
    );
    return seen;
  }

  test('a press reaches the engine as a selection gesture (Shift) when tracking is on', async () => {
    const { captured, controller } = await mouseSession('\u001b[?1000h');
    const seen = pressMouse(captured);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.shiftKey).toBe(true);
    expect(controller.sent).toEqual([]);
  });

  test('on a Mac the gesture is Option', async () => {
    const { captured } = await mouseSession('\u001b[?1000h', { platform: 'mac' });
    const seen = pressMouse(captured);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.altKey).toBe(true);
    expect(seen[0]!.shiftKey).toBe(false);
  });

  test('a press that already is a selection gesture is left alone', async () => {
    const { captured } = await mouseSession('\u001b[?1000h');
    const seen = pressMouse(captured, { shiftKey: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.shiftKey).toBe(true);
    expect(seen[0]!.composed).toBe(false);
  });

  test('is not rewritten when reporting is permitted, when tracking is off, or for other buttons', async () => {
    const permitted = await mouseSession('\u001b[?1000h');
    permitted.input.capture();
    expect(pressMouse(permitted.captured)[0]!.shiftKey).toBe(false);
    const off = await mouseSession('\u001b[?1000l');
    expect(pressMouse(off.captured)[0]!.shiftKey).toBe(false);
    const tracking = await mouseSession('\u001b[?1000h');
    expect(pressMouse(tracking.captured, { button: 2 })[0]!.shiftKey).toBe(false);
  });

  test('stops listening once disposed', async () => {
    const { captured, input } = await mouseSession('\u001b[?1000h');
    input.dispose();
    expect(pressMouse(captured)[0]!.shiftKey).toBe(false);
  });
});
