import { afterEach, describe, expect, test } from 'bun:test';

import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../test/mount-harness.ts';
import { reactiveProps } from '../../test/reactive-props.svelte.ts';
import { createFakeController } from '../components/terminal/terminal-attachment-test-support.ts';
import { waitFor } from '../components/terminal/terminal-test-support.ts';
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

  test('capture lasts only while the terminal has focus', async () => {
    const controller = wiredController();
    const { harness } = await mountReady({ title: 'Shell', state: 'writable', controller });
    const capture = button('Capture terminal keys', harness.target);
    capture.click();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('true');
    capture.focus();
    harness.flush();
    expect(capture.getAttribute('aria-pressed')).toBe('false');
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
    const encoder = new TextEncoder();
    controller.emit(encoder.encode('hello\r\n'));
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    controller.emit(new TextEncoder().encode('\u001b[c'));
    await new Promise((resolve) => setTimeout(resolve, 30));
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

  test('a single plain line is pasted straight through, bracketed or not', async () => {
    const { controller } = await pasteReview('echo hi');
    expect(dialog()).toBeNull();
    expect(sentText(controller.input)).toBe('echo hi');
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
    expect(refusals).toEqual([{ reason: 'read-only' }]);
  });
});
