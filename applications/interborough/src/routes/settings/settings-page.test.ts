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
const CONTROLS = 'button[role="switch"], input, select, textarea';

const updates = () => stub?.callsTo('bureau.settings.update') ?? [];

describe('the page', () => {
  test('draws one control for every key of the schema, and none of them unsupported', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('form', { name: SETTINGS_COPY.formLabel });

    const rows = [...container.querySelectorAll<HTMLElement>('[data-setting]')];
    expect(rows.map((entry) => entry.dataset['setting'])).toEqual([...SETTING_KEYS]);
    for (const entry of rows) {
      expect(entry.querySelector(CONTROLS), entry.dataset['setting']).not.toBeNull();
    }
    expect(container.textContent?.toLowerCase()).not.toContain('unsupported');
  });

  test('groups the keys by their first segment, with the keys that fix the deployment under Durability', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('form', { name: SETTINGS_COPY.formLabel });

    const headings = [...container.querySelectorAll('h2')].map((heading) =>
      heading.textContent?.trim(),
    );
    expect(headings).toEqual([
      'Tools',
      'Model policy',
      'Decisions',
      'Context',
      'Retention',
      'Logs',
      'Session input',
      'Children',
      'Engine',
      'Durability',
      'A2A',
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
    await findByRole('form', { name: SETTINGS_COPY.formLabel });

    expect(row(container, 'tools.wakeup')?.textContent).toContain(SETTINGS_COPY.apply.live);
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
    await findByRole('form', { name: SETTINGS_COPY.formLabel });

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
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
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

  test('names a restart key it set, which waits for a restart', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
    await fireEvent.click(
      row(container, 'durable')?.querySelector('button[role="switch"]') as HTMLElement,
    );
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));

    await within(container).findByText(SETTINGS_COPY.saved.pendingRestart(['durable']));
  });

  test('turns the human-input switch off to false and back on to the object its editor holds', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
    const toggle = () =>
      row(container, 'tools.humanInput')?.querySelector('button[role="switch"]') as HTMLElement;
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    await fireEvent.click(toggle());
    await fireEvent.click(within(form).getByRole('button', { name: SETTINGS_COPY.saveAction }));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'tools.humanInput': false });
    // The form starts over from the settings it reads back, and then its controls work again.
    await waitFor(() => expect(row(container, 'tools.humanInput')?.dataset['dirty']).toBe('false'));
    await waitFor(() => expect(toggle().closest('fieldset')?.disabled).toBe(false));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(row(container, 'tools.humanInput')?.querySelector('textarea')).toBeNull();

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

  test('holds a JSON editor’s text that is not JSON, and sends nothing until it is', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
    const editor = row(container, 'modelPolicy')?.querySelector('textarea') as HTMLTextAreaElement;

    await fireEvent.input(editor, { target: { value: '{"policyRevision": ' } });
    const save = within(form).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(row(container, 'modelPolicy')?.dataset['dirty']).toBe('true');

    await fireEvent.input(editor, { target: { value: '{"policyRevision": 1}' } });
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ modelPolicy: { policyRevision: 1 } });
  });

  test('sends nothing for a key the deployment locked, and says which key the Bureau refused', async () => {
    const served = servedSettings({ locked: new Set(['tools.wakeup']) });
    const { container, findByRole } = open(served);
    await findByRole('form', { name: SETTINGS_COPY.formLabel });
    const wakeup = row(container, 'tools.wakeup')?.querySelector(
      'button[role="switch"]',
    ) as HTMLButtonElement;
    expect(wakeup.disabled).toBe(true);
    await fireEvent.click(wakeup);
    expect(row(container, 'tools.wakeup')?.dataset['dirty']).toBe('false');
  });

  test('says a refusal the Bureau gave for a value, and changes nothing on the page', async () => {
    const { container, findByRole } = open(servedSettings());
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });

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
    await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    const form = await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    await findByRole('form', { name: SETTINGS_COPY.formLabel });
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

    await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
    await findByRole('form', { name: SETTINGS_COPY.formLabel });
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
      await findByRole('form', { name: SETTINGS_COPY.formLabel });

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
