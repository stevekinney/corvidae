/**
 * COR-2226: a hook listens to a kind a plugin declares. Driven through the route outlet against a
 * stand-in Bureau and a stand-in host. The picker groups each plugin's kinds under its title after
 * the Bureau's areas (rows R1, R2); a chosen kind reads with its plugin's title and its raw kind with
 * the version it will be pinned to (R3, R4); a saved hook whose kind is missing says so in its When
 * step, with "Missing" and one cause line (R5), and on line two of its list row (R6).
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { chooseFilterOption } from '../../../tests/dom.test-support.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import { installBureauStub, type BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';
import {
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from '../settings/plugins/plugins-host.test-support.ts';
import { HOOKS_COPY } from './hook-copy.ts';

let stub: BureauStub | undefined;
let host: FakePluginHost | undefined;
afterEach(() => {
  cleanup();
  host?.restore();
  stub?.restore();
  host = undefined;
  stub = undefined;
});

const CORE = ['review.requested', 'run.settled'].map((kind) => ({
  kind,
  origin: 'run',
  scopes: [],
  description: `Describes ${kind}`,
  payload: [],
}));

const declared = (plugin: string, name: string, version: string) => ({
  kind: `${plugin}:${name}`,
  origin: 'unattributed',
  scopes: [],
  description: `${plugin} says ${name}`,
  payload: [],
  source: plugin,
  version,
});

const CATALOG = [
  ...CORE,
  declared('reports', 'digest-ready', '1.0.0'),
  declared('reports', 'summary-sent', '1.0.0'),
  declared('archive', 'digest-ready', '2.0.0'),
];

const PLUGINS: PluginFixture[] = [
  { name: 'reports', title: 'Weekly reports' },
  { name: 'archive', title: 'Archive' },
];

const SAVED = {
  id: 'digest',
  owner: 'anonymous:local',
  name: 'Digest',
  action: { type: 'notify', title: null },
  events: ['reports:digest-ready@1.0.0', 'review.requested'],
  scope: null,
  declaredBy: null,
  enabled: true,
  createdAt: 1_000,
  updatedAt: 1_000,
  revision: 1,
};

type Problems = readonly Record<string, unknown>[];

function open(path: string, problems: Problems = []) {
  stub = installBureauStub({
    'bureau.hooks.list': () => ({ hooks: [{ ...SAVED, lastDelivery: null, problems }] }),
    'bureau.hooks.get': () => SAVED,
    'bureau.hooks.deliveries': () => ({ deliveries: [] }),
    'bureau.hooks.create': (params) => ({ ...SAVED, id: 'created', ...params }),
    'bureau.events.catalog': () => ({ events: CATALOG }),
    'bureau.plugins.contributions': () => ({ providers: [], triggers: [], reactions: [] }),
  });
  host = installFakePluginHost(PLUGINS);
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

/** The picker's groups once it is open, each heading with the labels and codes of its options. */
async function openPicker(view: ReturnType<typeof open>) {
  const input = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
  await fireEvent.focus(input);
  return waitFor(() => {
    const groups = [...document.body.querySelectorAll<HTMLElement>('.cinder-_option-group')].map(
      (group) => ({
        heading: group.querySelector('.cinder-_option-group__label')?.textContent?.trim(),
        options: [...group.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => ({
          label: option.querySelector('.cinder-combobox__option-label')?.textContent?.trim(),
          code: option.querySelector('.cinder-combobox__option-code')?.textContent?.trim(),
        })),
      }),
    );
    // The plugins' titles are read from the host; until then a plugin is its name in words.
    if (!groups.some((group) => group.heading === 'Weekly reports')) {
      throw new Error('the plugin groups are not drawn under their titles yet');
    }
    return groups;
  });
}

describe('the event picker (COR-2226, rows R1, R2, R7)', () => {
  test('groups each plugin’s kinds under its title after the Bureau’s areas, the plugins in title order (AC7)', async () => {
    const view = open('/hooks/new');
    const groups = await openPicker(view);
    const headings = groups.map((group) => group.heading);
    expect(headings.slice(-2)).toEqual(['Archive', 'Weekly reports']);
    expect(headings.slice(0, -2)).not.toContain('Weekly reports');
    expect(headings).not.toContain(HOOKS_COPY.editor.event.areaOther);
    expect(groups.at(-1)?.options).toEqual([
      { label: 'Digest ready', code: 'reports:digest-ready' },
      { label: 'Summary sent', code: 'reports:summary-sent' },
    ]);
    // Two plugins' kinds of one name are both offered, told apart by their groups.
    expect(groups.at(-2)?.options).toEqual([
      { label: 'Digest ready', code: 'archive:digest-ready' },
    ]);
  });

  test('finds a plugin’s kinds by its title (R8)', async () => {
    const view = open('/hooks/new');
    const input = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
    await openPicker(view);
    await fireEvent.input(input, { target: { value: 'weekly' } });
    await waitFor(() => {
      const codes = [
        ...document.body.querySelectorAll<HTMLElement>(
          '[role="option"] .cinder-combobox__option-code',
        ),
      ].map((code) => code.textContent?.trim());
      expect(codes).toEqual(['reports:digest-ready', 'reports:summary-sent']);
    });
  });

  test('lists a chosen kind with its plugin’s title and the version it pins, and creates the hook with the kind (R3, R4)', async () => {
    const view = open('/hooks/new');
    await openPicker(view);
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (element) =>
        element.querySelector('.cinder-combobox__option-code')?.textContent?.trim() ===
        'reports:digest-ready',
    );
    expect(option).toBeDefined();
    await fireEvent.mouseDown(option!);
    const item = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        '.ib-hook-events__item[data-event="reports:digest-ready"]',
      );
      if (found === null) throw new Error('the kind is not chosen');
      return found;
    });
    expect(item.querySelector('.ib-hook-events__name')?.textContent).toBe(
      'Weekly reports: digest ready',
    );
    expect(item.querySelector('.ib-hook-events__kind')?.textContent).toBe(
      'reports:digest-ready@1.0.0',
    );
    expect(item.querySelector('.ib-hook-events__version')?.textContent).toBe('@1.0.0');
    // One Cinder row (B5): the name is its title, the raw kind its line two, and Remove an icon
    // button named for the event in the row's trailing region, at its end edge.
    expect(item.classList.contains('cinder-stacked-list-item')).toBe(true);
    expect(
      item.querySelector('.cinder-stacked-list-item__title .ib-hook-events__name'),
    ).not.toBeNull();
    expect(
      item.querySelector('.cinder-stacked-list-item__description .ib-hook-events__kind'),
    ).not.toBeNull();
    const remove = within(item).getByRole('button', {
      name: HOOKS_COPY.editor.event.remove('Weekly reports: digest ready'),
    });
    expect(remove.closest('.cinder-stacked-list-item__trailing')).not.toBeNull();
    expect(remove.textContent?.trim()).toBe('');

    // Another plugin's kind of the same name, chosen too: the Check line joins two events, each
    // named with its plugin's title first, so a comma falls only between them (B2, row R10).
    const input = view.getByRole('combobox', { name: HOOKS_COPY.editor.event.label });
    await fireEvent.click(input);
    const archive = await waitFor(() => {
      const found = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (element) =>
          element.querySelector('.cinder-combobox__option-code')?.textContent?.trim() ===
          'archive:digest-ready',
      );
      if (found === undefined) throw new Error('the list did not open again on a click');
      return found;
    });
    await fireEvent.mouseDown(archive);
    await waitFor(() =>
      expect(view.getByTestId('hook-check-events').textContent).toBe(
        'Weekly reports: digest ready, Archive: digest ready',
      ),
    );
    await fireEvent.click(
      within(
        view.container.querySelector<HTMLElement>(
          '.ib-hook-events__item[data-event="archive:digest-ready"]',
        )!,
      ).getByRole('button'),
    );

    // The Bureau pins the kind as it writes the hook, so the page sends it as the catalog names it.
    await fireEvent.click(
      await view.findByRole('radio', { name: HOOKS_COPY.editor.action.notify }),
    );
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.create').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.create')[0]?.params).toMatchObject({
      events: ['reports:digest-ready'],
      action: { type: 'notify' },
    });
  });
});

describe('a saved hook whose plugin kind is missing (COR-2226, rows R4, R5, R6)', () => {
  test('says the kind, Missing and that its plugin is not loaded in the When step, and shows the pin muted on the locked row', async () => {
    const view = open('/hooks/digest', [
      { code: 'event-missing', kind: 'reports:digest-ready@1.0.0', loadedVersion: null },
    ]);
    const missing = await view.findByTestId('hook-missing-events');
    const item = within(missing).getByRole('listitem');
    await waitFor(() => expect(item.textContent).toContain('Weekly reports: digest ready'));
    expect(item.textContent).toContain('Missing');
    expect(item.textContent).toContain('Plugin not loaded');
    const locked = await view.findByTestId('hook-event-locked');
    expect(locked.querySelector('.ib-hook-events__kind')?.textContent).toBe(
      'reports:digest-ready@1.0.0',
    );
    expect(locked.querySelector('.ib-hook-events__version')?.textContent).toBe('@1.0.0');
  });

  test('names the plugin by its title in the header, the locked row’s one line and the title, never by its namespace (B1, B2)', async () => {
    const view = open('/hooks/digest');
    const locked = await view.findByTestId('hook-event-locked');
    // Two events read as two: the plugin's title leads its kind, and a comma falls between events.
    await waitFor(() =>
      expect(locked.textContent).toContain('Weekly reports: digest ready, A review is waiting'),
    );
    expect(view.container.textContent).not.toContain('Reports: digest ready');
    expect(view.container.textContent).not.toContain('Digest ready, Weekly reports');
  });

  test('on a phone says Missing directly under the When summary, before Edit (N1)', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        media: query,
        matches: query.includes('640'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
    try {
      const view = open('/hooks/digest', [
        { code: 'event-missing', kind: 'reports:digest-ready@1.0.0', loadedVersion: null },
      ]);
      const when = await view.findByTestId('hook-step-summary-when');
      const missing = await waitFor(() => {
        const found = within(when).getByTestId('hook-missing-events');
        expect(found.textContent).toContain('Weekly reports: digest ready');
        return found;
      });
      const edit = within(when).getByRole('button', { name: HOOKS_COPY.editor.steps.edit });
      const summary = when.querySelector('.ib-hook-step__summary-line');
      expect(summary?.textContent).toContain('Weekly reports: digest ready');
      // In reading order: the summary, then Missing with its cause, then Edit.
      expect(
        summary!.compareDocumentPosition(missing) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(missing.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Said once on the page while the step is folded.
      expect(view.getAllByTestId('hook-missing-events')).toHaveLength(1);
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, 'matchMedia');
      else Object.defineProperty(window, 'matchMedia', original);
    }
  });

  test('names the version that is loaded when it is not the one pinned', async () => {
    const view = open('/hooks/digest', [
      { code: 'event-missing', kind: 'reports:digest-ready@1.0.0', loadedVersion: '1.1.0' },
    ]);
    const missing = await view.findByTestId('hook-missing-events');
    expect(missing.textContent).toContain('Pinned to 1.0.0, 1.1.0 is loaded');
  });

  test('draws nothing more for a hook whose kinds all fire', async () => {
    const view = open('/hooks/digest');
    await view.findByTestId('hook-event-locked');
    expect(view.queryByTestId('hook-missing-events')).toBeNull();
  });

  test('says it on line two of the list row, and adds nothing to line one (R6)', async () => {
    const view = open('/hooks', [
      { code: 'event-missing', kind: 'reports:digest-ready@1.0.0', loadedVersion: null },
    ]);
    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('li[data-hook="digest"]');
      if (found === null) throw new Error('the row is not drawn');
      return found;
    });
    // The row names the plugin by its title, once the host has said it.
    await waitFor(() =>
      expect(row.querySelector('.ib-hooks__line')?.textContent).toBe(
        'Plugin not loaded, when Weekly reports: digest ready or a review is waiting, notify me',
      ),
    );
    expect(row.textContent).not.toContain('Missing');
  });
});

describe('the list of hooks names a plugin by its title (COR-2226, rows R3, R10)', () => {
  test('offers the plugin’s kind in the event filter by its title, and filters by it', async () => {
    const view = open('/hooks');
    await waitFor(() =>
      expect(view.container.querySelector('li[data-hook="digest"]')?.textContent).toContain(
        'Weekly reports: digest ready',
      ),
    );
    await chooseFilterOption(view, HOOKS_COPY.eventFilter, 'Weekly reports: digest ready');
    await waitFor(() =>
      expect(view.container.querySelector('li[data-hook="digest"]')).not.toBeNull(),
    );
  });

  test('finds a hook by its plugin’s title in the search', async () => {
    const view = open('/hooks');
    await waitFor(() =>
      expect(view.container.querySelector('li[data-hook="digest"]')?.textContent).toContain(
        'Weekly reports',
      ),
    );
    await fireEvent.input(view.getByRole('searchbox', { name: HOOKS_COPY.searchLabel }), {
      target: { value: 'weekly' },
    });
    await waitFor(() =>
      expect(view.container.querySelector('li[data-hook="digest"]')).not.toBeNull(),
    );
  });
});
