/// <reference lib="dom" />
import * as matchers from '@testing-library/jest-dom/matchers';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

expect.extend(matchers as Parameters<typeof expect.extend>[0]);

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Select } = await import('./select.svelte');
const { resetEscapeStack } = await import('../../_internal/overlay.ts');

beforeEach(() => {
  document.body.replaceChildren();
  resetEscapeStack();
});
afterEach(() => cleanup());

const agents = [
  { value: 'assistant', label: 'Assistant', description: 'Answers every message the same way.' },
  {
    value: 'tool-runner',
    label: 'Tool runner',
    description: 'Looks an order up.',
    note: 'Needs a provider',
  },
  { value: 'echo', label: 'Echo', description: 'Repeats the last message.' },
] as const;

function trigger(container: HTMLElement): HTMLButtonElement {
  return requiredInstance(container.querySelector('[role="combobox"]'), HTMLButtonElement);
}

function options(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
}

async function openByClick(container: HTMLElement): Promise<void> {
  await fireEvent.click(trigger(container));
  await waitFor(() => {
    if (options().length === 0) throw new Error('listbox has not opened');
  });
}

function renderListbox(props: Record<string, unknown> = {}) {
  return render(Select, {
    props: { id: 'agent', label: 'Agent', options: agents, presentation: 'listbox', ...props },
  } as never);
}

describe('Select listbox presentation: trigger', () => {
  test('renders a select-only combobox button, named by its label, showing the current label', () => {
    const { container } = renderListbox({ value: 'echo' });
    const button = trigger(container);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('label')?.getAttribute('for')).toBe('agent');
    expect(button.textContent).toContain('Echo');
    expect(container.querySelector('select')).toBeNull();
  });

  test('shows the placeholder, muted, while nothing is selected', () => {
    const { container } = renderListbox({ placeholder: 'Loading models' });
    const placeholder = container.querySelector('[data-cinder-placeholder]');
    expect(placeholder?.textContent).toBe('Loading models');
  });

  test('draws the prefix before the value and hides it from assistive technology', () => {
    const { container } = renderListbox({ value: 'assistant', valuePrefix: 'Agent' });
    const prefix = requiredInstance(container.querySelector('.cinder-select__prefix'), HTMLElement);
    expect(prefix.getAttribute('aria-hidden')).toBe('true');
    expect(prefix.textContent).toBe('Agent');
    expect(prefix.nextElementSibling?.textContent).toBe('Assistant');
  });

  test('keeps the label of a selected option that is disabled (no longer offered)', () => {
    const { container } = renderListbox({
      value: 'old',
      options: [
        { value: 'old', label: 'Claude Sonnet 4, no longer offered', disabled: true },
        { value: 'new', label: 'Claude Sonnet 5.5' },
      ],
      error: 'This model is no longer offered. Pick another model before you save.',
    });
    expect(trigger(container).textContent).toContain('no longer offered');
    expect(trigger(container).getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('This model is no longer offered.');
  });

  test('is a ghost trigger when variant is ghost', () => {
    const { container } = renderListbox({ variant: 'ghost', value: 'assistant' });
    expect(trigger(container).getAttribute('data-cinder-variant')).toBe('ghost');
    expect(
      container.querySelector('.cinder-select-field')?.getAttribute('data-cinder-variant'),
    ).toBe('ghost');
    // The chevron is kept.
    expect(container.querySelector('.cinder-select-field__chevron')).not.toBeNull();
  });

  test('submits through a hidden input when it has a name', () => {
    const { container } = renderListbox({ value: 'echo', name: 'agent' });
    const hidden = requiredInstance(
      container.querySelector('input[type="hidden"][name="agent"]'),
      HTMLInputElement,
    );
    expect(hidden.value).toBe('echo');
  });

  test('is disabled when disabled', () => {
    const { container } = renderListbox({ disabled: true });
    expect(trigger(container)).toBeDisabled();
  });
});

describe('Select listbox presentation: opening and choosing', () => {
  test('click opens a listbox with the current option checked, and its descriptions', async () => {
    const { container } = renderListbox({ value: 'assistant' });
    await openByClick(container);
    const rows = options();
    expect(
      rows.map((row) => row.querySelector('.cinder-select__option-label')?.textContent),
    ).toEqual(['Assistant', 'Tool runner', 'Echo']);
    expect(trigger(container).getAttribute('aria-expanded')).toBe('true');
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
    expect(rows[0]?.querySelector('.cinder-select__option-check')).not.toBeNull();
    expect(rows[1]?.getAttribute('aria-selected')).toBe('false');
    expect(rows[1]?.querySelector('.cinder-select__option-description')?.textContent).toBe(
      'Looks an order up.',
    );
    expect(rows[1]?.querySelector('.cinder-select__option-note')?.textContent).toBe(
      'Needs a provider',
    );
    const listbox = requiredInstance(document.body.querySelector('[role="listbox"]'), HTMLElement);
    expect(trigger(container).getAttribute('aria-controls')).toBe(listbox.id);
  });

  test('choosing an option sets the value, tells the caller and closes with focus on the trigger', async () => {
    const onValueChange = mock(() => {});
    const { container } = renderListbox({ value: 'assistant', onValueChange });
    await openByClick(container);
    await fireEvent.click(options()[2]!);
    expect(onValueChange).toHaveBeenCalledWith('echo');
    expect(trigger(container).textContent).toContain('Echo');
    expect(trigger(container).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger(container));
  });

  test('a pick the request hook refuses never stays on the trigger', async () => {
    const onValueChange = mock(() => {});
    const { container } = renderListbox({
      value: 'assistant',
      onValueChange,
      onValueChangeRequest: () => 'assistant',
    });
    await openByClick(container);
    await fireEvent.click(options()[2]!);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger(container).textContent).toContain('Assistant');
    expect(trigger(container).textContent).not.toContain('Echo');
  });

  test('a pick the request hook replaces is the value that is shown and announced', async () => {
    const onValueChange = mock(() => {});
    const { container } = renderListbox({
      value: 'assistant',
      onValueChange,
      onValueChangeRequest: () => 'tool-runner',
    });
    await openByClick(container);
    await fireEvent.click(options()[2]!);
    expect(onValueChange).toHaveBeenCalledWith('tool-runner');
    expect(trigger(container).textContent).toContain('Tool runner');
  });

  test('a suffix sits muted on the label line, and the trigger can carry its own', async () => {
    const { container } = renderListbox({
      value: 'sonnet',
      options: [
        { value: 'sonnet', label: 'Claude Sonnet 5.5', triggerSuffix: 'Anthropic' },
        { value: 'archiver', label: 'Nightly archiver', suffix: 'no description' },
      ],
    });
    expect(
      container.querySelector('.cinder-select__value')?.textContent?.replace(/\s+/g, ' ').trim(),
    ).toBe('Claude Sonnet 5.5, Anthropic');
    await openByClick(container);
    const [sonnet, archiver] = options();
    expect(sonnet?.querySelector('.cinder-select__option-label')?.textContent?.trim()).toBe(
      'Claude Sonnet 5.5',
    );
    expect(
      archiver
        ?.querySelector('.cinder-select__option-label')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim(),
    ).toBe('Nightly archiver, no description');
    expect(archiver?.querySelector('.cinder-select__suffix')).not.toBeNull();
  });

  test('a disabled option is shown with its reason and cannot be chosen', async () => {
    const onValueChange = mock(() => {});
    const { container } = renderListbox({
      value: 'assistant',
      onValueChange,
      options: [
        { value: 'assistant', label: 'Assistant' },
        {
          value: 'release',
          label: 'Release helper',
          description: 'Plugin Demo is disabled',
          disabled: true,
        },
      ],
    });
    await openByClick(container);
    const disabledRow = options()[1]!;
    expect(disabledRow.getAttribute('aria-disabled')).toBe('true');
    expect(disabledRow.textContent).toContain('Plugin Demo is disabled');
    await fireEvent.click(disabledRow);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger(container).textContent).toContain('Assistant');
  });

  test('ArrowDown opens with the cursor on the current option; arrows move it; Enter chooses', async () => {
    const onValueChange = mock(() => {});
    const { container } = renderListbox({ value: 'tool-runner', onValueChange });
    const button = trigger(container);
    button.focus();
    await fireEvent.keyDown(button, { key: 'ArrowDown' });
    await waitFor(() => {
      if (options().length === 0) throw new Error('not open');
    });
    expect(button.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    await fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(button.getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    expect(options()[2]!.getAttribute('data-cinder-active')).toBe('true');
    await fireEvent.keyDown(button, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('echo');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('Home and End jump to the first and last option', async () => {
    const { container } = renderListbox({ value: 'tool-runner' });
    const button = trigger(container);
    button.focus();
    await fireEvent.keyDown(button, { key: 'Enter' });
    await waitFor(() => {
      if (options().length === 0) throw new Error('not open');
    });
    await fireEvent.keyDown(button, { key: 'End' });
    expect(button.getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
    await fireEvent.keyDown(button, { key: 'Home' });
    expect(button.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  });

  test('the cursor can stand on a disabled option, but Enter does not choose it', async () => {
    const onValueChange = mock(() => {});
    const { container } = renderListbox({
      value: 'assistant',
      onValueChange,
      options: [
        { value: 'assistant', label: 'Assistant' },
        { value: 'off', label: 'Off', disabled: true, description: 'Paused' },
      ],
    });
    const button = trigger(container);
    button.focus();
    await fireEvent.keyDown(button, { key: 'ArrowDown' });
    await waitFor(() => {
      if (options().length === 0) throw new Error('not open');
    });
    await fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(button.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    await fireEvent.keyDown(button, { key: 'Enter' });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('Escape closes the list and keeps focus on the trigger', async () => {
    const { container } = renderListbox({ value: 'assistant' });
    await openByClick(container);
    const button = trigger(container);
    button.focus();
    await fireEvent.keyDown(button, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  test('typing a letter opens the list and moves the cursor to the matching option', async () => {
    const { container } = renderListbox({ value: 'assistant' });
    const button = trigger(container);
    button.focus();
    await fireEvent.keyDown(button, { key: 'e' });
    await waitFor(() => {
      if (options().length === 0) throw new Error('not open');
    });
    expect(button.getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
  });
});

describe('Select listbox presentation: read-only', () => {
  test('is focusable, exposes aria-readonly and never opens', async () => {
    const { container } = renderListbox({ value: 'assistant', readonly: true });
    const button = trigger(container);
    expect(button.getAttribute('aria-readonly')).toBe('true');
    expect(button).not.toBeDisabled();
    button.focus();
    expect(document.activeElement).toBe(button);
    await fireEvent.click(button);
    await fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(options()).toHaveLength(0);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('the native presentation blocks the picker and exposes aria-readonly', async () => {
    const { container } = render(Select, {
      props: { id: 'native', label: 'Native', options: agents, value: 'assistant', readonly: true },
    } as never);
    const select = requiredInstance(container.querySelector('select'), HTMLSelectElement);
    expect(select.getAttribute('aria-readonly')).toBe('true');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    select.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    const key = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    select.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    select.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });
});

describe('Select listbox presentation: groups, messages and footer', () => {
  const messageSnippet = createRawSnippet(() => ({
    render: () =>
      '<span>Connect in <a href="#models">Settings › Models</a> to choose a GPT model.</span>',
  }));
  const footerSnippet = createRawSnippet(() => ({
    render: () => '<a href="#plugin">Enable the Demo plugin and restart</a>',
  }));

  const grouped = [
    { value: 'opus', label: 'Claude Opus 5.5', description: 'Most capable', group: 'anthropic' },
    { value: 'sonnet', label: 'Claude Sonnet 5.5', description: 'Balanced', group: 'anthropic' },
  ];

  test('draws group headings, then a heading-only group with its non-selectable message', async () => {
    const { container } = renderListbox({
      value: 'sonnet',
      options: grouped,
      groups: [
        { name: 'anthropic', heading: 'Anthropic' },
        { name: 'openai', heading: 'OpenAI, not connected', message: messageSnippet },
      ],
    });
    await openByClick(container);
    const headings = Array.from(
      document.body.querySelectorAll('.cinder-_option-group__label'),
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(['Anthropic', 'OpenAI, not connected']);
    const message = requiredInstance(
      document.body.querySelector('.cinder-select__group-message'),
      HTMLElement,
    );
    expect(message.textContent).toContain('to choose a GPT model.');
    // The message is text, not an option: only the two models are options.
    expect(options()).toHaveLength(2);
    const group = document.body.querySelector('.cinder-_option-group__options')!;
    expect(group.getAttribute('aria-labelledby')).toBe(
      document.body.querySelector('.cinder-_option-group__label')!.id,
    );
  });

  test('a group message is outside role=listbox, and the listbox still owns every option', async () => {
    const { container } = renderListbox({
      value: 'sonnet',
      options: grouped,
      groups: [
        { name: 'anthropic', heading: 'Anthropic' },
        { name: 'openai', heading: 'OpenAI, not connected', message: messageSnippet },
      ],
    });
    await openByClick(container);
    const listbox = requiredInstance(document.body.querySelector('[role="listbox"]'), HTMLElement);
    const link = requiredInstance(
      document.body.querySelector('.cinder-select__group-message a'),
      HTMLElement,
    );
    expect(listbox.contains(link)).toBe(false);
    const owned = (listbox.getAttribute('aria-owns') ?? '').split(' ');
    const reachable = options().filter((option) =>
      owned.some(
        (ownedId) => option.id === ownedId || document.getElementById(ownedId)?.contains(option),
      ),
    );
    expect(reachable).toHaveLength(2);
  });

  test('a divided group carries the divider marker', async () => {
    const { container } = renderListbox({
      value: 'assistant',
      options: [
        { value: 'assistant', label: 'Assistant' },
        { value: 'rh', label: 'Release helper', disabled: true, group: 'unavailable' },
      ],
      groups: [{ name: 'unavailable', heading: 'Unavailable', divided: true }],
    });
    await openByClick(container);
    expect(
      document.body.querySelector('.cinder-select__group')?.hasAttribute('data-cinder-divided'),
    ).toBe(true);
    // Ungrouped options come first, then the group.
    expect(
      options().map((row) => row.querySelector('.cinder-select__option-label')?.textContent),
    ).toEqual(['Assistant', 'Release helper']);
  });

  test('the footer sits outside the listbox, with a stop of its own after the options', async () => {
    const { container } = renderListbox({ value: 'assistant', footer: footerSnippet });
    await openByClick(container);
    const listbox = requiredInstance(document.body.querySelector('[role="listbox"]'), HTMLElement);
    const link = requiredInstance(
      document.body.querySelector('.cinder-select__footer a'),
      HTMLElement,
    );
    expect(listbox.contains(link)).toBe(false);

    const button = trigger(container);
    button.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    button.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(link);
    // The list is still open while focus is on the footer.
    expect(button.getAttribute('aria-expanded')).toBe('true');

    // Tab from the last stop closes the list and hands focus back to the trigger, so the browser
    // carries on from there to the next control.
    link.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'));
    expect(document.activeElement).toBe(button);
  });

  test('Shift+Tab from the first stop goes back to the trigger', async () => {
    const { container } = renderListbox({ value: 'assistant', footer: footerSnippet });
    await openByClick(container);
    const link = requiredInstance(
      document.body.querySelector('.cinder-select__footer a'),
      HTMLElement,
    );
    link.focus();
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger(container));
  });

  test('without a footer or a message, Tab from the trigger just closes the list', async () => {
    const { container } = renderListbox({ value: 'assistant' });
    await openByClick(container);
    const button = trigger(container);
    button.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    button.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'));
  });

  test('renders the leading mark in the options and in the trigger', async () => {
    const leading = createRawSnippet<[{ value: string }]>((option) => ({
      render: () => `<span class="mark">${option().value.slice(0, 1).toUpperCase()}</span>`,
    }));
    const { container } = renderListbox({ value: 'echo', leading });
    expect(trigger(container).querySelector('.mark')?.textContent).toBe('E');
    await openByClick(container);
    expect(options().map((row) => row.querySelector('.mark')?.textContent)).toEqual([
      'A',
      'T',
      'E',
    ]);
  });
});
