/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Combobox } = await import('./combobox.svelte');
const { default: Fixture } = await import('./combobox.fixture.svelte');
const { resetEscapeStack } = await import('../../_internal/overlay.ts');

beforeEach(() => {
  document.body.replaceChildren();
  resetEscapeStack();
});
afterEach(() => cleanup());

const workflows = [
  {
    value: 'chat',
    label: 'Chat with an agent',
    description: 'Send a message to an agent each time it runs.',
    group: 'Built in',
  },
  {
    value: 'release',
    label: 'Release notes',
    description: 'Collects merged changes into a draft.',
    group: 'Recent',
  },
  {
    value: 'refund',
    label: 'Order refund',
    description: 'Looks up an order, waits for approval, then refunds it.',
    group: 'Recent',
  },
  {
    value: 'triage',
    label: 'Triage inbox',
    description: 'Sorts new messages and flags anything urgent.',
    group: 'All workflows',
  },
];

function trigger(): HTMLButtonElement {
  return requiredInstance(document.body.querySelector('#workflow'), HTMLButtonElement);
}

async function openPicker(): Promise<HTMLInputElement> {
  await fireEvent.click(trigger());
  let search: HTMLInputElement | null = null;
  await waitFor(() => {
    search = document.body.querySelector<HTMLInputElement>('.cinder-combobox__search input');
    if (!search) throw new Error('search field has not mounted');
  });
  // The panel is hidden until positioned, so focus lands on the search field a moment after it mounts.
  // Compare as booleans: a failed `toBe` on two DOM nodes spends seconds formatting them.
  await waitFor(() => expect(document.activeElement === search).toBe(true));
  return search!;
}

function optionLabels(): string[] {
  return Array.from(
    document.body.querySelectorAll('[role="option"] .cinder-combobox__option-label'),
  ).map((label) => label.textContent?.trim() ?? '');
}

const pickerProps = {
  id: 'workflow',
  label: 'Workflow',
  required: true,
  placeholder: 'Pick a workflow',
  presentation: 'picker' as const,
  searchPlaceholder: 'Search workflows',
  options: workflows,
  groupCountVisible: false,
};

describe('Combobox picker presentation', () => {
  test('the closed field is a combobox button with the label, required marker and chevron', () => {
    const { container } = render(Combobox, pickerProps);

    expect(trigger().getAttribute('role')).toBe('combobox');
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().textContent?.trim()).toBe('Pick a workflow');
    expect(container.querySelector('label[for="workflow"]')?.textContent).toContain('Workflow');
    expect(container.querySelector('.cinder-combobox__chevron')).not.toBeNull();
  });

  test('opening moves focus into a search field and lists the groups without counts', async () => {
    render(Combobox, pickerProps);
    const search = await openPicker();

    // Compare as booleans: a failed `toBe` on two DOM nodes spends seconds formatting them.
    await waitFor(() => expect(document.activeElement === search).toBe(true));
    expect(search.getAttribute('placeholder')).toBe('Search workflows');
    expect(search.getAttribute('role')).toBe('combobox');
    expect(search.getAttribute('aria-controls')).toBe('workflow-listbox');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(optionLabels()).toEqual([
      'Chat with an agent',
      'Release notes',
      'Order refund',
      'Triage inbox',
    ]);
    const headings = Array.from(document.body.querySelectorAll('.cinder-_option-group__label')).map(
      (heading) => heading.textContent?.trim(),
    );
    expect(headings).toEqual(['Built in', 'Recent', 'All workflows']);
    expect(document.body.querySelector('.cinder-_option-group__count')).toBeNull();
  });

  test('each option is a bold name with its description on line two', async () => {
    render(Combobox, pickerProps);
    await openPicker();

    const row = document.body.querySelector('[role="option"]');
    expect(row?.querySelector('.cinder-combobox__option-label')?.textContent).toBe(
      'Chat with an agent',
    );
    expect(row?.querySelector('.cinder-combobox__option-description')?.textContent).toBe(
      'Send a message to an agent each time it runs.',
    );
  });

  test('choosing an option closes the panel and shows its name and description in the trigger', async () => {
    render(Combobox, pickerProps);
    await openPicker();
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((element) =>
      element.textContent?.includes('Release notes'),
    );
    await fireEvent.mouseDown(requiredInstance(option ?? null, HTMLElement));

    await waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'));
    expect(trigger().querySelector('.cinder-combobox__trigger-value')?.textContent).toBe(
      'Release notes',
    );
    expect(trigger().querySelector('.cinder-combobox__trigger-description')?.textContent).toBe(
      'Collects merged changes into a draft.',
    );
    // The panel hands focus back to the trigger rather than dropping it on the page.
    await waitFor(() => expect(document.activeElement === trigger()).toBe(true));
  });

  test('the chosen option carries a check at the right and the accent tint', async () => {
    render(Combobox, { ...pickerProps, value: 'chat' });
    await openPicker();

    const chosen = document.body.querySelector('[role="option"][aria-selected="true"]');
    expect(
      chosen?.querySelector('.cinder-combobox__option-check[data-cinder-visible]'),
    ).not.toBeNull();
    // After the text, not before it.
    const children = Array.from(chosen?.children ?? []);
    expect(children.at(-1)?.classList.contains('cinder-combobox__option-check')).toBe(true);
  });

  test('typing narrows the list; the trigger text is not disturbed', async () => {
    render(Combobox, { ...pickerProps, value: 'chat' });
    const search = await openPicker();
    await fireEvent.input(search, { target: { value: 'refund' } });

    await waitFor(() => expect(optionLabels()).toEqual(['Order refund']));
    expect(trigger().querySelector('.cinder-combobox__trigger-value')?.textContent).toBe(
      'Chat with an agent',
    );
  });

  test('a search with no match says so, keeps the search field and keeps the footer', async () => {
    const footer = createRawSnippet(() => ({
      render: () => '<span>No match? <a href="#create">Create one</a></span>',
    }));
    render(Combobox, {
      ...pickerProps,
      footer,
      noMatchLabel: (query: string) => `No workflows match “${query}”.`,
    });
    const search = await openPicker();
    await fireEvent.input(search, { target: { value: 'refnud' } });

    await waitFor(() => {
      expect(document.body.querySelector('.cinder-combobox__empty')?.textContent).toBe(
        'No workflows match “refnud”.',
      );
    });
    expect(document.body.querySelector('[role="option"]')).toBeNull();
    expect(document.body.querySelector('.cinder-combobox__search input')).toBe(search);
    expect(document.body.querySelector('.cinder-combobox__footer')?.textContent).toContain(
      'No match? Create one',
    );
    expect(trigger().textContent?.trim()).toBe('Pick a workflow');
  });

  test('Escape closes the panel and keeps the value', async () => {
    render(Combobox, { ...pickerProps, value: 'chat' });
    const search = await openPicker();
    await fireEvent.keyDown(search, { key: 'Escape' });

    await waitFor(() => expect(trigger().getAttribute('aria-expanded')).toBe('false'));
    expect(trigger().querySelector('.cinder-combobox__trigger-value')?.textContent).toBe(
      'Chat with an agent',
    );
  });

  test('arrow keys move the cursor and Enter chooses the active option', async () => {
    let chosen = '';
    render(Combobox, {
      ...pickerProps,
      onValueChange: (next: string) => {
        chosen = next;
      },
    });
    const search = await openPicker();
    await fireEvent.keyDown(search, { key: 'ArrowDown' });
    await fireEvent.keyDown(search, { key: 'ArrowDown' });
    await waitFor(() => {
      const active = document.body.querySelector('[role="option"][data-cinder-active]');
      expect(active?.textContent).toContain('Release notes');
      expect(search.getAttribute('aria-activedescendant')).toBe(active?.id ?? '');
    });
    await fireEvent.keyDown(search, { key: 'Enter' });

    expect(chosen).toBe('release');
  });

  test('shows how many options match beside the search field when asked', async () => {
    render(Combobox, { ...pickerProps, matchCountVisible: true });
    const search = await openPicker();
    expect(document.body.querySelector('.cinder-combobox__match-count')).toBeNull();
    await fireEvent.input(search, { target: { value: 'order' } });

    await waitFor(() => {
      expect(document.body.querySelector('.cinder-combobox__match-count')?.textContent).toBe(
        '1 of 4',
      );
    });
  });

  test('a disabled picker does not open', async () => {
    render(Combobox, { ...pickerProps, disabled: true });
    await fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('.cinder-combobox__search')).toBeNull();
  });

  test('Tab from the search field lands on the footer link, which keeps the list open', async () => {
    const footer = createRawSnippet(() => ({
      render: () => '<span>No match? <a href="#create">Create one</a></span>',
    }));
    render(Combobox, { ...pickerProps, footer });
    const search = await openPicker();
    await fireEvent.keyDown(search, { key: 'Tab' });

    const link = document.body.querySelector<HTMLAnchorElement>('.cinder-combobox__footer a');
    await waitFor(() => expect(document.activeElement === link).toBe(true));
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Combobox panel focus', () => {
  test('pressing the panel text keeps focus in the search field; controls inside still take it', async () => {
    const footer = createRawSnippet(() => ({
      render: () => '<span>No match? <a href="#create">Create one</a></span>',
    }));
    render(Combobox, { ...pickerProps, footer });
    await openPicker();

    const footerText = requiredInstance(
      document.body.querySelector('.cinder-combobox__footer span'),
      HTMLElement,
    );
    // `fireEvent` returns false when the event was cancelled, which is what stops the browser
    // moving focus onto the panel root.
    expect(await fireEvent.mouseDown(footerText)).toBe(false);
    const link = requiredInstance(
      document.body.querySelector('.cinder-combobox__footer a'),
      HTMLElement,
    );
    expect(await fireEvent.mouseDown(link)).toBe(true);
  });
});

describe('Combobox rows and states', () => {
  test('a row shows a raw code beside the name and meta text at the trailing edge', async () => {
    render(Combobox, {
      id: 'event',
      label: 'Event',
      options: [
        { value: 'run.error', label: 'A run fails', code: 'run.error', meta: 'any workflow' },
      ],
      selectedIndicator: 'start',
    });
    await fireEvent.focus(
      requiredInstance(document.body.querySelector('#event'), HTMLInputElement),
    );
    await waitFor(() => expect(document.body.querySelector('[role="option"]')).not.toBeNull());

    const row = document.body.querySelector('[role="option"]');
    const heading = row?.querySelector('.cinder-combobox__option-heading');
    expect(heading?.querySelector('.cinder-combobox__option-label')?.textContent).toBe(
      'A run fails',
    );
    expect(heading?.querySelector('code.cinder-combobox__option-code')?.textContent).toBe(
      'run.error',
    );
    expect(row?.querySelector('.cinder-combobox__option-meta')?.textContent).toBe('any workflow');
    expect(row?.getAttribute('aria-label')).toBe('A run fails, run.error, any workflow');
    // The check sits before the text when asked.
    expect(row?.firstElementChild?.classList.contains('cinder-combobox__option-check')).toBe(true);
  });

  test('the optionMeta snippet replaces the meta text', async () => {
    const optionMeta = createRawSnippet<[{ label: string }]>((option) => ({
      render: () => `<em>${option().label}!</em>`,
    }));
    render(Combobox, {
      id: 'event',
      options: [{ value: 'a', label: 'Alpha', meta: 'ignored' }],
      optionMeta,
    });
    await fireEvent.focus(
      requiredInstance(document.body.querySelector('#event'), HTMLInputElement),
    );
    await waitFor(() => expect(document.body.querySelector('[role="option"]')).not.toBeNull());

    expect(document.body.querySelector('.cinder-combobox__option-meta')?.innerHTML).toContain(
      '<em>Alpha!</em>',
    );
  });

  test('a danger reason draws in the danger tone and a disabled option cannot be chosen', async () => {
    let chosen = '';
    render(Combobox, {
      id: 'run',
      label: 'Workflow',
      placeholder: 'Search workflows',
      onValueChange: (next: string) => {
        chosen = next;
      },
      options: [
        { value: 'release', label: 'Release notes', meta: '4 steps' },
        {
          value: 'triage',
          label: 'Triage inbox',
          description: 'Paused. Resume it to run it.',
          disabled: true,
        },
        {
          value: 'refund',
          label: 'Order refund',
          description: 'Can’t load · order-refund.json line 12: expected a comma',
          descriptionTone: 'danger',
          disabled: true,
        },
      ],
    });
    await fireEvent.focus(requiredInstance(document.body.querySelector('#run'), HTMLInputElement));
    await waitFor(() => expect(document.body.querySelectorAll('[role="option"]').length).toBe(3));

    const descriptions = Array.from(
      document.body.querySelectorAll('.cinder-combobox__option-description'),
    );
    expect(descriptions.map((element) => element.getAttribute('data-cinder-tone'))).toEqual([
      null,
      'danger',
    ]);
    const options = Array.from(document.body.querySelectorAll('[role="option"]'));
    await fireEvent.mouseDown(requiredInstance(options[2] ?? null, HTMLElement));
    expect(chosen).toBe('');
  });

  test('the footer is told what the person typed and how many options match, and is a stop of its own', async () => {
    const { container } = render(Fixture);
    const input = requiredInstance(container.querySelector('#event'), HTMLInputElement);
    expect(container.querySelector('.cinder-combobox__chevron')).not.toBeNull();
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'fail' } });

    await waitFor(() => {
      expect(document.body.querySelector('.cinder-combobox__footer')?.textContent).toContain(
        'Showing 2 of 3 events.',
      );
    });
    await fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() =>
      expect(
        document.activeElement === document.body.querySelector('.cinder-combobox__footer a'),
      ).toBe(true),
    );
  });

  test('a picker with a count shows "2 of 3" beside its search and groups with their counts', async () => {
    render(Fixture, { presentation: 'picker' });
    await fireEvent.click(
      requiredInstance(document.body.querySelector('#event'), HTMLButtonElement),
    );
    let search: HTMLInputElement | null = null;
    await waitFor(() => {
      search = document.body.querySelector<HTMLInputElement>('.cinder-combobox__search input');
      if (!search) throw new Error('not open');
    });
    await fireEvent.input(search!, { target: { value: 'fail' } });

    await waitFor(() => {
      expect(document.body.querySelector('.cinder-combobox__match-count')?.textContent).toBe(
        '2 of 3',
      );
    });
    const headings = Array.from(
      document.body.querySelectorAll('.cinder-_option-group__heading'),
    ).map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim());
    expect(headings).toEqual(['Runs 1', 'Goals 1']);
    expect(document.body.querySelector('.cinder-combobox__footer')?.textContent).toContain(
      'Showing 2 of 3 events.',
    );
  });
});

describe('Combobox loading and load error', () => {
  test('loading keeps the combobox, shows the loading label and does not open', async () => {
    const { container } = render(Combobox, {
      id: 'workflow',
      label: 'Workflow',
      required: true,
      options: [],
      loading: true,
      loadingLabel: 'Loading workflows…',
    });
    const input = requiredInstance(container.querySelector('#workflow'), HTMLInputElement);

    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('placeholder')).toBe('Loading workflows…');
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(input.readOnly).toBe(true);
    expect(container.querySelector('.cinder-combobox__chevron')).not.toBeNull();
    expect(container.querySelector('label[for="workflow"]')).not.toBeNull();
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.cinder-combobox__panel')).toBeNull();
  });

  test('a picker shows the loading label in its trigger', () => {
    render(Combobox, {
      ...pickerProps,
      options: [],
      loading: true,
      loadingLabel: 'Loading workflows…',
    });

    expect(trigger().textContent?.trim()).toBe('Loading workflows…');
    expect(trigger().getAttribute('aria-busy')).toBe('true');
  });

  test("Skeleton's still-loading status with Cancel appears under the field, not a banner", async () => {
    let cancelled = false;
    const { container } = render(Combobox, {
      id: 'workflow',
      label: 'Workflow',
      options: [],
      loading: true,
      stillLoadingAfter: 0,
      onCancel: () => {
        cancelled = true;
      },
    });

    const status = container.querySelector(
      '.cinder-combobox__still-loading .cinder-skeleton-status',
    );
    expect(status?.textContent).toContain('Still loading');
    expect(container.querySelector('[role="alert"], .cinder-banner')).toBeNull();
    const cancel = requiredInstance(status?.querySelector('button') ?? null, HTMLButtonElement);
    await fireEvent.click(cancel);
    expect(cancelled).toBe(true);
  });

  test('a load error shows above the options that did load, with a retry', async () => {
    let retried = 0;
    render(Combobox, {
      id: 'workflow',
      label: 'Workflow',
      required: true,
      placeholder: 'Pick a workflow',
      presentation: 'picker',
      options: [{ value: 'chat', label: 'Chat with an agent', meta: 'built in' }],
      loadError: {
        title: 'Couldn’t load workflows.',
        description: 'Interborough didn’t answer. Chat with an agent is built in and still works.',
      },
      onRetry: () => {
        retried += 1;
      },
    });
    await openPicker();

    const error = requiredInstance(
      document.body.querySelector('.cinder-combobox__load-error'),
      HTMLElement,
    );
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('Couldn’t load workflows.');
    expect(error.textContent).toContain('Chat with an agent is built in and still works.');
    // The built-in row stays listed and selectable below the message.
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain(
      'Chat with an agent',
    );
    const retry = requiredInstance(
      Array.from(error.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Try again'),
      ) ?? null,
      HTMLButtonElement,
    );
    await fireEvent.click(retry);
    expect(retried).toBe(1);
  });

  test('a load error with nothing listed shows the message and no "No results" line', async () => {
    const { container } = render(Combobox, {
      id: 'workflow',
      label: 'Workflow',
      options: [],
      loadError: { title: 'Couldn’t load workflows.' },
    });
    await fireEvent.focus(requiredInstance(container.querySelector('#workflow'), HTMLInputElement));

    await waitFor(() =>
      expect(document.body.querySelector('.cinder-combobox__load-error')).not.toBeNull(),
    );
    expect(document.body.querySelector('.cinder-combobox__empty')).toBeNull();
  });
});
