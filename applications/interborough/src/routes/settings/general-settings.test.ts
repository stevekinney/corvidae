/**
 * Settings › General (board SettingsShell, "General, /settings"): four sections of Cinder setting
 * rows, each saved as it is left and saying so on its own row, the sticky banner that counts saved
 * changes waiting for a restart, the locked settings of a remote deployment, and the preferences
 * of this browser. The Bureau is a stub that answers as the real one does
 * (`settings-fixtures.test-support.ts`); the real one is exercised by the Playwright suite.
 */
import { pressDelete, selectAsChromium } from '@lostgradient/testing/text-control';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { SETTINGS_COPY } from '../../app/copy/settings.ts';
import { KeyboardPreferences } from '../../app/keyboard-preferences.svelte.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  STUB_REMOTE_AGENT_DIRECTORY,
  STUB_REMOTE_CONFIGURATION_FILE,
  STUB_REMOTE_PROVIDERS,
  STUB_REMOTE_WORKFLOW_DIRECTORY,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  forbiddenVisibleText,
  PATH_ALLOWED_SELECTOR,
  visibleTextOutsideCopyControls,
} from '../../lib/visible-text-rules.ts';
import { landAt } from '../chat/pages.test-support.ts';
import {
  installSettingsBureau,
  PUBLISHED_SCHEMA,
  servedSettings,
  settingsSnapshot,
  settingsStream,
  type SettingsServed,
  type SettingsStream,
} from './settings-fixtures.test-support.ts';

let stub: BureauStub | undefined;
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(
  served: SettingsServed,
  options: {
    stream?: SettingsStream;
    extra?: Record<string, (params: Record<string, unknown>) => unknown>;
    hostMode?: 'local' | 'remote';
    keyboard?: KeyboardPreferences;
  } = {},
) {
  stub = installSettingsBureau(served, options.extra ?? {}, options.stream, options.hostMode);
  landAt('/settings');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
      ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
    },
  } as never);
}

const row = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-setting="${key}"]`);

const toggleOf = (container: HTMLElement, key: string) =>
  row(container, key)?.querySelector('button[role="switch"]') as HTMLElement;

const fieldOf = (container: HTMLElement, key: string) =>
  row(container, key)?.querySelector('input') as HTMLInputElement;

const updates = () => stub?.callsTo('bureau.settings.update') ?? [];

async function openAdvanced(container: HTMLElement): Promise<void> {
  const disclosure = within(container).getByRole('button', { name: 'Advanced' });
  await fireEvent.click(disclosure);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
}

/** The text of a row's status line. */
const statusOf = (container: HTMLElement, key: string) =>
  row(container, key)?.querySelector('.cinder-setting-row__status')?.textContent?.trim() ?? '';

/** Types a value into a row's number field and leaves it. */
async function typeAndLeave(container: HTMLElement, key: string, value: string): Promise<void> {
  const field = fieldOf(container, key);
  field.focus();
  await fireEvent.input(field, { target: { value } });
  await fireEvent.change(field, { target: { value } });
  await fireEvent.blur(field);
  await fireEvent.focusOut(field);
}

const READY = { name: SETTINGS_COPY.formLabel };

describe('the page', () => {
  test('is titled General, with the sentence that says settings save as you leave a field', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('General');
    expect(view.container.textContent).toContain(SETTINGS_COPY.general.intro);
    expect(
      within(view.container).getByRole('navigation', { name: 'Settings sections' }),
    ).not.toBeNull();
  });

  test('draws Tools, Runs, Memory, Storage and Your preferences, and never an Engine heading', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    const headings = [...view.container.querySelectorAll('h2')].map((heading) =>
      heading.textContent?.trim(),
    );
    expect(headings.slice(0, 5)).toEqual([
      'Tools',
      'Runs',
      'Memory',
      'Storage',
      'Your preferences',
    ]);
    expect(headings.join('|')).not.toMatch(/engine/i);
    expect(view.container.textContent).toContain(SETTINGS_COPY.general.sections.runs.description);
    expect(view.container.textContent).toContain(
      SETTINGS_COPY.general.sections.preferences.description,
    );
  });

  test('keeps ordinary settings visible and reveals the advanced rows only from its disclosure', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    const keysIn = (heading: string) => {
      const section = [...view.container.querySelectorAll('.cinder-form-section')].find(
        (candidate) => candidate.querySelector('h2')?.textContent?.trim() === heading,
      );
      return [...(section?.querySelectorAll('[data-setting]') ?? [])].map((found) =>
        found.getAttribute('data-setting'),
      );
    };
    // Tools holds the two rows the board draws; Decide, which it does not draw, is in Advanced.
    expect(keysIn('Tools')).toEqual(['tools.humanInput', 'tools.wakeup']);
    const runs = keysIn('Runs');
    expect(runs).toEqual(['engine.workflowClaimRenewInterval', 'engine.maxConcurrentRuns']);
    expect(runs).not.toContain('retention.audit');
    expect(runs).not.toContain('decisions.model');
    expect(runs).not.toContain('a2a.push.enabled');
    const disclosure = view.getByRole('button', { name: 'Advanced' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(row(view.container, 'tools.decide')).toBeNull();
    expect(row(view.container, 'tools.wakeup')).not.toBeNull();
    await fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(row(view.container, 'tools.decide')).not.toBeNull();
    expect(row(view.container, 'engine.history')).not.toBeNull();
  });

  test('names the default agent the way the Agents list does, in words and not as its identifier', async () => {
    const view = open(servedSettings(), {
      extra: {
        'bureau.agents.list': () => ({
          agents: [
            {
              name: 'assistant',
              displayName: 'assistant',
              description: null,
              definitionRevision: 1,
              kind: 'code',
              a2a: false,
            },
          ],
        }),
      },
    });
    await view.findByRole('group', READY);
    const selectIn = () =>
      row(view.container, 'chat.defaultAgent')?.querySelector<HTMLSelectElement>('select');
    await waitFor(() => expect(selectIn()).toBeTruthy());
    expect([...(selectIn()?.options ?? [])].map((option) => option.textContent?.trim())).toEqual([
      'Assistant',
    ]);
  });

  test('words each row as a label with its raw key beside it, and the Bureau’s description', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    const human = row(view.container, 'tools.humanInput');
    expect(human?.querySelector('label')?.textContent?.trim()).toBe('Human input');
    expect(human?.querySelector('.cinder-setting-row__identifier')?.textContent).toBe(
      'tools.humanInput',
    );
    expect(human?.textContent).toContain(
      'Let agents ask a person a question mid-task. Tasks started from now on get the setting; a running task keeps the one it started with.',
    );
    const renew = row(view.container, 'engine.workflowClaimRenewInterval');
    expect(renew?.textContent).toContain(
      'How often a worker renews its claim on a running workflow. Shorter intervals recover from a crashed worker sooner.',
    );
  });

  test('words a description with its code spans as their text, and every other mark as typed', async () => {
    const node = PUBLISHED_SCHEMA.properties['engine.maxConcurrentRuns'];
    if (node === undefined) throw new Error('the schema has no engine.maxConcurrentRuns');
    const description =
      'Runs `a` and `` then `b`, `open **bold** *emphasis* _this_ [a](b) <b>x</b>';
    const view = open(servedSettings(), {
      extra: {
        'bureau.settings.schema': () => ({
          schema: {
            ...PUBLISHED_SCHEMA,
            properties: {
              ...PUBLISHED_SCHEMA.properties,
              'engine.maxConcurrentRuns': { ...node, description },
            },
          },
        }),
      },
    });
    await view.findByRole('group', READY);
    const cap = await waitFor(() => {
      const found = row(view.container, 'engine.maxConcurrentRuns');
      expect(found?.textContent).toContain('Runs a and  then b,');
      return found;
    });
    // The empty span is dropped, the backtick that never closes stays, and nothing else is a mark.
    expect(cap?.textContent).toContain(
      'Runs a and  then b, `open **bold** *emphasis* _this_ [a](b) <b>x</b>',
    );
    expect(
      cap?.querySelector('strong, em, a, b, code:not(.cinder-setting-row__identifier)'),
    ).toBeNull();
  });

  test('keeps every General label while omitting configuration identifiers on a phone', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    await waitFor(() => expect(row(view.container, 'storage.backend')).not.toBeNull());
    const testWindow = window;
    if (!(testWindow instanceof Window)) throw new Error('expected a happy-dom test window');
    try {
      for (const width of [320, 375]) {
        testWindow.happyDOM.setViewport({ width, height: 800 });
        await waitFor(() =>
          expect(view.container.querySelectorAll('.cinder-setting-row__identifier')).toHaveLength(
            0,
          ),
        );
        expect(row(view.container, 'tools.humanInput')?.textContent).toContain('Human input');
        expect(row(view.container, 'engine.maxConcurrentRuns')?.textContent).toContain(
          'Max concurrent runs',
        );
      }
    } finally {
      testWindow.happyDOM.setViewport({ width: 1024, height: 768 });
    }
  });

  test('lists Max concurrent runs second under Runs, counted in runs', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    const cap = row(view.container, 'engine.maxConcurrentRuns');
    expect(cap?.querySelector('label')?.textContent?.trim()).toBe('Max concurrent runs');
    expect(cap?.querySelector('.cinder-setting-row__identifier')?.textContent).toBe(
      'engine.maxConcurrentRuns',
    );
    expect(cap?.textContent).toContain(
      'The most workflow runs that execute at the same time on this machine.',
    );
    expect(cap?.querySelector('input')?.value).toBe('4');
    expect(cap?.textContent).toContain('runs');
    const runs = [
      ...(cap?.closest('.cinder-form-section')?.querySelectorAll('[data-setting]') ?? []),
    ];
    expect(runs.map((found) => found.getAttribute('data-setting')).slice(0, 2)).toEqual([
      'engine.workflowClaimRenewInterval',
      'engine.maxConcurrentRuns',
    ]);
  });

  test('reads the claim interval as seconds, in the field, and has no page-level Save', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    const renew = row(view.container, 'engine.workflowClaimRenewInterval');
    expect(renew?.querySelector('input')?.value).toBe('10');
    expect(renew?.textContent).toContain('seconds');
    expect(view.queryByRole('button', { name: /^Save/ })).toBeNull();
  });

  test('shows an inherited claim interval as a seconds placeholder without saving it', async () => {
    const served = servedSettings({
      effective: { 'engine.workflowClaimRenewInterval': 15_000 },
    });
    delete served.values['engine.workflowClaimRenewInterval'];
    const view = open(served);
    await view.findByRole('group', READY);
    const input = fieldOf(view.container, 'engine.workflowClaimRenewInterval');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('15');
    expect(row(view.container, 'engine.workflowClaimRenewInterval')?.textContent).toContain(
      'seconds',
    );
    expect(updates()).toHaveLength(0);

    input.focus();
    await fireEvent.blur(input);
    await fireEvent.focusOut(input);
    expect(updates()).toHaveLength(0);

    await typeAndLeave(view.container, 'engine.workflowClaimRenewInterval', '20');
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: { 'engine.workflowClaimRenewInterval': 20_000 },
      expectedRevision: 3,
    });
  });

  test('says a Bureau that keeps nothing does not keep the settings', async () => {
    const view = open(servedSettings({ persisted: false }));
    expect(await view.findByTestId('settings-not-persisted')).not.toBeNull();
  });
});

describe('the storage backend', () => {
  test('is read-only text under Storage on a local host', async () => {
    const view = open(servedSettings(), { hostMode: 'local' });
    await view.findByRole('group', READY);
    await waitFor(() =>
      expect(view.getByTestId('storage-backend-value').textContent).toBe('SQLite, on this machine'),
    );
    const backend = row(view.container, 'storage.backend');
    expect(backend?.textContent).toContain(
      'Where Interborough keeps runs, chats and memories. Chosen when it was set up.',
    );
    expect(backend?.closest('section')?.querySelector('h2')?.textContent?.trim()).toBe('Storage');
  });

  test('moves into a Remote deployment card with the locked settings, each saying who owns it', async () => {
    const served = servedSettings({
      locked: new Set(['durable', 'engine.workflowClaimRenewInterval']),
      lockReasons: {
        durable: 'shared-storage',
        'engine.workflowClaimRenewInterval': 'shared-storage',
      },
    });
    const view = open(served, { hostMode: 'remote' });
    await view.findByRole('group', READY);
    await waitFor(() =>
      expect(view.getByTestId('storage-backend-value').textContent).toBe('Postgres and S3'),
    );
    const card = row(view.container, 'storage.backend')?.closest('section');
    expect(card?.querySelector('h2')?.textContent?.trim()).toBe('Remote deployment');
    expect(card?.textContent).toContain(SETTINGS_COPY.general.storageBackend.setByDeployment);
    const locked = [...(card?.querySelectorAll('[data-locked="true"]') ?? [])].map((found) =>
      found.getAttribute('data-setting'),
    );
    expect(locked.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'durable',
      'engine.workflowClaimRenewInterval',
    ]);
    expect(card?.textContent).toContain(SETTINGS_COPY.lockedMessage);
    // A locked control is read-only, and the page offers it no save.
    expect(fieldOf(view.container, 'engine.workflowClaimRenewInterval').disabled).toBe(true);
    expect(view.container.querySelectorAll('h2')[1]?.textContent?.trim()).toBe('Runs');
    expect(
      row(view.container, 'engine.workflowClaimRenewInterval')
        ?.closest('section')
        ?.querySelector('h2')
        ?.textContent?.trim(),
    ).toBe('Remote deployment');
  });
});

describe('Max concurrent runs in remote mode', () => {
  test('sits locked in the Remote deployment card, in the card’s own words', async () => {
    const served = servedSettings({
      locked: new Set(['engine.maxConcurrentRuns']),
      lockReasons: { 'engine.maxConcurrentRuns': 'deployment' },
    });
    const view = open(served, { hostMode: 'remote' });
    await view.findByRole('group', READY);
    await waitFor(() =>
      expect(
        row(view.container, 'engine.maxConcurrentRuns')
          ?.closest('section')
          ?.querySelector('h2')
          ?.textContent?.trim(),
      ).toBe('Remote deployment'),
    );
    const cap = row(view.container, 'engine.maxConcurrentRuns');
    expect(cap?.getAttribute('data-locked')).toBe('true');
    expect(cap?.textContent).toContain('The most workflow runs that execute at the same time.');
    expect(cap?.textContent).not.toContain('on this machine');
    expect(cap?.textContent).toContain(SETTINGS_COPY.lockedMessage);
    expect(fieldOf(view.container, 'engine.maxConcurrentRuns').disabled).toBe(true);
    expect(fieldOf(view.container, 'engine.maxConcurrentRuns').value).toBe('4');
  });
});

describe('a save', () => {
  test('is one update of the one key, made when its switch changes, against the revision read', async () => {
    const view = open(servedSettings({ revision: 7 }));
    await view.findByRole('group', READY);
    await fireEvent.click(toggleOf(view.container, 'tools.wakeup'));

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({ patch: { 'tools.wakeup': false }, expectedRevision: 7 });
    await waitFor(() => expect(statusOf(view.container, 'tools.wakeup')).toBe('Saved just now'));

    // The next save names the revision the first produced.
    await openAdvanced(view.container);
    await fireEvent.click(toggleOf(view.container, 'tools.decide'));
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()[1]?.params).toEqual({
      patch: { 'tools.decide': false },
      expectedRevision: 8,
    });
    expect(row(view.container, 'tools.wakeup')?.dataset['dirty']).toBe('false');
    await fireEvent.click(view.getByRole('button', { name: 'Advanced' }));
    expect(row(view.container, 'tools.decide')).toBeNull();
    await openAdvanced(view.container);
    expect(toggleOf(view.container, 'tools.decide').getAttribute('aria-checked')).toBe('false');
  });

  test('shows Saving while the request is in flight', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = servedSettings();
    const view = open(served, {
      extra: {
        'bureau.settings.update': async (params) => {
          await held;
          served.values = { ...served.values, ...(params['patch'] as Record<string, unknown>) };
          served.revision += 1;
          return { revision: served.revision, pendingRestart: [] };
        },
      },
    });
    await view.findByRole('group', READY);
    await fireEvent.click(toggleOf(view.container, 'tools.wakeup'));
    await waitFor(() => expect(statusOf(view.container, 'tools.wakeup')).toBe('Saving…'));
    release();
    await waitFor(() => expect(statusOf(view.container, 'tools.wakeup')).toBe('Saved just now'));
  });

  test('is made when a number field is left, and a restart setting then waits for a restart', async () => {
    const view = open(servedSettings({ revision: 3 }));
    await view.findByRole('group', READY);
    expect(statusOf(view.container, 'engine.workflowClaimRenewInterval')).toBe(
      'Applies after restart',
    );
    await typeAndLeave(view.container, 'engine.workflowClaimRenewInterval', '15');

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: { 'engine.workflowClaimRenewInterval': 15_000 },
      expectedRevision: 3,
    });
    await waitFor(() =>
      expect(statusOf(view.container, 'engine.workflowClaimRenewInterval')).toBe(
        'Saved, waiting for a restart',
      ),
    );
  });

  test('clears a nullable field to null, which is the setting with no limit and not a missing one (COR-2774)', async () => {
    const served = servedSettings({ revision: 5 });
    served.values = { ...served.values, 'engine.payloadSize': { maxBytes: 4096 } };
    const view = open(served);
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    expect(fieldOf(view.container, 'engine.payloadSize').value).toBe('4,096');

    const field = fieldOf(view.container, 'engine.payloadSize');
    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: '' } });
    await fireEvent.blur(field);
    await fireEvent.focusOut(field);

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: { 'engine.payloadSize': { maxBytes: null } },
      expectedRevision: 5,
    });
    await waitFor(() =>
      expect(statusOf(view.container, 'engine.payloadSize')).toBe('Saved just now'),
    );
  });

  test('clears a nullable field the way a fill of the real input does: select, focus, then delete the selection (COR-2774)', async () => {
    const served = servedSettings({ revision: 5 });
    served.values = { ...served.values, 'engine.payloadSize': { maxBytes: 4096 } };
    const view = open(served);
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    const field = fieldOf(view.container, 'engine.payloadSize');
    expect(field.value).toBe('4,096');

    // Select and focus in one turn, then the key press in the next: what Playwright's `fill('')` does.
    selectAsChromium(field);
    field.focus();
    await waitUntil(() => field.value === '4096');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);
    pressDelete(field);
    // The emptied field stays empty through the re-render the edit causes, until it is left.
    await waitFor(() =>
      expect(row(view.container, 'engine.payloadSize')?.dataset['dirty']).toBe('true'),
    );
    expect(field.value).toBe('');
    expect(updates()).toHaveLength(0);

    await fireEvent.blur(field);
    await fireEvent.focusOut(field);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: { 'engine.payloadSize': { maxBytes: null } },
      expectedRevision: 5,
    });
  });

  test('saves a number typed into a nullable field once it is a number, and holds it until then (COR-2774)', async () => {
    const served = servedSettings({ revision: 5 });
    const view = open(served);
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    const field = fieldOf(view.container, 'engine.payloadSize');
    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: '1e' } });
    await fireEvent.blur(field);
    await fireEvent.focusOut(field);
    expect(updates()).toHaveLength(0);

    await typeAndLeave(view.container, 'engine.payloadSize', '2048');
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: { 'engine.payloadSize': { maxBytes: 2048 } },
      expectedRevision: 5,
    });
  });

  test('draws a lone field’s control in the row’s own control column, not under the row (COR-2774)', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    const field = fieldOf(view.container, 'engine.payloadSize');
    expect(field.closest('.cinder-setting-row__field')).not.toBeNull();
    // Outside the form's own box: nothing of the setting's is left under the row but the form.
    expect(field.closest('fieldset.weft-setting__form')).toBeNull();
  });

  test('saves a row of several fields when focus leaves the row, and not when it moves between its fields (COR-2774)', async () => {
    const view = open(servedSettings({ revision: 5 }));
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    const inputs = [
      ...(row(view.container, 'engine.retention')?.querySelectorAll<HTMLInputElement>(
        'input[inputmode="decimal"]',
      ) ?? []),
    ];
    const [first, second] = inputs;
    if (first === undefined || second === undefined) throw new Error('Two fields are drawn.');

    await fireEvent.focus(first);
    await fireEvent.input(first, { target: { value: '12345' } });
    await fireEvent.blur(first);
    // Focus moves to the next field of the same row: that is not leaving it.
    await fireEvent.focusOut(first, { relatedTarget: second });
    await quietFor(50);
    expect(updates()).toHaveLength(0);

    await fireEvent.focus(second);
    await fireEvent.blur(second);
    await fireEvent.focusOut(second);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toMatchObject({
      patch: { 'engine.retention': { completed: 12345 } },
    });
  });

  test('disables a lone field’s control in a row the deployment locked (COR-2774)', async () => {
    const view = open(servedSettings({ locked: new Set(['engine.payloadSize']) }));
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    const field = fieldOf(view.container, 'engine.payloadSize');
    expect(field.disabled).toBe(true);
    expect(row(view.container, 'engine.payloadSize')?.dataset['locked']).toBe('true');
  });

  test('sends nothing for a field that was left as it was', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    await typeAndLeave(view.container, 'engine.workflowClaimRenewInterval', '10');
    expect(updates()).toHaveLength(0);
  });

  test('refuses a value that fails its check at the field, and sends nothing', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    await typeAndLeave(view.container, 'logs.maximumLinesPerRun', '9999');

    const found = row(view.container, 'logs.maximumLinesPerRun');
    await waitFor(() => expect(found?.textContent).toContain(SETTINGS_COPY.nothingSaved));
    expect(updates()).toHaveLength(0);
    expect(found?.querySelector('[aria-invalid="true"]')).not.toBeNull();
  });

  test('saves the spend threshold through the runtime setting, as a number (COR-2528)', async () => {
    const served = servedSettings();
    const view = open(served);
    await view.findByRole('group', READY);
    // No designed row draws it, so it sits under Advanced like every undrawn key.
    await openAdvanced(view.container);
    expect(row(view.container, 'runs.spendThresholdUsd')?.textContent).toContain(
      'Spend threshold per run',
    );
    await typeAndLeave(view.container, 'runs.spendThresholdUsd', '2.5');

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'runs.spendThresholdUsd': 2.5 });
    await waitFor(() => expect(served.values['runs.spendThresholdUsd']).toBe(2.5));
  });

  test('shows the Bureau’s own refusal of the spend threshold at its field, and keeps what was typed (COR-2528)', async () => {
    const view = open(servedSettings(), {
      extra: {
        'bureau.settings.update': () => {
          throw new StubFault('InvalidParams', 400, 'invalid params', {
            issues: [
              {
                path: ['patch', 'runs.spendThresholdUsd'],
                message: 'Too small: expected number to be >0',
              },
            ],
          });
        },
      },
    });
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    await typeAndLeave(view.container, 'runs.spendThresholdUsd', '3');

    const found = row(view.container, 'runs.spendThresholdUsd');
    await waitFor(() =>
      expect(found?.textContent).toContain(
        `runs.spendThresholdUsd: Too small: expected number to be >0 ${SETTINGS_COPY.nothingSaved}`,
      ),
    );
    expect(fieldOf(view.container, 'runs.spendThresholdUsd').value).toBe('3');
  });

  test('keeps the typed value, says the save did not go through, and tries again on Try again', async () => {
    const served = servedSettings();
    let failing = true;
    const view = open(served, {
      extra: {
        'bureau.settings.update': (params) => {
          if (failing) throw new StubFault('Internal', 500, 'The server did not answer.');
          served.values = { ...served.values, ...(params['patch'] as Record<string, unknown>) };
          served.revision += 1;
          return { revision: served.revision, pendingRestart: [] };
        },
      },
    });
    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    await typeAndLeave(view.container, 'logs.maximumLinesPerRun', '300');

    const found = row(view.container, 'logs.maximumLinesPerRun');
    await waitFor(() => expect(found?.textContent).toContain(SETTINGS_COPY.couldNotSave));
    expect(fieldOf(view.container, 'logs.maximumLinesPerRun').value).toBe('300');
    await fireEvent.click(view.getByRole('button', { name: 'Advanced' }));
    expect(row(view.container, 'logs.maximumLinesPerRun')).toBeNull();
    await openAdvanced(view.container);
    expect(fieldOf(view.container, 'logs.maximumLinesPerRun').value).toBe('300');
    expect(row(view.container, 'logs.maximumLinesPerRun')?.textContent).toContain(
      SETTINGS_COPY.couldNotSave,
    );

    failing = false;
    const reopened = row(view.container, 'logs.maximumLinesPerRun') as HTMLElement;
    await fireEvent.click(within(reopened).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(reopened.textContent).not.toContain(SETTINGS_COPY.couldNotSave));
    expect(served.values['logs.maximumLinesPerRun']).toBe(300);
  });

  test('says when the caller may read the settings but not change them', async () => {
    const view = open(servedSettings(), {
      extra: {
        'bureau.settings.update': () => {
          throw new StubFault('Forbidden', 403, 'Not allowed.');
        },
      },
    });
    await view.findByRole('group', READY);
    await fireEvent.click(toggleOf(view.container, 'tools.wakeup'));
    await waitFor(() =>
      expect(row(view.container, 'tools.wakeup')?.textContent).toContain(SETTINGS_COPY.forbidden),
    );
  });

  test('reads the settings again and sends the value once more when the revision was stale', async () => {
    const served = servedSettings({ revision: 3 });
    const view = open(served);
    await view.findByRole('group', READY);
    // Something else changes another setting after the page read.
    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    await fireEvent.click(toggleOf(view.container, 'tools.wakeup'));

    await waitFor(() => expect(updates().length).toBeGreaterThanOrEqual(2));
    expect(updates().at(-1)?.params).toEqual({
      patch: { 'tools.wakeup': false },
      expectedRevision: 4,
    });
    expect(served.values['tools.wakeup']).toBe(false);
    await waitFor(() => expect(statusOf(view.container, 'tools.wakeup')).toBe('Saved just now'));
  });

  test('turns the human-input switch off to false and back on to the object it held', async () => {
    const served = servedSettings();
    served.values = { ...served.values, 'tools.humanInput': { inputSchemas: { a: {} } } };
    const view = open(served);
    await view.findByRole('group', READY);
    await fireEvent.click(toggleOf(view.container, 'tools.humanInput'));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toMatchObject({ patch: { 'tools.humanInput': false } });
    await waitFor(() =>
      expect(toggleOf(view.container, 'tools.humanInput').getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
    await waitFor(() =>
      expect(statusOf(view.container, 'tools.humanInput')).toBe('Saved just now'),
    );
    await fireEvent.click(toggleOf(view.container, 'tools.humanInput'));
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()[1]?.params).toMatchObject({
      patch: { 'tools.humanInput': { inputSchemas: { a: {} } } },
    });
  });

  test('draws false or an object as the row’s switch and the object’s fields, with no second choice (COR-2774)', async () => {
    const served = servedSettings({ revision: 4 });
    served.values = { ...served.values, 'tools.humanInput': { count: 3 } };
    const schema = {
      ...PUBLISHED_SCHEMA,
      properties: {
        ...PUBLISHED_SCHEMA.properties,
        'tools.humanInput': {
          anyOf: [
            { type: 'boolean', const: false },
            { type: 'object', properties: { count: { type: 'integer' } } },
          ],
          description: 'Let agents ask a person.',
        },
      },
    };
    const view = open(served, { extra: { 'bureau.settings.schema': () => ({ schema }) } });
    await view.findByRole('group', READY);

    const found = row(view.container, 'tools.humanInput');
    expect(toggleOf(view.container, 'tools.humanInput').getAttribute('aria-checked')).toBe('true');
    expect(within(found as HTMLElement).queryByRole('radio')).toBeNull();
    expect(fieldOf(view.container, 'tools.humanInput').value).toBe('3');

    await fireEvent.click(toggleOf(view.container, 'tools.humanInput'));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toMatchObject({ patch: { 'tools.humanInput': false } });
  });
});

describe('a change made while the save of the same setting is in flight', () => {
  test('is saved once the first save has finished, so the last choice is the one that stands', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = servedSettings();
    let calls = 0;
    const view = open(served, {
      extra: {
        'bureau.settings.update': async (params) => {
          calls += 1;
          if (calls === 1) await held;
          served.values = { ...served.values, ...(params['patch'] as Record<string, unknown>) };
          served.revision += 1;
          return { revision: served.revision, pendingRestart: [] };
        },
      },
    });
    await view.findByRole('group', READY);
    await fireEvent.click(toggleOf(view.container, 'tools.wakeup'));
    await waitFor(() => expect(statusOf(view.container, 'tools.wakeup')).toBe('Saving…'));
    // Put it back while the first save is out.
    await fireEvent.click(toggleOf(view.container, 'tools.wakeup'));
    release();

    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(served.values['tools.wakeup']).toBe(true));
    await waitFor(() => expect(statusOf(view.container, 'tools.wakeup')).toBe('Saved just now'));
    expect(toggleOf(view.container, 'tools.wakeup').getAttribute('aria-checked')).toBe('true');
  });
});

describe('the restart banner', () => {
  const KEY = 'engine.workflowClaimRenewInterval';

  test('counts the saved changes that wait, names them, and offers Restart now', async () => {
    const view = open(servedSettings({ pendingRestart: new Set([KEY]) }));
    const banner = await view.findByTestId('settings-restart-summary');
    expect(banner.textContent).toContain('1 change waits for a restart');
    expect(banner.textContent).toContain(
      'Workflow claim renew interval. Running work picks up where it stopped; reviews stay waiting.',
    );
    expect(within(banner).getByRole('button', { name: 'Restart now' })).not.toBeNull();
    expect(statusOf(view.container, KEY)).toBe('Saved, waiting for a restart');
  });

  test('reverts the waiting change to the running value, and Undo puts the saved one back', async () => {
    const view = open(
      servedSettings({
        values: { ...servedSettings().values, [KEY]: 15_000 },
        running: { ...servedSettings().values, [KEY]: 30_000 },
        pendingRestart: new Set([KEY]),
      }),
    );
    const banner = await view.findByTestId('settings-restart-summary');
    const revert = within(banner).getByRole('button', { name: 'Revert 1 change' });
    expect(within(banner).getByRole('button', { name: 'Restart now' })).not.toBeNull();
    await fireEvent.click(revert);

    await waitFor(() => expect(statusOf(view.container, KEY)).toBe('Reverted, in effect now'));
    expect(updates().at(-1)?.params['patch']).toEqual({ [KEY]: 30_000 });
    expect(fieldOf(view.container, KEY).value).toBe('30');
    expect(view.queryByTestId('settings-restart-summary')).toBeNull();
    const toast = await view.findByText('Reverted 1 change. Nothing needs a restart.');
    const undo = within(toast.closest('.cinder-toast') as HTMLElement).getByRole('button', {
      name: 'Undo',
    });

    await fireEvent.click(undo);
    await waitFor(() => expect(statusOf(view.container, KEY)).toBe('Saved, waiting for a restart'));
    expect(updates().at(-1)?.params['patch']).toEqual({ [KEY]: 15_000 });
    expect(fieldOf(view.container, KEY).value).toBe('15');
    expect(await view.findByTestId('settings-restart-summary')).not.toBeNull();
  });

  test('clears a waiting setting that nothing set when the host started', async () => {
    const { [KEY]: _unset, ...running } = servedSettings().values;
    void _unset;
    const view = open(servedSettings({ running, pendingRestart: new Set([KEY]) }));
    const banner = await view.findByTestId('settings-restart-summary');
    await fireEvent.click(within(banner).getByRole('button', { name: 'Revert 1 change' }));
    await waitFor(() => expect(statusOf(view.container, KEY)).toBe('Reverted, in effect now'));
    expect(updates().at(-1)?.params['patch']).toEqual({ [KEY]: null });
  });

  test('names how many changes it reverts', async () => {
    const view = open(
      servedSettings({ pendingRestart: new Set([KEY, 'engine.maxConcurrentRuns']) }),
    );
    const banner = await view.findByTestId('settings-restart-summary');
    expect(within(banner).getByRole('button', { name: 'Revert 2 changes' })).not.toBeNull();
  });

  test('is not drawn when nothing waits', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    expect(view.queryByTestId('settings-restart-summary')).toBeNull();
  });

  test('says a second change is the second that waits', async () => {
    const view = open(servedSettings({ pendingRestart: new Set([KEY]) }));
    await view.findByTestId('settings-restart-summary');
    await openAdvanced(view.container);
    await typeAndLeave(view.container, 'engine.checkpointHistory', '9');
    await waitFor(() =>
      expect(view.getByTestId('settings-restart-summary').textContent).toContain(
        '2 changes wait for a restart',
      ),
    );
    await fireEvent.click(view.getByRole('button', { name: 'Advanced' }));
    expect(view.getByTestId('settings-restart-summary').textContent).toContain(
      '2 changes wait for a restart',
    );
  });
});

describe('the preferences of this browser', () => {
  test('are the theme, the sidebar and the keyboard, and there is no density setting', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    const section = [...view.container.querySelectorAll('.cinder-form-section')].find(
      (candidate) => candidate.querySelector('h2')?.textContent?.trim() === 'Your preferences',
    );
    const keys = [...(section?.querySelectorAll('[data-setting]') ?? [])].map((found) =>
      found.getAttribute('data-setting'),
    );
    expect(keys).toContain('shortcuts.singleKey');
    expect(section?.textContent).not.toMatch(/density/i);
  });

  test('"Use single-key shortcuts" is on by default and turns the plain keys off and on', async () => {
    const keyboard = new KeyboardPreferences();
    const view = open(servedSettings(), { keyboard });
    const toggle = await view.findByRole('switch', {
      name: SETTINGS_COPY.general.preferences.singleKey.label,
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await fireEvent.click(toggle);
    expect(keyboard.singleKeyShortcuts).toBe(false);
    await fireEvent.click(toggle);
    expect(keyboard.singleKeyShortcuts).toBe(true);
  });
});

// Owner, 2026-11-19: Settings listed three derived host paths and every provider's secret
// reference. One row, the data folder, with its Copy button; no secret reference renders.
describe('the one host fact Settings shows, on a host of each mode', () => {
  test.each(['local', 'remote'] as const)(
    'is the data folder in a copy control on a %s host, and no other path or secret reference',
    async (mode) => {
      const view = open(servedSettings(), { hostMode: mode });
      await view.findByRole('group', READY);
      const folder = await view.findByTestId('settings-data-folder');
      expect(folder.classList.contains('cinder-copyable-value')).toBe(true);
      expect(folder.closest('[data-setting="data-folder"]')).not.toBeNull();
      expect(view.container.textContent).toContain(SETTINGS_COPY.about.dataFolder);
      expect(view.container.textContent).not.toContain('Where the host keeps');
      expect(view.container.textContent).not.toContain('workspace:');
      for (const location of [
        STUB_REMOTE_AGENT_DIRECTORY,
        STUB_REMOTE_WORKFLOW_DIRECTORY,
        STUB_REMOTE_CONFIGURATION_FILE,
        ...STUB_REMOTE_PROVIDERS.map((provider) => provider.secretFile),
      ]) {
        expect(view.container.textContent).not.toContain(location);
      }
      expect(
        forbiddenVisibleText(visibleTextOutsideCopyControls(view.container, PATH_ALLOWED_SELECTOR)),
      ).toEqual([]);
    },
  );
});

describe('a page whose read fails', () => {
  test('with nothing to show keeps its navigation and heading, and the error state replaces the content', async () => {
    const view = open(servedSettings(), {
      extra: {
        'bureau.settings.get': () => {
          throw new StubFault('Internal', 500, 'The server broke.');
        },
        'bureau.settings.schema': () => {
          throw new StubFault('Internal', 500, 'The server broke.');
        },
      },
    });

    await view.findByRole('button', { name: 'Try again' });
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('General');
    expect(
      within(view.container).getByRole('navigation', { name: 'Settings sections' }),
    ).not.toBeNull();
    expect(view.queryByRole('group', READY)).toBeNull();
    expect(view.queryByTestId('settings-refresh-failed')).toBeNull();
  });

  test('after the settings were shown puts one banner over the old values, and Try again clears it', async () => {
    const served = servedSettings({ revision: 3 });
    const stream = settingsStream();
    let failing = false;
    const view = open(served, {
      stream,
      extra: {
        'bureau.settings.get': () => {
          if (failing) throw new StubFault('Internal', 500, 'The server broke.');
          return settingsSnapshot(served);
        },
      },
    });
    await view.findByRole('group', READY);
    await waitFor(() => expect(stream.opened).toEqual([undefined]));

    failing = true;
    served.revision = 4;
    stream.push(4, ['tools.decide']);

    const banner = await view.findByTestId('settings-refresh-failed');
    expect(banner.textContent).toContain('Couldn’t refresh these settings.');
    expect(banner.textContent).toContain('Showing what loaded as of');
    // The old values stay, at full contrast, and there is no full error state beside the banner.
    expect(view.getByRole('group', READY)).not.toBeNull();
    await openAdvanced(view.container);
    expect(toggleOf(view.container, 'tools.decide')).not.toBeNull();
    expect(view.container.querySelector('.cinder-error-state')).toBeNull();

    failing = false;
    await fireEvent.click(within(banner).getByRole('button', { name: 'Try again' }));
    await waitUntil(() => view.queryByTestId('settings-refresh-failed') === null);
  });
});

describe('a page that follows the Bureau', () => {
  test('takes in a change made elsewhere to a setting that is not being edited', async () => {
    const served = servedSettings({ revision: 3 });
    const stream = settingsStream();
    const view = open(served, { stream });
    await view.findByRole('group', READY);
    await waitFor(() => expect(stream.opened).toEqual([undefined]));

    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    stream.push(4, ['tools.decide']);

    await openAdvanced(view.container);
    await waitFor(() =>
      expect(toggleOf(view.container, 'tools.decide').getAttribute('aria-checked')).toBe('false'),
    );
  });

  test('resumes from the last revision it was given when the Bureau ends the stream', async () => {
    const stream = settingsStream();
    const view = open(servedSettings({ revision: 3 }), { stream });
    await view.findByRole('group', READY);
    await waitFor(() => expect(stream.opened).toHaveLength(1));
    stream.push(4, ['tools.decide']);
    stream.end();
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
    const view = open(served, {
      stream,
      extra: {
        'bureau.settings.get': async () => {
          started += 1;
          const answer = settingsSnapshot(served);
          if (started === 2) await firstReadHeld;
          return answer;
        },
      },
    });
    await waitFor(() => expect(stream.opened).toHaveLength(1));
    await waitFor(() => expect(started).toBe(2));
    served.values = { ...served.values, 'tools.decide': false };
    served.revision = 4;
    stream.push(4, ['tools.decide']);
    await waitUntil(() => stream.drained());
    releaseFirstRead();

    await view.findByRole('group', READY);
    await openAdvanced(view.container);
    await waitFor(() =>
      expect(toggleOf(view.container, 'tools.decide').getAttribute('aria-checked')).toBe('false'),
    );
    expect(started).toBeGreaterThanOrEqual(3);
  });

  test('answers a refocus that joins the read already in flight with that read, and the next refocus with a read of its own', async () => {
    // A read of the settings is in flight (the one the page makes once the Bureau accepts the
    // subscription is one, and so is the read of a change). A window that regains focus joins it,
    // so a read that fails from now on is not met until the focus comes back once more: the Data
    // and retention spec refocuses until the banner shows for this reason.
    const served = servedSettings({ revision: 3 });
    const stream = settingsStream();
    let failing = false;
    let holding = false;
    let releaseHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    let started = 0;
    const view = open(served, {
      stream,
      extra: {
        'bureau.settings.get': async () => {
          started += 1;
          if (failing) throw new StubFault('Internal', 500, 'The server broke.');
          const answer = settingsSnapshot(served);
          if (holding) {
            holding = false;
            await held;
          }
          return answer;
        },
      },
    });
    await view.findByRole('group', READY);
    await waitFor(() => expect(stream.opened).toEqual([undefined]));

    holding = true;
    served.revision = 4;
    stream.push(4, ['tools.decide']);
    await waitFor(() => expect(holding).toBe(false));
    const inFlight = started;

    failing = true;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    releaseHeld();
    await waitUntil(() => stream.drained());
    expect(started).toBe(inFlight);
    expect(view.queryByTestId('settings-refresh-failed')).toBeNull();

    // The released read may still be settling, which a refocus joins too, so refocus until a read
    // of its own meets the failure.
    await waitFor(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      expect(view.queryByTestId('settings-refresh-failed')).not.toBeNull();
    });
    expect(started).toBeGreaterThanOrEqual(3);
  });

  test('keeps working, reading on focus, when the Bureau refuses the stream', async () => {
    const served = servedSettings({ revision: 3 });
    const view = open(served);
    await view.findByRole('group', READY);
    const reads = () => stub?.callsTo('bureau.settings.get').length ?? 0;
    const before = reads();
    served.revision = 4;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});
