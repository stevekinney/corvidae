/**
 * `/settings` (COR-1711): the page draws one control for every key of the schema the Bureau
 * publishes, sends the keys a person changed in one update against the revision it read, and says
 * so when that revision is stale. The Bureau is a stub that answers as the real one does
 * (`settings-fixtures.test-support.ts`); the real one is exercised by the Playwright suite.
 */
import { SETTING_KEYS } from '@lostgradient/bureau';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { SETTINGS_COPY, VIEW_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  catalogFixture,
  STUB_REMOTE_AGENT_DIRECTORY,
  STUB_REMOTE_CONFIGURATION_FILE,
  STUB_REMOTE_PROVIDERS,
  STUB_REMOTE_WORKFLOW_DIRECTORY,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import { landAt } from '../chat/pages.test-support.ts';
import {
  installSettingsBureau,
  servedSettings,
  settingsSnapshot,
  settingsStream,
  type SettingsServed,
  type SettingsStream,
} from './settings-fixtures.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(
  served: SettingsServed,
  stream?: SettingsStream,
  extra: Record<string, (params: Record<string, unknown>) => unknown> = {},
  hostMode?: 'local' | 'remote',
) {
  stub = installSettingsBureau(served, extra, stream, hostMode);
  landAt('/settings');
  const view = render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
  return view;
}

const row = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-setting="${key}"]`);

/** The controls a person works in a row: a switch, a field, a select, or an editor. */
const CONTROLS = 'button[role="switch"], input, select, textarea, button';

const updates = () => stub?.callsTo('bureau.settings.update') ?? [];

describe('the page', () => {
  test('draws one control for every key of the schema, and none of them unsupported', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    const rows = [...container.querySelectorAll<HTMLElement>('[data-setting]')];
    // The model policy has a section of its own, the decisions are on the Models page, and the A2A settings are on the A2A page.
    expect(rows.map((entry) => entry.dataset['setting'])).toEqual(
      SETTING_KEYS.filter(
        (key) => key !== 'modelPolicy' && !key.startsWith('decisions.') && !key.startsWith('a2a.'),
      ),
    );
    for (const entry of rows) {
      expect(entry.querySelector(CONTROLS), entry.dataset['setting']).not.toBeNull();
    }
    expect(container.textContent?.toLowerCase()).not.toContain('unsupported');
  });

  test('groups the keys by their first segment, with the keys that fix the deployment under Durability', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    const headings = [...container.querySelectorAll('h2')].map((heading) =>
      heading.textContent?.trim(),
    );
    expect(headings).toEqual([
      'Tools',
      'Context',
      'Retention',
      'Memory',
      'Logs',
      'Session input',
      'Children',
      'Workflows',
      'Durability',
      SETTINGS_COPY.hostPaths.title,
    ]);
    const durability = container.querySelector(
      '[aria-labelledby="weft-settings-group-durability"]',
    );
    expect(
      [...(durability?.querySelectorAll('[data-setting]') ?? [])].map(
        (entry) => (entry as HTMLElement).dataset['setting'],
      ),
    ).toEqual(['durable', 'maintenance', 'durableOwnership.ownership', 'workflowVersion']);
  });

  test('says how each key applies, and that the deployment locked one', async () => {
    const { container, findByRole } = open(
      servedSettings({ locked: new Set(['workflowVersion']) }),
    );
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    // Only a setting that needs a restart says how it applies.
    expect(row(container, 'tools.wakeup')?.textContent).not.toContain('Applies live');
    expect(row(container, 'durable')?.textContent).toContain(SETTINGS_COPY.apply.restart);
    const locked = row(container, 'workflowVersion');
    expect(locked?.dataset['locked']).toBe('true');
    expect(locked?.textContent).toContain(SETTINGS_COPY.locked);
    expect(locked?.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(row(container, 'tools.wakeup')?.dataset['locked']).toBe('false');
  });

  test('says why a locked key is locked, by the reason the Bureau reports', async () => {
    const { container, findByRole } = open(
      servedSettings({
        locked: new Set(['workflowVersion', 'maintenance']),
        lockReasons: { maintenance: 'shared-storage' },
      }),
    );
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    expect(row(container, 'workflowVersion')?.textContent).toContain(
      SETTINGS_COPY.lockedNote.deployment,
    );
    expect(row(container, 'maintenance')?.textContent).toContain(
      SETTINGS_COPY.lockedNote['shared-storage'],
    );
    expect(row(container, 'maintenance')?.textContent).not.toContain(
      SETTINGS_COPY.lockedNote.deployment,
    );
  });

  test('shows the host’s paths, read-only', async () => {
    const { findByText, container } = open(servedSettings());
    await findByText('/home/tester/.interborough/agents');
    expect(container.querySelector('.weft-settings__path-list')?.textContent).toContain(
      '/home/tester/.interborough/configuration.json',
    );
  });

  test('says a Bureau that keeps nothing does not keep the settings', async () => {
    const { findByTestId } = open(servedSettings({ persisted: false }));
    expect(await findByTestId('settings-not-persisted')).not.toBeNull();
  });
});

describe('a save', () => {
  test('sends only the keys that changed, in one update, against the revision the page read', async () => {
    const { container, findByRole } = open(servedSettings({ revision: 7 }));
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const save = within(form).getByRole('button', { name: SETTINGS_COPY.saveAction });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    await fireEvent.click(
      row(container, 'tools.decide')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('true');
    expect(row(container, 'tools.humanInput')?.dataset['dirty']).toBe('false');
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(save);

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: { 'tools.wakeup': false, 'tools.decide': false },
      expectedRevision: 7,
    });
    await within(container).findByText(SETTINGS_COPY.saved.title);
    // The form starts over from what the Bureau now holds: nothing is dirty, and the next save names the new revision.
    await waitFor(() => expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('false'));
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test('sums up the keys that wait for a restart, before the save and after it', async () => {
    const { container, findByRole, findByTestId } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    expect(container.querySelector('[data-testid="settings-restart-summary"]')).toBeNull();
    await fireEvent.click(
      row(container, 'durable')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    const summary = await findByTestId('settings-restart-summary');
    expect(summary.textContent).toContain(SETTINGS_COPY.restartSummary(['durable']));
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    await waitFor(() => expect(updates()).toHaveLength(1));
    await waitFor(() => expect(row(container, 'durable')?.dataset['dirty']).toBe('false'));
    // The Bureau now holds a value that waits, so the summary stays and the row says so.
    expect(
      container.querySelector('[data-testid="settings-restart-summary"]')?.textContent,
    ).toContain(SETTINGS_COPY.restartSummary(['durable']));
    expect(row(container, 'durable')?.textContent).toContain(SETTINGS_COPY.pendingRestart);
  });

  test('turns the human-input switch off to false and back on to the editor of its options', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const toggle = () =>
      row(container, 'tools.humanInput')?.querySelector('button[role="switch"]') as HTMLElement;
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    // The options hold answer schemas, which are free-form JSON: one editor, no empty form and no
    // `false` or `Object` choice.
    expect(row(container, 'tools.humanInput')?.querySelector('form')).toBeNull();
    expect(row(container, 'tools.humanInput')?.querySelector('textarea')).not.toBeNull();

    await fireEvent.click(toggle());
    expect(row(container, 'tools.humanInput')?.querySelector('textarea')).toBeNull();
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'tools.humanInput': false });
    // The form starts over from the settings it reads back, and then its controls work again.
    await waitFor(() => expect(row(container, 'tools.humanInput')?.dataset['dirty']).toBe('false'));
    await waitFor(() => expect(toggle().closest('fieldset')?.disabled).toBe(false));
    expect(toggle().getAttribute('aria-checked')).toBe('false');

    await fireEvent.click(toggle());
    await waitFor(() =>
      expect(row(container, 'tools.humanInput')?.querySelector('textarea')).not.toBeNull(),
    );
    const save = within(form).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()[1]?.params['patch']).toEqual({ 'tools.humanInput': {} });
  });

  test('edits an object through its form, with no JSON, and sends the value it checked', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const receipts = row(container, 'retention.receipts');
    expect(receipts?.querySelector('textarea')).toBeNull();
    // Only a value with no fields of its own is free-form: the answer schemas of `tools.humanInput`.
    expect(
      [...container.querySelectorAll('[data-setting] textarea')].map(
        (area) => area.closest<HTMLElement>('[data-setting]')?.dataset['setting'],
      ),
    ).toEqual(['tools.humanInput']);
    // The form's own submit button is not drawn; the page has one Save.
    const field = receipts?.querySelector('input') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: '5' } });
    await fireEvent.blur(field);

    const save = within(form).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(updates()).toHaveLength(1));
    // The form shows a week as hours, and keeps the value in milliseconds.
    expect(updates()[0]?.params['patch']).toEqual({
      'retention.receipts': { olderThan: 5 * 3_600_000 },
    });
  });

  test('sends only the fields a form holds, with no sibling it left empty', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    // `engine.history` has two optional numbers and the fixture holds one of them.
    const history = row(container, 'engine.history');
    const fields = [...(history?.querySelectorAll('input') ?? [])];
    expect(fields.length).toBeGreaterThan(1);
    const first = fields[0] as HTMLInputElement;
    await fireEvent.input(first, { target: { value: '5000' } });
    await fireEvent.blur(first);

    const save = within(form).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'engine.history': { maxEvents: 5000 } });
  });

  test('will not send a form’s value that its schema refuses', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const field = row(container, 'retention.receipts')?.querySelector('input') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: '-5' } });
    await fireEvent.blur(field);

    const save = within(form).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    await waitFor(() =>
      expect(row(container, 'retention.receipts')?.querySelector('[role="alert"]')).not.toBeNull(),
    );
    expect(save.disabled).toBe(true);
    expect(updates()).toHaveLength(0);
  });

  test('draws an unset value as Not set, with no error, and reveals its form on request', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    // `retention.logs` and `context.summarizerModel` have no value in the fixture.
    const logs = row(container, 'retention.logs');
    expect(logs?.textContent).toContain(SETTINGS_COPY.notSet);
    expect(logs?.querySelector('input')).toBeNull();
    expect(logs?.querySelector('[role="alert"]')).toBeNull();
    expect(logs?.textContent).not.toContain('Enter valid JSON');
    expect(row(container, 'context.summarizerModel')?.textContent).toContain(SETTINGS_COPY.notSet);

    await fireEvent.click(
      within(logs as HTMLElement).getByRole('button', { name: SETTINGS_COPY.setAction }),
    );
    expect(logs?.querySelector('input')).not.toBeNull();
    // Looking at the fields is not a change.
    expect(logs?.dataset['dirty']).toBe('false');
  });

  test('draws a description as inline Markdown, a code span as code', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const wakeup = row(container, 'tools.wakeup');
    expect(wakeup?.querySelector('code')?.textContent).toBe('scheduleWakeup');
    expect(wakeup?.textContent).not.toContain('`');
  });

  test('offers the catalog’s rows for the models a setting names, never a typed name', async () => {
    const { container, findByRole } = open(servedSettings(), undefined, {
      'bureau.agents.catalog': () =>
        catalogFixture({
          models: [
            { provider: 'anthropic', model: 'claude-haiku-5-5' },
            { provider: 'openai', model: 'gpt-5' },
          ],
          tools: [],
        }),
    });
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const select = row(container, 'context.summarizerModel')?.querySelector(
      'select',
    ) as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((option) => option.value)).toEqual([
        '',
        'anthropic/claude-haiku-5-5',
        'openai/gpt-5',
      ]),
    );
    expect(row(container, 'context.summarizerModel')?.querySelector('input')).toBeNull();

    await fireEvent.change(select, { target: { value: 'openai/gpt-5' } });
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'context.summarizerModel': 'openai/gpt-5' });
  });

  test('keeps the model a setting holds in its choices when the catalog does not list it', async () => {
    const served = servedSettings();
    served.values = { ...served.values, 'context.summarizerModel': 'anthropic/claude-haiku-5-5' };
    const { container, findByRole } = open(served);
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const select = row(container, 'context.summarizerModel')?.querySelector(
      'select',
    ) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toContain(
      'anthropic/claude-haiku-5-5',
    );
  });

  test('saves on ⌘Enter, the same save the button makes', async () => {
    const { container, findByRole } = open(servedSettings({ revision: 9 }));
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    expect(
      shortcuts.handleKey(
        { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
        { routePattern: '/settings', regions: [] },
        0,
      ),
    ).toBe(true);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: { 'tools.wakeup': false },
      expectedRevision: 9,
    });
  });

  test('marks the save as a change, so an offline page can hold it', async () => {
    const { findByRole } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    expect(
      within(form)
        .getByRole('button', { name: SETTINGS_COPY.saveAction })
        .hasAttribute('data-changes'),
    ).toBe(true);
  });

  test('sends nothing for a key the deployment locked, and says which key the Bureau refused', async () => {
    const served = servedSettings({ locked: new Set(['tools.wakeup']) });
    const { container, findByRole } = open(served);
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const wakeup = row(container, 'tools.wakeup')?.querySelector(
      'button[role="switch"]',
    ) as HTMLButtonElement;
    expect(wakeup.disabled).toBe(true);
    await fireEvent.click(wakeup);
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('false');
  });

  test('says a refusal the Bureau gave for a value, and changes nothing on the page', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    stub?.on('bureau.settings.update', () => {
      throw new StubFault('InvalidParams', 400, 'invalid params', {
        issues: [{ path: ['patch', 'tools.wakeup'], message: 'Expected a boolean.' }],
      });
    });
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    await within(container).findByText(SETTINGS_COPY.saveFailed);
    // The edit is kept, so the person can fix it.
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('true');
  });
});

describe('a refused save', () => {
  test('says when the caller may read the settings but not change them', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    stub?.on('bureau.settings.update', () => {
      throw new StubFault('Forbidden', 403, 'Requires bureau.settings:write.');
    });
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    await within(container).findByText(SETTINGS_COPY.forbidden);
  });

  test('says which key the deployment locked when the Bureau refuses it', async () => {
    const served = servedSettings();
    const { container, findByRole } = open(served);
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    // The deployment locks the key after the page read the settings.
    served.locked = new Set(['tools.wakeup']);
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    await within(container).findByText('Locked: tools.wakeup.');
    expect(served.values['tools.wakeup']).toBe(true);
  });
});

describe('a StaleRevision', () => {
  test('is answered with a prompt to reload, and nothing was saved', async () => {
    const served = servedSettings({ revision: 3 });
    const { container, findByRole, findByTestId } = open(served);
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    // Someone else changes the settings after the page read them.
    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    const prompt = await findByTestId('settings-reload-prompt');
    expect(prompt.textContent).toContain(SETTINGS_COPY.stale.title);
    expect(prompt.textContent).toContain(SETTINGS_COPY.stale.description);
    // Nothing was written: the Bureau still holds what the other change left.
    expect(served.values['tools.wakeup']).toBe(true);

    await fireEvent.click(within(prompt).getByRole('button', { name: SETTINGS_COPY.reloadAction }));
    await waitFor(() =>
      expect(
        row(container, 'tools.decide')
          ?.querySelector('button[role="switch"]')
          ?.getAttribute('aria-checked'),
      ).toBe('false'),
    );
    // The reload discards the edit and takes the Bureau’s settings, and the prompt goes.
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('false');
    expect(container.querySelector('[data-testid="settings-reload-prompt"]')).toBeNull();
  });

  test('is told, without a save, when the settings change under an edit', async () => {
    const served = servedSettings({ revision: 3 });
    const { container, findByRole, findByTestId } = open(served);
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );

    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    // The page reads the settings again when the window regains focus.
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    const prompt = await findByTestId('settings-reload-prompt');
    expect(prompt.textContent).toContain(SETTINGS_COPY.changedElsewhere.title);
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('true');
  });
});

describe('a page that follows the Bureau', () => {
  test('keeps its edits when a read fails, and says the settings may be out of date', async () => {
    const { container, findByRole, findByTestId } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );

    stub?.on('bureau.settings.get', () => {
      throw new StubFault('Internal', 500, 'Broke.');
    });
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await findByTestId('settings-refresh-failed');
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('true');
    expect(container.textContent).not.toContain(VIEW_COPY.settings.error.title);
  });

  test('takes in a change made elsewhere when the edits are discarded', async () => {
    const served = servedSettings({ revision: 3 });
    const { container, findByRole, findByTestId } = open(served);
    const form = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );

    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await findByTestId('settings-reload-prompt');
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.discardAction }));

    expect(container.querySelector('[data-testid="settings-reload-prompt"]')).toBeNull();
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('false');
    expect(
      row(container, 'tools.decide')
        ?.querySelector('button[role="switch"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false');
    // The next save names the revision the form took in.
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['expectedRevision']).toBe(4);
  });
});

describe('a page that follows the settings stream', () => {
  const reads = () => stub?.callsTo('bureau.settings.get').length ?? 0;

  test('reads the settings again on each event, without a focus change', async () => {
    const served = servedSettings({ revision: 3 });
    const stream = settingsStream();
    const { container, findByRole, findByTestId } = open(served, stream);
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await waitFor(() => expect(stream.opened).toEqual([undefined]));
    await fireEvent.click(
      row(container, 'tools.wakeup')?.querySelector('button[role="switch"]') as HTMLElement,
    );

    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    stream.push(4, ['tools.decide']);

    const prompt = await findByTestId('settings-reload-prompt');
    expect(prompt.textContent).toContain(SETTINGS_COPY.changedElsewhere.title);
  });

  test('resumes from the last revision it was given when the Bureau ends the stream', async () => {
    const stream = settingsStream();
    const { findByRole } = open(servedSettings({ revision: 3 }), stream);
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await waitFor(() => expect(stream.opened).toHaveLength(1));
    stream.push(4, ['tools.decide']);
    stream.end();

    // The reconnect waits out the shared backoff, or the browser coming back online.
    await waitFor(() => {
      window.dispatchEvent(new window.Event('online'));
      expect(stream.opened).toEqual([undefined, '4']);
    });
  });

  test('reads again when an event arrives while the page’s first read is in flight', async () => {
    const served = servedSettings({ revision: 3 });
    const stream = settingsStream();
    let releaseFirstRead: () => void = () => undefined;
    const firstReadHeld = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let started = 0;
    const { container, findByRole } = open(served, stream, {
      'bureau.settings.get': async () => {
        started += 1;
        // The view frame's probe is the first read. The page's own first read is the second: it
        // captures revision 3, then waits, and the Bureau moves on while it is out.
        const answer = settingsSnapshot(served);
        if (started === 2) await firstReadHeld;
        return answer;
      },
    });
    await waitFor(() => expect(stream.opened).toHaveLength(1));
    await waitFor(() => expect(started).toBe(2));

    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    stream.push(4, ['tools.decide']);
    // The event reaches the page while the first read is still held.
    await waitUntil(() => stream.drained());
    releaseFirstRead();

    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await waitFor(() =>
      expect(
        row(container, 'tools.decide')
          ?.querySelector('button[role="switch"]')
          ?.getAttribute('aria-checked'),
      ).toBe('false'),
    );
    expect(started).toBeGreaterThanOrEqual(3);
  });

  test('keeps working, reading on focus, when the Bureau refuses the stream', async () => {
    const served = servedSettings({ revision: 3 });
    const { findByRole } = open(served);
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const before = reads();
    served.revision = 4;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});

describe.each(['local', 'remote'] as const)(
  'where the host keeps its state, on a %s host',
  (mode) => {
    test('names each place in the words of its mode, and shows the host’s locations verbatim', async () => {
      const { container, findByRole } = open(servedSettings(), undefined, {}, mode);
      await findByRole('group', { name: SETTINGS_COPY.formLabel });

      const words = mode === 'remote' ? SETTINGS_COPY.remote.hostPaths : SETTINGS_COPY.hostPaths;
      const otherWords =
        mode === 'remote' ? SETTINGS_COPY.hostPaths : SETTINGS_COPY.remote.hostPaths;
      const section = container.querySelector<HTMLElement>('.weft-settings__paths');
      await waitFor(() => expect(section?.querySelector('dl')).not.toBeNull());

      expect(section?.querySelector('h2')?.textContent?.trim()).toBe(words.title);
      expect([...(section?.querySelectorAll('dt') ?? [])].map((term) => term.textContent)).toEqual([
        words.agents,
        words.workflows,
        words.configuration,
        words.providers,
      ]);
      const text = section?.textContent ?? '';
      expect(text).not.toContain(otherWords.title);
      expect(text).not.toContain(otherWords.providers);
      if (mode === 'remote') {
        for (const location of [
          STUB_REMOTE_AGENT_DIRECTORY,
          STUB_REMOTE_WORKFLOW_DIRECTORY,
          STUB_REMOTE_CONFIGURATION_FILE,
          ...STUB_REMOTE_PROVIDERS.map((provider) => provider.secretFile),
        ]) {
          expect(text).toContain(location);
        }
      } else {
        expect(text).not.toContain('s3://');
      }
    });
  },
);
