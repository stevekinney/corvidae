/**
 * Settings › General (board SettingsShell, "General · /settings"): four sections of Cinder setting
 * rows, each saved as it is left and saying so on its own row, the sticky banner that counts saved
 * changes waiting for a restart, the locked settings of a remote deployment, and the preferences
 * of this browser. The Bureau is a stub that answers as the real one does
 * (`settings-fixtures.test-support.ts`); the real one is exercised by the Playwright suite.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SETTINGS_COPY } from '../../app/copy.ts';
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

  test('draws Tools, Runs, Storage and Your preferences, and never an Engine heading', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    const headings = [...view.container.querySelectorAll('h2')].map((heading) =>
      heading.textContent?.trim(),
    );
    expect(headings.slice(0, 4)).toEqual(['Tools', 'Runs', 'Storage', 'Your preferences']);
    expect(headings.join('|')).not.toMatch(/engine/i);
    expect(view.container.textContent).toContain(SETTINGS_COPY.general.sections.runs.description);
    expect(view.container.textContent).toContain(
      SETTINGS_COPY.general.sections.preferences.description,
    );
  });

  test('puts the tools under Tools and the engine settings under Runs, the claim interval first', async () => {
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
    // Tools holds the two rows the board draws; Decide, which it does not draw, follows them under Runs.
    expect(keysIn('Tools')).toEqual(['tools.humanInput', 'tools.wakeup']);
    const runs = keysIn('Runs');
    expect(runs[0]).toBe('engine.workflowClaimRenewInterval');
    expect(runs).toContain('tools.decide');
    expect(runs).toContain('engine.history');
    expect(runs).not.toContain('retention.audit');
    expect(runs).not.toContain('decisions.model');
    expect(runs).not.toContain('a2a.push.enabled');
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
      expect(view.getByTestId('storage-backend-value').textContent).toBe(
        'SQLite · on this machine',
      ),
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
    await fireEvent.click(toggleOf(view.container, 'tools.decide'));
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()[1]?.params).toEqual({
      patch: { 'tools.decide': false },
      expectedRevision: 8,
    });
    expect(row(view.container, 'tools.wakeup')?.dataset['dirty']).toBe('false');
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

  test('sends nothing for a field that was left as it was', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    await typeAndLeave(view.container, 'engine.workflowClaimRenewInterval', '10');
    expect(updates()).toHaveLength(0);
  });

  test('refuses a value that fails its check at the field, and sends nothing', async () => {
    const view = open(servedSettings());
    await view.findByRole('group', READY);
    await typeAndLeave(view.container, 'logs.maximumLinesPerRun', '9999');

    const found = row(view.container, 'logs.maximumLinesPerRun');
    await waitFor(() => expect(found?.textContent).toContain(SETTINGS_COPY.nothingSaved));
    expect(updates()).toHaveLength(0);
    expect(found?.querySelector('[aria-invalid="true"]')).not.toBeNull();
  });

  test('keeps the typed value, says the save did not go through, and tries again on Retry', async () => {
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
    await typeAndLeave(view.container, 'logs.maximumLinesPerRun', '300');

    const found = row(view.container, 'logs.maximumLinesPerRun');
    await waitFor(() => expect(found?.textContent).toContain(SETTINGS_COPY.couldNotSave));
    expect(fieldOf(view.container, 'logs.maximumLinesPerRun').value).toBe('300');

    failing = false;
    await fireEvent.click(within(found as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(found?.textContent).not.toContain(SETTINGS_COPY.couldNotSave));
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

    await waitFor(() => expect(statusOf(view.container, KEY)).toBe('Reverted · in effect now'));
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
    await waitFor(() => expect(statusOf(view.container, KEY)).toBe('Reverted · in effect now'));
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
    await typeAndLeave(view.container, 'engine.checkpointHistory', '9');
    await waitFor(() =>
      expect(view.getByTestId('settings-restart-summary').textContent).toContain(
        '2 changes wait for a restart',
      ),
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

describe('where the host keeps its state, on a host of each mode', () => {
  test.each(['local', 'remote'] as const)(
    'names each place in the words of a %s host',
    async (mode) => {
      const view = open(servedSettings(), { hostMode: mode });
      await view.findByRole('group', READY);
      const words = mode === 'remote' ? SETTINGS_COPY.remote.hostPaths : SETTINGS_COPY.hostPaths;
      const section = view.container.querySelector<HTMLElement>('.weft-general__paths');
      await waitFor(() => expect(section?.querySelector('dl')).not.toBeNull());
      expect(section?.querySelector('h2')?.textContent?.trim()).toBe(words.title);
      const text = section?.textContent ?? '';
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
    },
  );
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
    await waitFor(() =>
      expect(toggleOf(view.container, 'tools.decide').getAttribute('aria-checked')).toBe('false'),
    );
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
