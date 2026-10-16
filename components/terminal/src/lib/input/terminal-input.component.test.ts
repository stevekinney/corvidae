import { afterEach, describe, expect, test } from 'bun:test';

import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../test/mount-harness.ts';
import { reactiveProps } from '../../test/reactive-props.svelte.ts';
import { createFakeController } from '../components/terminal/terminal-attachment-test-support.ts';
import { settle, waitFor } from '../components/terminal/terminal-test-support.ts';
import Terminal from '../components/terminal/terminal.svelte';
import type { TerminalProps } from '../components/terminal/terminal.types.ts';
import {
  createFakeInputController,
  keyEvent,
  pasteEvent,
  sentBytes,
  sentText,
  typeKey,
} from './input-test-support.ts';
import type { InputRefusal } from './input-types.ts';

afterEach(async () => {
  await destroyAllHarnesses();
});

function query(harness: MountedHarness, selector: string): HTMLElement | null {
  return harness.target.querySelector<HTMLElement>(selector);
}

function required(harness: MountedHarness, selector: string): HTMLElement {
  const element = query(harness, selector);
  if (element === null) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}

function button(label: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`Expected a "${label}" button`);
  return found;
}

/**
 * Deliver `text` as output and resolve when the engine reports it parsed, which is when any reply
 * it would send has been sent. The engine acknowledges each chunk once, so this is an event, not a
 * guess at how long parsing takes.
 */
function deliverOutput(controller: ReturnType<typeof wiredController>, text: string) {
  const listener = controller.everRegistered.at(-1);
  if (listener === undefined) throw new Error('Expected the terminal to be listening for output');
  return new Promise<void>((resolve) => listener(new TextEncoder().encode(text), resolve));
}

function wiredController() {
  return Object.assign(createFakeController(), { input: createFakeInputController() });
}

async function mountReady(props: TerminalProps) {
  const harness = mountHarness(Terminal, props);
  await waitFor(
    () =>
      query(harness, '.xterm') !== null &&
      !required(harness, '.cinder-terminal__viewport').hasAttribute('inert'),
    'the engine to mount',
  );
  const textarea = required(harness, '.xterm-helper-textarea') as HTMLTextAreaElement;
  return { harness, textarea };
}

/** Every distinct non-empty message the polite live region showed, in order. */
function recordAnnouncements(harness: MountedHarness): string[] {
  const region = required(harness, '[aria-live="polite"]');
  const seen: string[] = [];
  new MutationObserver(() => {
    const text = region.textContent?.trim();
    if (text) seen.push(text);
  }).observe(region, { childList: true, characterData: true, subtree: true });
  return seen;
}

const announcement = (harness: MountedHarness) =>
  required(harness, '[aria-live="polite"]').textContent?.trim();

describe('the capture control', () => {
  test('starts off, as a pressed-state Cinder Button', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const capture = button('Capture terminal keys', harness.target);
    expect(capture.className).toContain('cinder-button');
    expect(capture.getAttribute('aria-pressed')).toBe('false');
  });

  test('activating it enters capture, focuses the terminal, and announces it once', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(textarea);
    await waitFor(() => announcement(harness) === 'Terminal key capture on', 'the announcement');
  });

  test('page-navigation mode sends Tab through the page; capture mode sends it to the shell', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    textarea.focus();
    const page = typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(page.keydown.defaultPrevented).toBe(false);
    expect(controller.input.sent).toEqual([]);
    button('Capture terminal keys', harness.target).click();
    const captured = typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(captured.keydown.defaultPrevented).toBe(true);
    const shifted = typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true });
    expect(shifted.keydown.defaultPrevented).toBe(true);
    expect(sentText(controller.input)).toBe('\t\u001b[Z');
  });

  test('Ctrl+Shift+Escape releases it, keeps focus in the terminal, and announces it', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    typeKey(textarea, { key: 'Escape', code: 'Escape', keyCode: 27 });
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    typeKey(textarea, {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      ctrlKey: true,
      shiftKey: true,
    });
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(textarea);
    // Bare Escape was shell input; the release chord was not.
    expect(sentText(controller.input)).toBe('\u001b');
    await waitFor(() => announcement(harness) === 'Terminal key capture off', 'the announcement');
  });

  test('activating it again leaves capture', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
  });

  test('focus moving to the pressed button does not release capture, so the press turns it off', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const seen = recordAnnouncements(harness);
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    await waitFor(
      () => announcement(harness) === 'Terminal key capture on',
      'the first announcement',
    );
    capture.focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    await waitFor(
      () => announcement(harness) === 'Terminal key capture off',
      'the second announcement',
    );
    expect(seen).toEqual(['Terminal key capture on', 'Terminal key capture off']);
  });

  test('a pointer press on the pressed button turns capture off with one announcement', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const seen = recordAnnouncements(harness);
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    await waitFor(
      () => announcement(harness) === 'Terminal key capture on',
      'the first announcement',
    );
    // The sequence a browser produces: the press moves focus to the button before the click lands.
    capture.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    capture.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    capture.focus();
    capture.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    capture.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => announcement(harness) === 'Terminal key capture off', 'the announcement');
    expect(seen).toEqual(['Terminal key capture on', 'Terminal key capture off']);
  });

  test('keyboard activation of the button enters and leaves capture', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const capture = button('Capture terminal keys', harness.target);
    capture.focus();
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(textarea);
    typeKey(textarea, {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      ctrlKey: true,
      shiftKey: true,
    });
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    capture.focus();
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
  });

  test('focus leaving the pressed button for the page releases capture', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    capture.focus();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    outside.remove();
  });

  test('focus moving from the pressed button back to the terminal keeps capture', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    capture.focus();
    textarea.focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
  });

  test('capture lasts only while the terminal has focus', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    outside.remove();
  });

  test('does not enter capture before the engine is ready to take focus', () => {
    const controller = wiredController();
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'writable', controller });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
  });

  test('output arriving never moves focus or changes the capture state', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await deliverOutput(controller, 'hello\r\n');
    expect(document.activeElement).toBe(outside);
    expect(button('Capture terminal keys', harness.target).getAttribute('aria-pressed')).toBe(
      'false',
    );
    outside.remove();
  });

  test('is released when the view stops taking input', async () => {
    const controller = wiredController();
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable', controller });
    const { harness, textarea } = await mountReady(props);
    button('Capture terminal keys', harness.target).click();
    harness.flush();
    props.state = 'backpressured';
    harness.flush();
    await waitFor(() => announcement(harness) === 'Terminal key capture off', 'capture off');
    expect(query(harness, '[aria-pressed]')).toBeNull();
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(controller.input.sent).toEqual([]);
  });
});

describe('interrupt', () => {
  test('sends the interrupt byte on intentional activation', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    button('Interrupt', harness.target).click();
    expect(sentBytes(controller.input)).toEqual([0x03]);
  });
});

describe('the Interrupt button', () => {
  test('keeps capture while it has focus, sends one byte, and returns focus to the terminal', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const seen = recordAnnouncements(harness);
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    await waitFor(() => announcement(harness) === 'Terminal key capture on', 'capture on');
    const interrupt = button('Interrupt', harness.target);
    // A pointer press moves focus to the button before the click lands.
    interrupt.focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    interrupt.click();
    harness.flush();
    expect(sentBytes(controller.input)).toEqual([0x03]);
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(textarea);
    await settle();
    harness.flush();
    expect(seen).toEqual(['Terminal key capture on']);
  });

  test('a pointer press on either control does not take focus from the terminal', async () => {
    // Safari does not focus a clicked button, so the press itself moved focus to the page and
    // ended capture (COR-474). Cancelling the press keeps focus; the click still activates.
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    for (const label of ['Capture terminal keys', 'Interrupt']) {
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      button(label, harness.target).dispatchEvent(press);
      expect(press.defaultPrevented, label).toBe(true);
    }
  });

  test('focus leaving it for the page releases capture', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    button('Interrupt', harness.target).focus();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    outside.remove();
  });

  test('refused twice in a row, it is announced both times', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const seen = recordAnnouncements(harness);
    controller.input.authorityRevoked = true;
    const interrupt = button('Interrupt', harness.target);
    interrupt.click();
    await waitFor(() => seen.length === 1, 'the first announcement');
    interrupt.click();
    await waitFor(() => seen.length === 2, 'the second announcement');
    expect(seen).toEqual([
      'The terminal is read-only. Nothing was sent.',
      'The terminal is read-only. Nothing was sent.',
    ]);
  });
});

describe('capture follows authority', () => {
  test('revoked authority releases capture while the state stays writable, announced once', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const seen = recordAnnouncements(harness);
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    await waitFor(() => seen.length === 1, 'capture on');
    controller.input.authorityRevoked = true;
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    typeKey(textarea, { key: 'b', code: 'KeyB', keyCode: 66 });
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => seen.length === 2, 'capture off');
    await settle();
    expect(seen).toEqual(['Terminal key capture on', 'Terminal key capture off']);
  });

  test('a controller that was closed releases capture too', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    controller.input.terms = undefined;
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('mouse reporting', () => {
  /** The gesture that makes the engine select instead of report: Shift, or Option on a Mac. */
  const selects = (event: MouseEvent) => event.shiftKey || event.altKey;

  async function pressWhileTracking(props: Partial<TerminalProps>, capture: boolean) {
    const controller = wiredController();
    const { harness } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
      ...props,
    });
    await deliverOutput(controller, '\u001b[?1000h\u001b[?1006h');
    if (capture) {
      button('Capture terminal keys', harness.target).click();
      harness.flush();
    }
    const screen = required(harness, '.xterm');
    const seen: MouseEvent[] = [];
    screen.addEventListener('mousedown', (event) => seen.push(event));
    screen.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
    );
    return seen;
  }

  test('is off by default: a press while the program tracks the mouse becomes a selection gesture', async () => {
    const seen = await pressWhileTracking({}, true);
    expect(seen.map(selects)).toEqual([true]);
  });

  test('when the host opts in, a captured terminal leaves the press to the program', async () => {
    const seen = await pressWhileTracking({ mouseReporting: true }, true);
    expect(seen.map(selects)).toEqual([false]);
  });

  test('when the host opts in, an uncaptured terminal still selects', async () => {
    const seen = await pressWhileTracking({ mouseReporting: true }, false);
    expect(seen.map(selects)).toEqual([true]);
  });
});

describe('the mouse reporting indicator in the component', () => {
  const indicator = (harness: MountedHarness) =>
    [...harness.target.querySelectorAll<HTMLElement>('.cinder-badge')].find(
      (badge) => badge.textContent?.trim() === 'Mouse reporting on',
    );

  async function mounted(props: Partial<TerminalProps>) {
    const controller = wiredController();
    const result = await mountReady({ title: 'Shell', state: 'writable', controller, ...props });
    return { ...result, controller, seen: recordAnnouncements(result.harness) };
  }

  test('appears only when opted in, tracked, captured and writable', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: wiredController(),
      mouseReporting: true,
    });
    const { harness } = await mountReady(props);
    const capture = button('Capture terminal keys', harness.target);
    expect(indicator(harness)).toBeUndefined();
    await deliverOutput(props.controller as ReturnType<typeof wiredController>, '\u001b[?1000h');
    expect(indicator(harness)).toBeUndefined();
    capture.click();
    harness.flush();
    expect(indicator(harness)).toBeDefined();
    props.mouseReporting = false;
    harness.flush();
    expect(indicator(harness)).toBeUndefined();
    props.mouseReporting = true;
    harness.flush();
    expect(indicator(harness)).toBeDefined();
    capture.click();
    harness.flush();
    expect(indicator(harness)).toBeUndefined();
    capture.click();
    harness.flush();
    props.state = 'read-only';
    harness.flush();
    expect(indicator(harness)).toBeUndefined();
  });

  test('is never shown without the opt-in', async () => {
    const { harness, controller } = await mounted({});
    await deliverOutput(controller, '\u001b[?1000h');
    button('Capture terminal keys', harness.target).click();
    harness.flush();
    expect(indicator(harness)).toBeUndefined();
  });

  test('describes the capture button while shown', async () => {
    const { harness, controller } = await mounted({ mouseReporting: true });
    await deliverOutput(controller, '\u001b[?1000h');
    const capture = button('Capture terminal keys', harness.target);
    expect(capture.hasAttribute('aria-describedby')).toBe(false);
    capture.click();
    harness.flush();
    const badge = indicator(harness)!;
    expect(capture.getAttribute('aria-describedby')).toBe(badge.id);
    expect(badge.closest('[aria-live]')).toBeNull();
  });

  test('the program turning it on and off is announced once each, however often it repeats', async () => {
    const { harness, controller, seen } = await mounted({ mouseReporting: true });
    button('Capture terminal keys', harness.target).click();
    harness.flush();
    await waitFor(() => seen.length === 1, 'the capture announcement');
    await deliverOutput(controller, '\u001b[?1000h');
    harness.flush();
    await waitFor(() => seen.length === 2, 'the mouse announcement');
    await deliverOutput(controller, '\u001b[?1002h\u001b[?1006h\u001b[?1000h');
    await deliverOutput(controller, '\u001b[?1000l\u001b[?1002l');
    harness.flush();
    await waitFor(() => seen.length === 3, 'the second mouse announcement');
    await settle();
    expect(seen).toEqual(['Terminal key capture on', 'Mouse reporting on', 'Mouse reporting off']);
  });

  test('capture alone turning it on is left to the capture announcement', async () => {
    const { harness, controller, seen } = await mounted({ mouseReporting: true });
    await deliverOutput(controller, '\u001b[?1000h');
    button('Capture terminal keys', harness.target).click();
    harness.flush();
    await waitFor(() => seen.length === 1, 'the capture announcement');
    await settle();
    expect(seen).toEqual(['Terminal key capture on']);
    expect(indicator(harness)).toBeDefined();
  });
});

describe('authority follows the state', () => {
  test('a read-only terminal sends nothing for typing, paste or query replies', async () => {
    const controller = wiredController();
    const refusals: InputRefusal[] = [];
    const { textarea } = await mountReady({
      title: 'Shell',
      state: 'read-only',
      controller,
      onInputRefused: (refusal) => refusals.push(refusal),
    });
    typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    const paste = pasteEvent('a\nb');
    textarea.dispatchEvent(paste);
    await deliverOutput(controller, '\u001b[c');
    expect(controller.input.sent).toEqual([]);
    expect(paste.defaultPrevented).toBe(true);
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['read-only']);
  });

  test('typing reaches the wire when writable, and stops when the state says it must', async () => {
    const controller = wiredController();
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable', controller });
    const { harness, textarea } = await mountReady(props);
    textarea.focus();
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(sentText(controller.input)).toBe('a');
    for (const state of ['backpressured', 'disconnected', 'exited', 'read-only'] as const) {
      props.state = state;
      harness.flush();
      typeKey(textarea, { key: 'b', code: 'KeyB', keyCode: 66 });
    }
    expect(sentText(controller.input)).toBe('a');
  });

  test('a terminal with no input path sends nothing and reports the refusal', async () => {
    const refusals: InputRefusal[] = [];
    const { textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller: createFakeController(),
      onInputRefused: (refusal) => refusals.push(refusal),
    });
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(refusals).toEqual([{ reason: 'closed' }]);
  });

  test('the terminal sends nothing to a controller revoked by a failure', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    controller.input.authorityRevoked = true;
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(controller.input.sent).toEqual([]);
    expect(harness.destroyed).toBe(false);
  });
});

describe('dropped input is announced', () => {
  async function mountWritable(props: Partial<TerminalProps> = {}) {
    const controller = wiredController();
    const mounted = await mountReady({ title: 'Shell', state: 'writable', controller, ...props });
    const seen = recordAnnouncements(mounted.harness);
    mounted.textarea.focus();
    return { ...mounted, controller, seen };
  }

  const key = (textarea: HTMLElement, letter: string) =>
    typeKey(textarea, { key: letter, code: `Key${letter.toUpperCase()}`, keyCode: 65 });

  test('a failure of unknown delivery is announced, and so is the freeze that follows it', async () => {
    const { harness, textarea, controller, seen } = await mountWritable();
    controller.input.outcome = () => ({ throws: new Error('socket closed') });
    key(textarea, 'a');
    await waitFor(() => announcement(harness) !== '', 'the first announcement');
    key(textarea, 'b');
    key(textarea, 'c');
    await waitFor(() => seen.length === 2, 'the second announcement');
    expect(seen).toEqual([
      'Terminal input stopped: the last input may not have been delivered.',
      'Terminal input stopped. Keystrokes are not being sent.',
    ]);
  });

  test('a full queue announces that input is paused, once however many keys follow', async () => {
    const { harness, textarea, controller, seen } = await mountWritable();
    controller.input.outcome = () => ({ ok: false, code: 'fifo-full' });
    for (const letter of ['a', 'b', 'c', 'd']) key(textarea, letter);
    await waitFor(() => announcement(harness) !== '', 'the announcement');
    expect(seen).toEqual(['Terminal input paused. Keystrokes are not being sent.']);
  });

  test('an input too large for one frame is announced', async () => {
    const { harness, controller, textarea, seen } = await mountWritable();
    controller.input.terms = { maxFrameBytes: 2, maxQueuedOperations: 1 };
    textarea.dispatchEvent(pasteEvent('x'.repeat(10)));
    await waitFor(() => announcement(harness) !== '', 'the announcement');
    expect(seen).toEqual(['Input was too large and was not sent.']);
  });

  test('a paste refused because the terminal is read-only is announced', async () => {
    const { harness, textarea, controller, seen } = await mountWritable({ state: 'read-only' });
    textarea.dispatchEvent(pasteEvent('a\nb'));
    await waitFor(() => announcement(harness) !== '', 'the announcement');
    expect(seen).toEqual(['The terminal is read-only. Nothing was sent.']);
    expect(controller.input.sent).toEqual([]);
  });

  test('a paste dropped because authority was revoked during its review is announced', async () => {
    const { harness, textarea, controller, seen } = await mountWritable();
    textarea.dispatchEvent(pasteEvent('a\nb\n'));
    await waitFor(() => document.querySelector('dialog[open]') !== null, 'the review');
    controller.input.authorityRevoked = true;
    button('Paste', document.querySelector<HTMLElement>('dialog[open]')!).click();
    await waitFor(() => announcement(harness) !== '', 'the announcement');
    expect(seen).toEqual(['The terminal is read-only. Nothing was sent.']);
  });

  test('a second oversized paste is announced again', async () => {
    const { controller, textarea, seen } = await mountWritable();
    controller.input.terms = { maxFrameBytes: 2, maxQueuedOperations: 1 };
    textarea.dispatchEvent(pasteEvent('x'.repeat(10)));
    await waitFor(() => seen.length === 1, 'the first announcement');
    textarea.dispatchEvent(pasteEvent('y'.repeat(10)));
    await waitFor(() => seen.length === 2, 'the second announcement');
    expect(seen).toEqual(Array(2).fill('Input was too large and was not sent.'));
  });

  test('read-only keystroke refusals are not announced, however many are typed', async () => {
    const refusals: InputRefusal[] = [];
    const { textarea, controller, harness, seen } = await mountWritable({
      onInputRefused: (refusal) => refusals.push(refusal),
    });
    controller.input.authorityRevoked = true;
    for (const letter of ['a', 'b', 'c']) key(textarea, letter);
    // The announcer writes on its next timer turn; let it, then look at the region.
    await settle();
    harness.flush();
    expect(refusals).toEqual([
      { reason: 'read-only' },
      { reason: 'read-only' },
      { reason: 'read-only' },
    ]);
    expect(seen).toEqual([]);
    expect(controller.input.sent).toEqual([]);
  });

  test('every refusal still reaches onInputRefused, announced or not', async () => {
    const refusals: InputRefusal[] = [];
    const { textarea, controller } = await mountWritable({
      onInputRefused: (refusal) => refusals.push(refusal),
    });
    controller.input.authorityRevoked = true;
    key(textarea, 'a');
    textarea.dispatchEvent(pasteEvent('a\nb'));
    expect(refusals).toEqual([{ reason: 'read-only' }, { reason: 'read-only', source: 'paste' }]);
  });

  test('a changed state lets the same refusal be announced again', async () => {
    const controller = wiredController();
    controller.input.outcome = () => ({ ok: false, code: 'fifo-full' });
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable', controller });
    const { harness, textarea } = await mountReady(props);
    const seen = recordAnnouncements(harness);
    textarea.focus();
    key(textarea, 'a');
    await waitFor(() => seen.length === 1, 'the first announcement');
    props.state = 'backpressured';
    harness.flush();
    props.state = 'writable';
    harness.flush();
    key(textarea, 'b');
    await waitFor(() => seen.length === 2, 'the second announcement');
    expect(seen[1]).toBe(seen[0]);
  });
});

describe('a new session never receives the old one’s input', () => {
  test('replacing the controller stops the old input path and starts the new one', async () => {
    const first = wiredController();
    const second = wiredController();
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: first,
    });
    const { harness } = await mountReady(props);
    button('Capture terminal keys', harness.target).click();
    harness.flush();
    const before = required(harness, '.xterm-helper-textarea') as HTMLTextAreaElement;
    typeKey(before, { key: 'a', code: 'KeyA', keyCode: 65 });
    props.controller = second;
    harness.flush();
    await waitFor(() => {
      const next = query(harness, '.xterm-helper-textarea');
      return (
        next !== null &&
        next !== before &&
        !required(harness, '.cinder-terminal__viewport').hasAttribute('inert')
      );
    }, 'the second session to mount');
    // The old engine is gone; if its textarea is still typed into, nothing reaches anyone.
    typeKey(before, { key: 'x', code: 'KeyX', keyCode: 88 });
    const after = required(harness, '.xterm-helper-textarea') as HTMLTextAreaElement;
    typeKey(after, { key: 'b', code: 'KeyB', keyCode: 66 });
    expect(sentText(first.input)).toBe('a');
    expect(sentText(second.input)).toBe('b');
    // Capture does not carry over: the new session starts with it off.
    expect(button('Capture terminal keys', harness.target).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  test('replacing the controller closes an open paste review and never sends it', async () => {
    const first = wiredController();
    const second = wiredController();
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: first,
    });
    const { harness, textarea } = await mountReady(props);
    textarea.focus();
    textarea.dispatchEvent(pasteEvent('a\nb\n'));
    harness.flush();
    await waitFor(() => document.querySelector('dialog[open]') !== null, 'the review');
    props.controller = second;
    harness.flush();
    await waitFor(() => document.querySelector('dialog[open]') === null, 'the review to close');
    expect(first.input.sent).toEqual([]);
    expect(second.input.sent).toEqual([]);
  });

  test('unmounting stops the input path', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    button('Capture terminal keys', harness.target).click();
    harness.destroy();
    typeKey(textarea, { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(controller.input.sent).toEqual([]);
  });
});

describe('paste review', () => {
  async function pasteReview(text: string, props: Partial<TerminalProps> = {}) {
    const controller = wiredController();
    const mounted = await mountReady({ title: 'Shell', state: 'writable', controller, ...props });
    mounted.textarea.focus();
    const event = pasteEvent(text);
    mounted.textarea.dispatchEvent(event);
    mounted.harness.flush();
    return { ...mounted, controller, event };
  }

  const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');

  test('shows a multiline paste with its trailing newline visible, and sends nothing yet', async () => {
    const { controller, event } = await pasteReview('ls\nrm -rf build\n');
    await waitFor(() => dialog() !== null, 'the review');
    expect(event.defaultPrevented).toBe(true);
    expect(dialog()!.textContent).toContain('Review paste');
    expect(dialog()!.textContent).toContain('Ends with a newline');
    const preview = dialog()!.querySelector('textarea')!;
    expect(preview.value).toBe('ls␊\nrm -rf build␊\n');
    expect(preview.readOnly).toBe(true);
    expect(controller.input.sent).toEqual([]);
  });

  test('names control characters and a pasted bracket terminator', async () => {
    await pasteReview('echo \u001b[201~\u0007x');
    await waitFor(() => dialog() !== null, 'the review');
    expect(dialog()!.textContent).toContain('Contains 2 control characters');
    expect(dialog()!.textContent).toContain('bracketed paste terminator');
  });

  test.each([
    [true, 'ends a protected paste early'],
    [false, 'sent as typed'],
  ])(
    'with bracketed paste %p the terminator warning says what happens to it',
    async (bracketed, expected) => {
      const controller = wiredController();
      const { harness, textarea } = await mountReady({
        title: 'Shell',
        state: 'writable',
        controller,
      });
      if (bracketed) await deliverOutput(controller, '\u001b[?2004h');
      textarea.focus();
      textarea.dispatchEvent(pasteEvent('echo \u001b[201~x\n'));
      harness.flush();
      await waitFor(() => dialog() !== null, 'the review');
      const text = dialog()!.textContent ?? '';
      expect(text).toContain('bracketed paste terminator');
      expect(text).toContain(expected);
      expect(text).not.toContain('will be removed');
    },
  );

  test('Cancel closes the review, restores focus to the terminal, and sends nothing', async () => {
    const { controller, textarea } = await pasteReview('a\nb\n');
    await waitFor(() => dialog() !== null, 'the review');
    button('Cancel', dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    expect(document.activeElement).toBe(textarea);
    expect(controller.input.sent).toEqual([]);
  });

  test('Paste sends the exact text once, as the engine converts it, and restores focus', async () => {
    const { controller, textarea } = await pasteReview('a\nb\n');
    await waitFor(() => dialog() !== null, 'the review');
    button('Paste', dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    expect(sentText(controller.input)).toBe('a\rb\r');
    expect(document.activeElement).toBe(textarea);
  });

  test.each([
    ['Cancel', 'Cancel'],
    ['Paste', 'Paste'],
  ])('closing the review with %s restores capture when it was on', async (_name, label) => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    textarea.dispatchEvent(pasteEvent('a\nb\n'));
    harness.flush();
    await waitFor(() => dialog() !== null, 'the review');
    // A browser moves focus into a modal dialog, which takes it from the terminal.
    button('Cancel', dialog()!).focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
    button(label, dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    await waitFor(() => capture.getAttribute('aria-pressed') === 'true', 'capture to return');
    expect(document.activeElement).toBe(textarea);
    // Capture is real again: Tab goes to the shell, not the page.
    const tab = typeKey(textarea, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(tab.keydown.defaultPrevented).toBe(true);
  });

  test('closing the review does not turn capture on when it was off', async () => {
    const { harness, textarea } = await pasteReview('a\nb\n');
    await waitFor(() => dialog() !== null, 'the review');
    button('Cancel', dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    expect(button('Capture terminal keys', harness.target).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(document.activeElement).toBe(textarea);
  });

  test('Escape closes the review, is not shell input, and its release does not reach the shell', async () => {
    const { controller, textarea } = await pasteReview('a\nb\n');
    await waitFor(() => dialog() !== null, 'the review');
    const escape = keyEvent('keydown', { key: 'Escape', code: 'Escape' });
    dialog()!.dispatchEvent(escape);
    dialog()!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => dialog() === null, 'the review to close');
    textarea.dispatchEvent(keyEvent('keyup', { key: 'Escape', code: 'Escape' }));
    expect(controller.input.sent).toEqual([]);
    expect(document.activeElement).toBe(textarea);
  });

  test('Enter on Paste does not also send Enter to the shell when focus returns', async () => {
    const { controller, textarea } = await pasteReview('a\nb\n');
    await waitFor(() => dialog() !== null, 'the review');
    const paste = button('Paste', dialog()!);
    paste.dispatchEvent(keyEvent('keydown', { key: 'Enter', code: 'Enter' }));
    paste.click();
    await waitFor(() => dialog() === null, 'the review to close');
    const carried = typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 });
    expect(carried.keydown.defaultPrevented).toBe(false);
    expect(sentText(controller.input)).toBe('a\rb\r');
    // The next Enter is ordinary input.
    typeKey(textarea, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(sentText(controller.input)).toBe('a\rb\r\r');
  });

  test('a paste over the limit is refused whole with the limit stated, and its text is not kept', async () => {
    const { controller } = await pasteReview('x'.repeat(40), { maximumPasteBytes: 16 });
    await waitFor(() => dialog() !== null, 'the review');
    expect(dialog()!.textContent).toContain('Paste is too large');
    expect(dialog()!.textContent).toContain('40 bytes and the limit is 16');
    expect(dialog()!.textContent).not.toContain('xxxx');
    expect(dialog()!.querySelector('textarea')).toBeNull();
    const labels = [...dialog()!.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).not.toContain('Paste');
    button('Close', dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    expect(controller.input.sent).toEqual([]);
  });

  test('a single plain line is pasted straight through when bracketed mode is off', async () => {
    const { controller } = await pasteReview('echo hi');
    expect(dialog()).toBeNull();
    expect(sentText(controller.input)).toBe('echo hi');
  });

  test('a single plain line is reviewed when bracketed mode is on', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    await deliverOutput(controller, '\u001b[?2004h');
    textarea.focus();
    textarea.dispatchEvent(pasteEvent('echo hi'));
    harness.flush();
    await waitFor(() => dialog() !== null, 'the review');
    expect(controller.input.sent).toEqual([]);
    button('Paste', dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    expect(sentText(controller.input)).toBe('\u001b[200~echo hi\u001b[201~');
  });

  test('a mode change while the review is open updates its warning before anything is sent', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    textarea.focus();
    textarea.dispatchEvent(pasteEvent('echo \u001b[201~x\n'));
    harness.flush();
    await waitFor(() => dialog() !== null, 'the review');
    expect(dialog()!.textContent).toContain('sent as typed');
    await deliverOutput(controller, '\u001b[?2004h');
    button('Paste', dialog()!).click();
    harness.flush();
    await waitFor(
      () => dialog()?.textContent?.includes('ends a protected paste early') === true,
      'the warning to change',
    );
    expect(controller.input.sent).toEqual([]);
    button('Paste', dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    expect(sentText(controller.input)).toBe('\u001b[200~echo \u001b[201~x\r\u001b[201~');
  });

  test('revocation while the reader decides drops the paste and reports it', async () => {
    const refusals: InputRefusal[] = [];
    const { controller } = await pasteReview('a\nb\n', {
      onInputRefused: (refusal) => refusals.push(refusal),
    });
    await waitFor(() => dialog() !== null, 'the review');
    controller.input.authorityRevoked = true;
    button('Paste', dialog()!).click();
    await waitFor(() => dialog() === null, 'the review to close');
    expect(controller.input.sent).toEqual([]);
    expect(refusals).toEqual([{ reason: 'read-only', source: 'paste' }]);
  });
});

describe('copying the terminal selection', () => {
  async function withSelection(state: 'writable' | 'read-only') {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({ title: 'Shell', state, controller });
    await deliverOutput(controller, 'alpha beta');
    // Searching selects the match in the engine, which is a selection the engine owns.
    button('Search', harness.target).click();
    await waitFor(
      () => query(harness, '.cinder-terminal__search textarea') !== null,
      'the search field',
    );
    const field = required(harness, '.cinder-terminal__search textarea') as HTMLTextAreaElement;
    field.value = 'beta';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    harness.flush();
    // Typing is searched after a pause of 150 ms.
    await waitFor(
      () => required(harness, '.cinder-terminal__search-status').textContent?.trim() === '1 match.',
      'the search to run',
    );
    button('Next match', harness.target).click();
    harness.flush();
    return { controller, harness, textarea };
  }

  const copyEvent = () => new Event('copy', { bubbles: true, cancelable: true });

  /** Every distinct message any polite region showed; the open search has a status region too. */
  function recordEveryAnnouncement(harness: MountedHarness): string[] {
    const seen: string[] = [];
    const last = new Map<Element, string>();
    const observer = new MutationObserver(() => {
      for (const region of harness.target.querySelectorAll('[aria-live="polite"]')) {
        const text = region.textContent?.trim() ?? '';
        if (text !== '' && text !== last.get(region)) seen.push(text);
        last.set(region, text);
      }
    });
    observer.observe(harness.target, { childList: true, characterData: true, subtree: true });
    return seen;
  }

  test('announces once, sends no byte, and leaves the native copy to the browser', async () => {
    const { controller, harness, textarea } = await withSelection('writable');
    const seen = recordEveryAnnouncement(harness);
    textarea.dispatchEvent(copyEvent());
    harness.flush();
    await waitFor(() => seen.includes('Terminal selection copied'), 'the copy announcement');
    await settle();
    await settle();
    expect(seen.filter((text) => text === 'Terminal selection copied')).toHaveLength(1);
    expect(sentBytes(controller.input)).toEqual([]);
  });

  test('announces from a read-only view too', async () => {
    const { harness, textarea } = await withSelection('read-only');
    const seen = recordEveryAnnouncement(harness);
    textarea.dispatchEvent(copyEvent());
    harness.flush();
    await waitFor(() => seen.includes('Terminal selection copied'), 'the copy announcement');
  });

  test('says nothing when nothing is selected', async () => {
    const controller = wiredController();
    const { harness, textarea } = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
    });
    const seen = recordEveryAnnouncement(harness);
    textarea.dispatchEvent(copyEvent());
    harness.flush();
    await settle();
    await settle();
    expect(seen).not.toContain('Terminal selection copied');
  });
});
