import type { FailureCode } from '@lostgradient/ventriloquist';
import type { Terminal as XtermTerminal } from '@xterm/xterm';

import type {
  EngineInputReport,
  EngineKeyHook,
} from '../components/terminal/terminal-engine-adapter.ts';
import {
  DEFAULT_MAXIMUM_PASTE_BYTES,
  type InputPlatform,
  type InputSettings,
  type TerminalInputController,
} from './input-types.ts';
import type { InputEngine } from './terminal-input.ts';

/**
 * Helpers that drive a real xterm.js engine the way a browser does. Test-only.
 *
 * A browser fires `keypress` only when `keydown` was not default-prevented, and the engine
 * default-prevents every keydown it turns into input, so a faithful `typeKey` does the same.
 */

export type KeyInit = KeyboardEventInit & { charCode?: number };

export function keyEvent(type: string, init: KeyInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (init.charCode !== undefined) {
    Object.defineProperty(event, 'charCode', { value: init.charCode });
  }
  return event;
}

export type TypedKey = {
  keydown: KeyboardEvent;
  keypress: KeyboardEvent | undefined;
  keyup: KeyboardEvent;
};

/** Dispatch keydown, then keypress (when the browser would), then keyup on `target`. */
export function typeKey(target: EventTarget, init: KeyInit): TypedKey {
  const keydown = keyEvent('keydown', init);
  target.dispatchEvent(keydown);
  let keypress: KeyboardEvent | undefined;
  if (!keydown.defaultPrevented && init.charCode !== undefined) {
    keypress = keyEvent('keypress', init);
    target.dispatchEvent(keypress);
  }
  const keyup = keyEvent('keyup', init);
  target.dispatchEvent(keyup);
  return { keydown, keypress, keyup };
}

export function dispatchComposition(target: EventTarget, type: string, data = ''): void {
  target.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The engine's internal core, which has no public way to make a binary report or watch a scroll. */
function engineCore(terminal: XtermTerminal): Record<string, unknown> {
  const core: unknown = Reflect.get(terminal, '_core');
  if (!isRecord(core)) throw new Error('The engine core is not where this test expects it.');
  return core;
}

/** Fire a binary report the way the engine does for a mouse report that needs raw bytes. */
export function emitBinaryReport(terminal: XtermTerminal, data: string): void {
  const service: unknown = Reflect.get(engineCore(terminal), 'coreService');
  if (!isRecord(service)) throw new Error('The engine core service is missing.');
  const trigger: unknown = Reflect.get(service, 'triggerBinaryEvent');
  if (typeof trigger !== 'function') throw new Error('The engine cannot make a binary report.');
  Reflect.apply(trigger, service, [data]);
}

/** Record every scroll the engine asks its viewport for, in lines. */
export function recordScrollRequests(terminal: XtermTerminal): number[] {
  const core = engineCore(terminal);
  const original: unknown = Reflect.get(core, 'scrollLines');
  if (typeof original !== 'function') throw new Error('The engine core cannot scroll.');
  const requests: number[] = [];
  Reflect.set(core, 'scrollLines', (count: number) => {
    requests.push(count);
    Reflect.apply(original, core, [count]);
  });
  return requests;
}

/** A paste event carrying `text` as its plain-text clipboard data. */
export function pasteEvent(text: string | undefined): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value:
      text === undefined
        ? null
        : { getData: (type: string) => (type === 'text/plain' ? text : '') },
  });
  return event;
}

/** An engine whose reports, selection and key hook the test drives directly. */
export type FakeInputEngine = InputEngine & {
  /** Report input as the engine would. */
  report(report: EngineInputReport): void;
  /** The current key hook, as the engine would call it. */
  hook: EngineKeyHook | undefined;
  hookInstalls: number;
  selection: boolean | Error;
  pastes: string[];
  bracketedPaste: boolean;
  focusTarget: HTMLElement | undefined;
  listeners: Set<(report: EngineInputReport) => void>;
};

export function createFakeInputEngine(): FakeInputEngine {
  const engine: FakeInputEngine = {
    hook: undefined,
    hookInstalls: 0,
    selection: false,
    pastes: [],
    bracketedPaste: false,
    focusTarget: undefined,
    listeners: new Set(),
    report(report) {
      for (const listener of engine.listeners) listener(report);
    },
    onInput(listener) {
      engine.listeners.add(listener);
      return () => engine.listeners.delete(listener);
    },
    setKeyHook(hook) {
      engine.hook = hook;
      engine.hookInstalls += 1;
    },
    hasSelection() {
      if (engine.selection instanceof Error) throw engine.selection;
      return engine.selection;
    },
    paste(text) {
      engine.pastes.push(text);
    },
    focus() {
      engine.focusTarget?.focus();
    },
  };
  return engine;
}

type InputOutcome = undefined | { ok: false; code: FailureCode } | { throws: Error };

/** A controller that records the operations it is offered and answers from a script. */
export type FakeInputController = TerminalInputController & {
  sent: Uint8Array[];
  authorityRevoked: boolean;
  terms: { maxFrameBytes: number; maxQueuedOperations: number } | undefined;
  /** Decides the outcome of the nth operation (0-based); `undefined` accepts it. */
  outcome: (index: number, data: Uint8Array) => InputOutcome;
};

export function createFakeInputController(
  terms: FakeInputController['terms'] = { maxFrameBytes: 65_536, maxQueuedOperations: 256 },
): FakeInputController {
  const controller: FakeInputController = {
    sent: [],
    authorityRevoked: false,
    terms,
    outcome: () => undefined,
    input(data) {
      const outcome = controller.outcome(controller.sent.length, data);
      if (outcome !== undefined && 'throws' in outcome) throw outcome.throws;
      if (outcome !== undefined) {
        return { ok: false, failure: { code: outcome.code, reason: 'operation-window-full' } };
      }
      controller.sent.push(data.slice());
      return { ok: true, value: undefined };
    },
  };
  return controller;
}

export function createInputSettings(
  overrides: Partial<InputSettings> & { platform?: InputPlatform } = {},
): InputSettings {
  return {
    writable: true,
    maximumPasteBytes: DEFAULT_MAXIMUM_PASTE_BYTES,
    platform: 'other',
    ...overrides,
  };
}

const decoder = new TextDecoder();

/** Everything a controller was offered, joined and decoded, for byte-exact assertions on text. */
export function sentText(controller: FakeInputController): string {
  return controller.sent.map((chunk) => decoder.decode(chunk)).join('');
}

/** Everything a controller was offered as raw byte values. */
export function sentBytes(controller: FakeInputController): number[] {
  return controller.sent.flatMap((chunk) => [...chunk]);
}
