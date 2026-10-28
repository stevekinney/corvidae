import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../test/mount-harness.ts';
import { reactiveProps } from '../../test/reactive-props.svelte.ts';
import {
  createFakeController,
  type FakeController,
} from '../components/terminal/terminal-attachment-test-support.ts';
import { waitFor } from '../components/terminal/terminal-test-support.ts';
import Terminal from '../components/terminal/terminal.svelte';
import type { TerminalProps } from '../components/terminal/terminal.types.ts';
import { createFakeInputController, sentText } from '../input/input-test-support.ts';
import { textSaver } from './export.ts';
import { inspectionTimer } from './inspection-controller.ts';
import { createManualTimer } from './inspection-test-support.ts';
import { SEARCH_REFRESH_DELAY_MS, type InspectionEvent } from './inspection-types.ts';

const ESC = '\u001b';
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

const originalSave = textSaver.save;
const originalTimer = inspectionTimer.start;
/** The search's pauses pass when a test says so, not when a clock does. */
const timer = createManualTimer();
const saved: string[] = [];

beforeEach(() => {
  inspectionTimer.start = (callback, delay) => timer.start(callback, delay);
  textSaver.save = (text) => {
    saved.push(text);
  };
});

afterEach(async () => {
  inspectionTimer.start = originalTimer;
  timer.flush();
  textSaver.save = originalSave;
  saved.length = 0;
  await destroyAllHarnesses();
});

function wired(): FakeController & { input: ReturnType<typeof createFakeInputController> } {
  return Object.assign(createFakeController(), { input: createFakeInputController() });
}

function required<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`Expected ${selector}`);
  return found;
}

function button(label: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`Expected a "${label}" button`);
  return found;
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');

async function mountReady(props: TerminalProps) {
  const harness = mountHarness(Terminal, props);
  await waitFor(
    () =>
      harness.target.querySelector('.xterm') !== null &&
      !required(harness.target, '.cinder-terminal__viewport').hasAttribute('inert'),
    'the engine to mount',
  );
  harness.flush();
  return harness;
}

/** Deliver output to the engine and wait until it has been parsed. */
function send(controller: FakeController, text: string): Promise<void> {
  const listener = controller.everRegistered.at(-1)!;
  return new Promise<void>((resolve) => listener(bytes(text), resolve));
}

function click(target: HTMLElement, harness: MountedHarness): void {
  target.focus();
  target.click();
  harness.flush();
}

async function openSnapshot(harness: MountedHarness): Promise<HTMLTextAreaElement> {
  click(button('Export', harness.target), harness);
  await waitFor(() => dialog() !== null, 'the export dialog');
  return required<HTMLTextAreaElement>(dialog()!, 'textarea');
}

async function closeDialog(harness: MountedHarness, label: string): Promise<void> {
  button(label, dialog()!).click();
  harness.flush();
  await waitFor(() => dialog() === null, 'the dialog to close');
}

function typeQuery(harness: MountedHarness, query: string): HTMLTextAreaElement {
  const field = required<HTMLTextAreaElement>(harness.target, '.cinder-terminal__search textarea');
  field.value = query;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  timer.flush();
  harness.flush();
  return field;
}

const status = (harness: MountedHarness) =>
  required(harness.target, '.cinder-terminal__search-status').textContent?.trim();

/** What the terminal's live regions say, joined; dialogs bring live regions of their own. */
const announcement = (harness: MountedHarness) =>
  [...harness.target.querySelectorAll('[aria-live="polite"]')]
    .map((region) => region.textContent?.trim())
    .filter((text) => text !== '')
    .join(' | ');

describe('the toolbar', () => {
  test('is made of Cinder buttons, and appears once an engine is mounted', async () => {
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'read-only' });
    expect(harness.target.querySelector('.cinder-terminal__inspection')).toBeNull();
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__inspection') !== null,
      'the toolbar',
    );
    const labels = [
      ...required(harness.target, '.cinder-terminal__inspection').querySelectorAll('button'),
    ].map((candidate) => candidate.textContent?.trim());
    expect(labels).toEqual(['Search', 'Export', 'Clear screen', 'Clear history', 'Reset terminal']);
    expect(button('Export', harness.target).className).toContain('cinder-button');
    expect(
      required(harness.target, '.cinder-terminal__inspection').getAttribute('aria-label'),
    ).toBe('Terminal output tools');
  });

  test('is not offered where there is no engine', () => {
    for (const state of ['empty', 'denied', 'engine-load-failed'] as const) {
      const harness = mountHarness(Terminal, { title: 'Shell', state });
      expect(harness.target.querySelector('.cinder-terminal__inspection')).toBeNull();
    }
  });
});

describe('search', () => {
  async function searching(output: string) {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, output);
    const trigger = button('Search', harness.target);
    click(trigger, harness);
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__search') !== null,
      'the search',
    );
    return { controller, harness, trigger };
  }

  test('opens a labelled field and moves focus into it', async () => {
    const { harness, trigger } = await searching('alpha beta alpha');
    const field = required<HTMLTextAreaElement>(
      harness.target,
      '.cinder-terminal__search textarea',
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(harness.target.querySelector(`label[for="${field.id}"]`)?.textContent).toContain(
      'Search terminal output',
    );
    await waitFor(() => document.activeElement === field, 'focus to move into the field');
    expect(status(harness)).toBe('');
  });

  test('counts matches, steps with the buttons, wraps once, and reports index and count', async () => {
    const { harness } = await searching('alpha beta alpha');
    typeQuery(harness, 'alpha');
    expect(status(harness)).toBe('2 matches.');
    button('Next match', harness.target).click();
    harness.flush();
    expect(status(harness)).toBe('Match 1 of 2.');
    expect(required(harness.target, '.cinder-terminal__search-excerpt mark').textContent).toBe(
      'alpha',
    );
    button('Next match', harness.target).click();
    button('Next match', harness.target).click();
    harness.flush();
    expect(status(harness)).toBe('Match 1 of 2, wrapped around.');
    button('Previous match', harness.target).click();
    harness.flush();
    expect(status(harness)).toBe('Match 2 of 2, wrapped around.');
  });

  test('Enter steps forward; Shift+Enter is left to insert a line break', async () => {
    const { harness } = await searching('a a');
    const field = typeQuery(harness, 'a');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    field.dispatchEvent(enter);
    harness.flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(status(harness)).toBe('Match 1 of 2.');
    const shifted = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(shifted);
    expect(shifted.defaultPrevented).toBe(false);
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }),
    );
    expect(status(harness)).toBe('Match 1 of 2.');
  });

  test('a query may contain a line break', async () => {
    const { harness } = await searching('one\r\ntwo');
    typeQuery(harness, 'one\ntwo');
    expect(status(harness)).toBe('1 match.');
  });

  test('is case-sensitive and literal', async () => {
    const { harness } = await searching('Error error a.b');
    typeQuery(harness, 'error');
    expect(status(harness)).toBe('1 match.');
    typeQuery(harness, 'a.b');
    expect(status(harness)).toBe('1 match.');
    typeQuery(harness, 'a.*');
    expect(status(harness)).toBe('No matches.');
  });

  test('says when the query is too long', async () => {
    const { harness } = await searching('x');
    typeQuery(harness, 'x'.repeat(300));
    expect(status(harness)).toBe('The search is longer than 256 characters.');
  });

  test('new output recomputes the results', async () => {
    const { controller, harness } = await searching('find');
    typeQuery(harness, 'find');
    expect(status(harness)).toBe('1 match.');
    await send(controller, ' find find');
    expect(timer.delays).toEqual([SEARCH_REFRESH_DELAY_MS]);
    timer.flush();
    await waitFor(() => status(harness) === '3 matches.', 'the results to recompute');
  });

  test('cleared output is unavailable to a search', async () => {
    const { harness } = await searching('secret-word\r\nprompt');
    typeQuery(harness, 'secret-word');
    button('Clear history', harness.target).click();
    await waitFor(() => status(harness) === 'No matches.', 'the search to see the clear');
  });

  test('Escape closes it and returns focus to the Search control', async () => {
    const { harness, trigger } = await searching('a');
    const field = required(harness.target, '.cinder-terminal__search textarea');
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    harness.flush();
    expect(harness.target.querySelector('.cinder-terminal__search')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('Close search and the Search toggle close it too', async () => {
    const { harness, trigger } = await searching('a');
    button('Close search', harness.target).click();
    harness.flush();
    expect(harness.target.querySelector('.cinder-terminal__search')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    click(trigger, harness);
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__search') !== null,
      'search',
    );
    click(trigger, harness);
    expect(harness.target.querySelector('.cinder-terminal__search')).toBeNull();
  });

  test('output from a replaced session is no longer found', async () => {
    const first = wired();
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: first,
    });
    const harness = await mountReady(props);
    await send(first, 'find me');
    click(button('Search', harness.target), harness);
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__search') !== null,
      'search',
    );
    typeQuery(harness, 'find');
    expect(status(harness)).toBe('1 match.');
    props.controller = wired();
    await waitFor(() => status(harness) === 'No matches.', 'the old output to be unavailable');
  });

  test('says when the match cannot be selected in the terminal', async () => {
    const { harness } = await searching('one\r\n\r\nthree');
    typeQuery(harness, '\n\n');
    button('Next match', harness.target).click();
    harness.flush();
    expect(status(harness)).toBe('Match 1 of 1. This match cannot be selected in the terminal.');
    typeQuery(harness, 'one');
    button('Next match', harness.target).click();
    harness.flush();
    expect(status(harness)).toBe('Match 1 of 1.');
  });

  test('closing releases the query and the results, so reopening starts empty', async () => {
    const { harness, trigger } = await searching('alpha alpha');
    typeQuery(harness, 'alpha');
    expect(status(harness)).toBe('2 matches.');
    button('Close search', harness.target).click();
    harness.flush();
    click(trigger, harness);
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__search') !== null,
      'search',
    );
    expect(status(harness)).toBe('');
    expect(
      required<HTMLTextAreaElement>(harness.target, '.cinder-terminal__search textarea').value,
    ).toBe('');
  });

  test('Previous and Next are off until there is a match', async () => {
    const { harness } = await searching('x');
    typeQuery(harness, 'nothing');
    expect(button('Next match', harness.target).disabled).toBe(true);
    expect(button('Previous match', harness.target).disabled).toBe(true);
  });
});

describe('accessible output', () => {
  test('opens a Cinder modal with a labelled read-only Textarea holding the output', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'first line\r\nsecond line');
    const field = await openSnapshot(harness);
    expect(dialog()!.getAttribute('role') ?? 'dialog').toBe('dialog');
    expect(dialog()!.textContent).toContain('Export terminal output');
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe('first line\nsecond line');
    expect(dialog()!.querySelector(`label[for="${field.id}"]`)?.textContent).toContain(
      'Terminal output snapshot',
    );
    await waitFor(() => announcement(harness) === 'Terminal snapshot ready', 'the announcement');
  });

  test('an empty terminal says so', async () => {
    const harness = await mountReady({ title: 'Shell', state: 'read-only', controller: wired() });
    const field = await openSnapshot(harness);
    expect(field.value).toBe('');
    expect(dialog()!.textContent).toContain('No retained output.');
  });

  test('new output never changes it, and it says it is stale until Refresh recaptures', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'before');
    const field = await openSnapshot(harness);
    await send(controller, '\r\nafter');
    await waitFor(() => dialog()!.textContent.includes('Snapshot stale'), 'the stale notice');
    expect(field.value).toBe('before');
    button('Refresh', dialog()!).click();
    harness.flush();
    await waitFor(
      () => required<HTMLTextAreaElement>(dialog()!, 'textarea').value === 'before\nafter',
      'the refreshed text',
    );
    expect(dialog()!.textContent).not.toContain('Snapshot stale');
    await waitFor(
      () => announcement(harness) === 'Terminal snapshot refreshed',
      'the announcement',
    );
  });

  test('says when it is truncated and how large the bound is', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, `${'x'.repeat(39)}\r\n`.repeat(2000));
    await openSnapshot(harness);
    expect(dialog()!.textContent).toContain('Snapshot truncated: earlier output was omitted');
    expect(dialog()!.textContent).toContain('The most recent');
    const kept = required<HTMLTextAreaElement>(dialog()!, 'textarea').value;
    expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(65_536);
    expect(dialog()!.textContent).toContain('10,000 lines');
  });

  test('Close restores focus to the control that opened it and releases the text', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'private text');
    const trigger = button('Export', harness.target);
    await openSnapshot(harness);
    await closeDialog(harness, 'Close');
    expect(document.activeElement).toBe(trigger);
    await waitFor(
      () => document.querySelector('textarea[readonly]') === null,
      'the snapshot text to be released',
    );
  });

  test('a restore that finishes late does not take focus the reader already moved on', async () => {
    // The dialog hands focus back to Export, and the panel restores it again when the exit
    // finishes. A reader who moved focus to the terminal in between must keep it (COR-474: the
    // full-reset browser spec lost focus to that second restore in about two runs in three).
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'text');
    await openSnapshot(harness);
    const elsewhere = document.createElement('button');
    elsewhere.textContent = 'Elsewhere';
    document.body.append(elsewhere);
    try {
      const trigger = button('Export', harness.target);
      // The dialog returns focus to Export as its exit completes; the panel's own restore follows
      // a tick later. The reader moves on in between, inside the dialog's own focus return.
      const moveOn = (event: FocusEvent): void => {
        if (event.target === trigger) elsewhere.focus();
      };
      document.addEventListener('focusin', moveOn);
      try {
        button('Close', dialog()!).click();
        harness.flush();
        await waitFor(() => document.activeElement === elsewhere, 'focus to move on');
        await waitFor(() => dialog() === null, 'the dialog to close');
        await quietFor(30);
        expect(document.activeElement?.textContent?.trim()).toBe('Elsewhere');
      } finally {
        document.removeEventListener('focusin', moveOn);
      }
    } finally {
      elsewhere.remove();
    }
  });

  test('Escape closes it, and reopening captures what is there now', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'one');
    await openSnapshot(harness);
    dialog()!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => dialog() === null, 'the dialog to close');
    await send(controller, ' two');
    const field = await openSnapshot(harness);
    expect(field.value).toBe('one two');
    expect(dialog()!.textContent).not.toContain('Snapshot stale');
  });

  test('is available after the process exited and in every state that keeps its output', async () => {
    const controller = wired();
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable', controller });
    const harness = await mountReady(props);
    await send(controller, 'exit output');
    props.state = 'exited';
    harness.flush();
    const field = await openSnapshot(harness);
    expect(field.value).toBe('exit output');
  });

  test('a replaced session disables Refresh and the snapshot stays as it was', async () => {
    const first = wired();
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: first,
    });
    const harness = await mountReady(props);
    await send(first, 'old session');
    await openSnapshot(harness);
    props.controller = wired();
    await waitFor(() => button('Refresh', dialog()!).disabled, 'Refresh to be disabled');
    expect(dialog()!.textContent).toContain('the session was replaced');
    expect(required<HTMLTextAreaElement>(dialog()!, 'textarea').value).toBe('old session');
  });

  test('closing after the toolbar is gone moves focus to the frame', async () => {
    const controller = wired();
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable', controller });
    const harness = await mountReady(props);
    await send(controller, 'text');
    await openSnapshot(harness);
    props.state = 'empty';
    harness.flush();
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__inspection') === null,
      'the toolbar to go',
    );
    await closeDialog(harness, 'Close');
    await waitFor(
      () => document.activeElement === harness.target.querySelector('.cinder-terminal__body'),
      'focus to reach the frame',
    );
  });

  test('Copy puts the snapshot text on the clipboard', async () => {
    const copied: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        },
      },
    });
    try {
      const controller = wired();
      const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
      await send(controller, 'copy me');
      await openSnapshot(harness);
      button('Copy', dialog()!).click();
      await waitFor(() => copied.length === 1, 'the clipboard write');
      expect(copied).toEqual(['copy me']);
    } finally {
      if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', original);
    }
  });
});

describe('links', () => {
  const output = [
    'visible https://example.com/docs.',
    `${ESC}]8;;https://hidden.example/secret${ESC}\\clickable text${ESC}]8;;${ESC}\\`,
    'path /usr/local/bin and ./script.sh',
    'http://insecure.example javascript:alert(1) file:///etc/passwd',
    'command vscode://open?file=x and ftp://files.example',
  ].join('\r\n');

  test('are listed only when the host enabled them, from visible https text only', async () => {
    const controller = wired();
    const activated: string[] = [];
    const harness = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
      onLinkActivate: (url) => activated.push(url),
    });
    await send(controller, output);
    await openSnapshot(harness);
    const links = [...required(dialog()!, '.cinder-terminal__links').querySelectorAll('button')];
    expect(links.map((link) => link.textContent?.trim())).toEqual(['https://example.com/docs']);
    expect(dialog()!.textContent).not.toContain('hidden.example/secret');
    links[0]!.click();
    expect(activated).toEqual(['https://example.com/docs']);
  });

  test('are not listed when the host did not enable them', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, output);
    await openSnapshot(harness);
    expect(dialog()!.querySelector('.cinder-terminal__links')).toBeNull();
  });

  test('cannot be activated once the session was replaced', async () => {
    const first = wired();
    const activated: string[] = [];
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: first,
      onLinkActivate: (url) => activated.push(url),
    });
    const harness = await mountReady(props);
    await send(first, 'go https://example.com/a');
    await openSnapshot(harness);
    props.controller = wired();
    await waitFor(
      () => button('https://example.com/a', dialog()!).disabled,
      'the link to be disabled',
    );
    button('https://example.com/a', dialog()!).click();
    expect(activated).toEqual([]);
  });

  test('a host handler that throws leaves the dialog and the session alone', async () => {
    const controller = wired();
    const harness = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
      onLinkActivate: () => {
        throw new Error('host bug');
      },
    });
    await send(controller, 'https://example.com/a');
    await openSnapshot(harness);
    button('https://example.com/a', dialog()!).click();
    expect(dialog()).not.toBeNull();
    expect(controller.failures).toEqual([]);
  });
});

describe('export', () => {
  test('states what Download will save before it saves it, then saves exactly that as plain text', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'build ok\r\ndone');
    await openSnapshot(harness);
    expect(dialog()!.textContent).toContain('Download ready: 13 bytes of plain text.');
    expect(saved).toEqual([]);
    await send(controller, '\r\nlater');
    button('Download', dialog()!).click();
    expect(saved).toEqual(['build ok\ndone']);
    // The dialog stays open: Download is one of its actions, next to Refresh, Copy and Close.
    expect(dialog()).not.toBeNull();
  });

  test('Close restores focus to Export and saves nothing', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'read-only', controller });
    await send(controller, 'text');
    const trigger = button('Export', harness.target);
    await openSnapshot(harness);
    await closeDialog(harness, 'Close');
    expect(saved).toEqual([]);
    expect(document.activeElement).toBe(trigger);
  });

  test('Escape closes it without saving', async () => {
    const harness = await mountReady({ title: 'Shell', state: 'read-only', controller: wired() });
    await openSnapshot(harness);
    dialog()!.dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => dialog() === null, 'the dialog to close');
    expect(saved).toEqual([]);
  });

  test('Refresh keeps focus on Refresh', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'one');
    await openSnapshot(harness);
    await send(controller, ' two');
    const refresh = button('Refresh', dialog()!);
    refresh.focus();
    refresh.click();
    harness.flush();
    await waitFor(
      () => required<HTMLTextAreaElement>(dialog()!, 'textarea').value === 'one two',
      'the refreshed text',
    );
    expect(document.activeElement).toBe(refresh);
    button('Download', dialog()!).click();
    expect(saved).toEqual(['one two']);
  });

  test('states the truncation before download, keeps the newest lines, and puts no marker in the file', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    const lines = Array.from({ length: 10_100 }, (_, index) => `n${index}`);
    await send(controller, lines.join('\r\n'));
    await openSnapshot(harness);
    expect(dialog()!.textContent).toContain('Download truncated: earlier output was omitted.');
    expect(dialog()!.textContent).toContain('10,000 lines');
    expect(saved).toEqual([]);
    await waitFor(
      () => announcement(harness) === 'Terminal snapshot truncated',
      'the announcement',
    );
    button('Download', dialog()!).click();
    expect(saved).toHaveLength(1);
    const text = saved[0]!;
    const kept = text.split('\n');
    expect(kept).toHaveLength(10_000);
    expect(kept[0]).toBe('n100');
    expect(kept.at(-1)).toBe('n10099');
    expect(text).not.toContain('\r');
    expect(text).not.toContain('omitted');
  });
});

describe('clearing', () => {
  test('each control is distinct, announced, and applied locally', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(
      controller,
      `${Array.from({ length: 30 }, (_, i) => `l${i}`).join('\r\n')}\r\nprompt`,
    );
    button('Clear screen', harness.target).click();
    await waitFor(() => announcement(harness) === 'Terminal screen cleared', 'the screen clear');
    let field = await openSnapshot(harness);
    expect(field.value).toContain('l0\n');
    expect(field.value).not.toContain('prompt');
    await closeDialog(harness, 'Close');
    button('Clear history', harness.target).click();
    await waitFor(() => announcement(harness) === 'Terminal history cleared', 'the history clear');
    await send(controller, ' next');
    field = await openSnapshot(harness);
    expect(field.value.trim()).toBe('next');
    await closeDialog(harness, 'Close');
    await send(controller, `${ESC}[?1049halt`);
    button('Reset terminal', harness.target).click();
    await waitFor(() => announcement(harness) === 'Terminal reset', 'the reset');
    field = await openSnapshot(harness);
    expect(field.value).toBe('');
  });

  test('an open snapshot goes stale when the terminal is cleared, and keeps its text', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'text\r\nprompt');
    const field = await openSnapshot(harness);
    button('Clear history', harness.target).click();
    await waitFor(() => dialog()!.textContent.includes('Snapshot stale'), 'the stale notice');
    expect(field.value).toBe('text\nprompt');
  });
});

describe('what inspection never does', () => {
  /** Every inspection action, in the order a reader might use them. */
  async function useEveryTool(harness: MountedHarness): Promise<void> {
    click(button('Search', harness.target), harness);
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__search') !== null,
      'search',
    );
    typeQuery(harness, 'output');
    button('Next match', harness.target).click();
    button('Close search', harness.target).click();
    await openSnapshot(harness);
    button('Refresh', dialog()!).click();
    button('Download', dialog()!).click();
    await closeDialog(harness, 'Close');
    button('Clear screen', harness.target).click();
    button('Clear history', harness.target).click();
    button('Reset terminal', harness.target).click();
    await waitFor(() => announcement(harness) === 'Terminal reset', 'the reset');
  }

  const focusEngine = (harness: MountedHarness) =>
    required<HTMLTextAreaElement>(harness.target, '.xterm-helper-textarea').focus();

  test('with the terminal focused, sends no input, restarts nothing, and tells the controller nothing', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    await send(controller, 'output https://example.com/x');
    focusEngine(harness);
    await useEveryTool(harness);
    expect(controller.input.sent).toEqual([]);
    expect(controller.failures).toEqual([]);
    expect(controller.disposals).toBe(0);
    expect(controller.subscriptions).toBe(1);
    expect(controller.unsubscriptions).toBe(0);
  });

  test('under focus reporting, the only bytes are the engine’s own focus reports', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    focusEngine(harness);
    // The program asked to be told about focus; the engine reports its focus once, at once.
    await send(controller, `${ESC}[?1004h${ESC}[?2004houtput https://example.com/x`);
    expect(sentText(controller.input)).toBe(`${ESC}[I`);
    await useEveryTool(harness);
    // Opening Search moved focus off the terminal, so the engine reported that, as the protocol
    // requires. Nothing else was sent: no key, no query text, no paste, no reset.
    const sent = sentText(controller.input);
    expect(sent.startsWith(`${ESC}[I${ESC}[O`)).toBe(true);
    expect(sent.replaceAll(`${ESC}[I`, '').replaceAll(`${ESC}[O`, '')).toBe('');
    expect(controller.failures).toEqual([]);
  });

  test('a read-only view stays input-free through every action', async () => {
    const controller = wired();
    const harness = await mountReady({ title: 'Shell', state: 'read-only', controller });
    await send(controller, 'x');
    for (const label of ['Clear screen', 'Clear history', 'Reset terminal']) {
      button(label, harness.target).click();
    }
    await openSnapshot(harness);
    expect(controller.input.sent).toEqual([]);
  });
});

describe('metrics', () => {
  test('are typed events with no output, query or address in them, and a throwing observer breaks nothing', async () => {
    const controller = wired();
    const events: InspectionEvent[] = [];
    let throwing = false;
    const harness = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
      onLinkActivate: () => {},
      onInspectionEvent: (event) => {
        events.push(event);
        if (throwing) throw new Error('observer bug');
      },
    });
    await send(controller, 'password=hunter2 https://secret.example/token');
    click(button('Search', harness.target), harness);
    await waitFor(
      () => harness.target.querySelector('.cinder-terminal__search') !== null,
      'search',
    );
    typeQuery(harness, 'hunter2');
    button('Next match', harness.target).click();
    await openSnapshot(harness);
    button('https://secret.example/token', dialog()!).click();
    throwing = true;
    button('Download', dialog()!).click();
    await closeDialog(harness, 'Close');
    expect(saved).toEqual(['password=hunter2 https://secret.example/token']);
    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain('hunter2');
    expect(recorded).not.toContain('secret.example');
    expect(recorded).not.toContain('password');
    expect(events.map((event) => event.kind)).toEqual([
      'search',
      'navigate',
      'snapshot',
      'link',
      'export',
      'snapshot',
    ]);
    // Output order is untouched by a failing observer.
    await send(controller, ' tail');
    expect(controller.failures).toEqual([]);
  });
});
