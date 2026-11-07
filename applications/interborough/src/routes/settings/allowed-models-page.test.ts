/**
 * `/settings/allowed-models` (board PageSettingsSections, "Allowed models"): one checkbox per model
 * the connected providers offer, the caller's cost, speed and effort preferences, and one explicit
 * Save, because a save raises the policy revision. It is the `modelPolicy` setting saved with the
 * same `bureau.settings.update` as every other. The Bureau and the host's provider routes are stubs
 * (`settings-fixtures.test-support.ts`, `models/models-host.test-support.ts`); the real ones are
 * exercised by the Playwright suite (`tests/e2e/settings-allowed-models.spec.ts`).
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ALLOWED_MODELS_COPY, SETTINGS_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import { landAt } from '../chat/pages.test-support.ts';
import { LOCAL_PROFILE } from './model-policy-edit.ts';
import { installFakeHost, model, type FakeHost } from './models/models-host.test-support.ts';
import {
  installSettingsBureau,
  servedSettings,
  SETTING_VALUES,
  type SettingsServed,
} from './settings-fixtures.test-support.ts';

const OPUS = model('anthropic', 'claude-opus-5-5', { images: true });
const SONNET = model('anthropic', 'claude-sonnet-5-5', { images: true });
const HAIKU = model('anthropic', 'claude-haiku-5-5');

/** The policy the sample world holds: the caller's default effort is High, and the revision is 1. */
const SAMPLE_POLICY = {
  policyRevision: 1,
  users: { [LOCAL_PROFILE]: { defaultEffort: 'high' } },
};

let stub: BureauStub | undefined;
let host: FakeHost | undefined;
afterEach(() => {
  cleanup();
  // Newest first: each stand-in restores the fetch it found.
  host?.restore();
  host = undefined;
  stub?.restore();
  stub = undefined;
});

function served(overrides: Partial<SettingsServed> = {}, policy: unknown = SAMPLE_POLICY) {
  return servedSettings({
    values: { ...SETTING_VALUES, modelPolicy: policy },
    ...overrides,
  });
}

function open(
  options: {
    served?: SettingsServed;
    connected?: boolean;
    extra?: Record<string, (params: Record<string, unknown>) => unknown>;
  } = {},
) {
  stub = installSettingsBureau(options.served ?? served(), options.extra ?? {});
  host = installFakeHost({
    keys: { anthropic: options.connected ?? false },
    offered: { anthropic: [OPUS, SONNET, HAIKU] },
  });
  landAt('/settings/allowed-models');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const updates = () => stub?.callsTo('bureau.settings.update') ?? [];
const READY = { name: SETTINGS_COPY.formLabel };

async function ready(view: ReturnType<typeof open>) {
  await view.findByRole('group', READY);
  return view;
}

const saveButton = (view: ReturnType<typeof open>) =>
  view.getByRole('button', { name: ALLOWED_MODELS_COPY.save });

describe('the page', () => {
  test('is titled Allowed models, with Models and Preferences in sentence case and nothing beside the title', async () => {
    const view = await ready(open());
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe('Allowed models');
    expect(view.container.textContent).toContain(ALLOWED_MODELS_COPY.intro);
    expect(
      [...view.container.querySelectorAll('h2')].map((heading) => heading.textContent?.trim()),
    ).toEqual(['Models', 'Preferences']);
    expect(view.container.textContent).toContain(ALLOWED_MODELS_COPY.models.description);
    expect(view.container.textContent).toContain(ALLOWED_MODELS_COPY.preferences.description);
    // Nothing is pending, so there is no actions bar and no count.
    expect(view.queryByRole('group', { name: 'Form actions' })).toBeNull();
    expect(view.container.textContent).not.toContain('unsaved');
    expect(view.container.textContent).toContain(ALLOWED_MODELS_COPY.note);
  });

  test('with no provider connected says so in one muted line with a link to Providers, and draws no checkboxes', async () => {
    const view = await ready(open());
    const empty = await view.findByTestId('allowed-models-empty');
    expect(empty.textContent).toContain(ALLOWED_MODELS_COPY.models.empty);
    const link = within(empty).getByRole('link', {
      name: ALLOWED_MODELS_COPY.models.goToProviders,
    });
    expect(link.getAttribute('href')).toBe('/settings/models');
    expect(view.queryAllByRole('checkbox')).toHaveLength(0);
    // No warning box: the line is all there is to say.
    expect(view.container.querySelectorAll('.cinder-alert')).toHaveLength(0);
  });

  test('draws Prefer and Default effort as two rows, each with its raw key beside the name', async () => {
    const view = await ready(open());
    const prefer = view.container.querySelector<HTMLElement>('[data-setting="preferences.prefer"]');
    const effort = view.container.querySelector<HTMLElement>('[data-setting="preferences.effort"]');
    expect(prefer?.textContent).toContain('Prefer');
    expect(prefer?.textContent).toContain('preferences.prefer');
    expect(prefer?.textContent).toContain(ALLOWED_MODELS_COPY.preferences.prefer.description);
    expect(effort?.textContent).toContain('Default effort');
    expect(effort?.textContent).toContain('preferences.effort');
    const select = (row: HTMLElement | null | undefined) =>
      row?.querySelector('select') as HTMLSelectElement;
    expect(select(prefer).selectedOptions[0]?.textContent).toBe('Neither');
    expect(select(effort).selectedOptions[0]?.textContent).toBe('High');
  });
});

describe('with a provider connected', () => {
  test('lists its models under its name, each ticked, with the identifier and what it can do', async () => {
    const view = await ready(open({ connected: true }));
    await view.findByRole('checkbox', { name: 'Claude Opus 5.5' });
    expect(view.getByRole('heading', { level: 3, name: 'Anthropic' })).not.toBeNull();
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-model]')];
    expect(rows.map((row) => row.dataset['model'])).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-5-5',
    ]);
    expect(rows[0]?.textContent).toContain('claude-opus-5-5');
    expect(rows[0]?.textContent).toContain('Tools · images');
    expect(rows[2]?.textContent).toContain('Tools');
    expect(rows[2]?.textContent).not.toContain('images');
    for (const checkbox of view.getAllByRole('checkbox')) {
      expect((checkbox as HTMLInputElement).checked).toBe(true);
    }
    expect(view.queryByTestId('allowed-models-empty')).toBeNull();
  });

  test('unticking a model shows the count and the effect, and Save sends the denial with the revision raised', async () => {
    const view = await ready(open({ connected: true }));
    const opus = await view.findByRole('checkbox', { name: 'Claude Opus 5.5' });
    await fireEvent.click(opus);
    const bar = await view.findByRole('group', { name: 'Form actions' });
    expect(bar.textContent).toContain('1 unsaved change');
    expect(bar.textContent).toContain(ALLOWED_MODELS_COPY.effect);
    expect(within(bar).getByRole('button', { name: ALLOWED_MODELS_COPY.reset })).not.toBeNull();
    // Nothing is sent until Save.
    expect(updates()).toHaveLength(0);

    await fireEvent.click(saveButton(view));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: {
        modelPolicy: {
          policyRevision: 2,
          deployment: { deniedModels: ['claude-opus-5-5'] },
          users: { [LOCAL_PROFILE]: { defaultEffort: 'high' } },
        },
      },
      expectedRevision: 3,
    });
    await waitFor(() =>
      expect(view.queryByRole('group', { name: 'Form actions' }) === null).toBe(true),
    );
    expect(
      (view.getByRole('checkbox', { name: 'Claude Opus 5.5' }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  test('shows a model the policy denies unticked, and ticking it again leaves no change', async () => {
    const view = await ready(
      open({
        connected: true,
        served: served(
          {},
          { ...SAMPLE_POLICY, deployment: { deniedModels: ['claude-haiku-5-5'] } },
        ),
      }),
    );
    const haiku = (await view.findByRole('checkbox', {
      name: 'Claude Haiku 5.5',
    })) as HTMLInputElement;
    expect(haiku.checked).toBe(false);
    await fireEvent.click(haiku);
    await view.findByRole('group', { name: 'Form actions' });
    await fireEvent.click(haiku);
    await waitFor(() =>
      expect(view.queryByRole('group', { name: 'Form actions' }) === null).toBe(true),
    );
    expect(updates()).toHaveLength(0);
  });

  test('keeps the fields of the policy the page has no control for when it saves', async () => {
    const view = await ready(
      open({
        connected: true,
        served: served(
          {},
          {
            ...SAMPLE_POLICY,
            deployment: { deniedRegions: ['eu'], requireDataPolicy: 'no-retention' },
          },
        ),
      }),
    );
    await fireEvent.click(await view.findByRole('checkbox', { name: 'Claude Sonnet 5.5' }));
    await fireEvent.click(saveButton(view));
    await waitFor(() => expect(updates()).toHaveLength(1));
    const patch = updates()[0]?.params as {
      patch: { modelPolicy: { deployment: Record<string, unknown> } };
    };
    expect(patch.patch.modelPolicy.deployment).toEqual({
      deniedRegions: ['eu'],
      requireDataPolicy: 'no-retention',
      deniedModels: ['claude-sonnet-5-5'],
    });
  });

  test('Reset to default puts the edits back, and sends nothing', async () => {
    const view = await ready(open({ connected: true }));
    await fireEvent.click(await view.findByRole('checkbox', { name: 'Claude Opus 5.5' }));
    await fireEvent.click(await view.findByRole('button', { name: ALLOWED_MODELS_COPY.reset }));
    await waitFor(() =>
      expect(view.queryByRole('group', { name: 'Form actions' }) === null).toBe(true),
    );
    expect(
      (view.getByRole('checkbox', { name: 'Claude Opus 5.5' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(updates()).toHaveLength(0);
  });

  test('a save that does not go through keeps the choices, says so above the buttons, and Save is the retry', async () => {
    const view = await ready(
      open({
        connected: true,
        extra: {
          'bureau.settings.update': () => {
            throw new Error('The server did not answer.');
          },
        },
      }),
    );
    const opus = (await view.findByRole('checkbox', {
      name: 'Claude Opus 5.5',
    })) as HTMLInputElement;
    await fireEvent.click(opus);
    await fireEvent.click(saveButton(view));
    const bar = await view.findByRole('group', { name: 'Form actions' });
    await waitFor(() => expect(bar.textContent).toContain(ALLOWED_MODELS_COPY.saveFailed.title));
    expect(bar.textContent).toContain(ALLOWED_MODELS_COPY.saveFailed.didNotAnswer);
    expect(bar.textContent).toContain(ALLOWED_MODELS_COPY.saveFailed.stillHere);
    expect(opus.checked).toBe(false);
    expect(
      (within(bar).getByRole('button', { name: ALLOWED_MODELS_COPY.save }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe('while a save is under way', () => {
  test('holds every control until the save and the settings read after it are done, so no edit is dropped', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const world = served();
    const view = await ready(
      open({
        connected: true,
        served: world,
        extra: {
          'bureau.settings.update': async (params) => {
            await held;
            world.values = {
              ...world.values,
              ...(params['patch'] as Record<string, unknown>),
            };
            world.revision += 1;
            return { revision: world.revision, pendingRestart: [] };
          },
        },
      }),
    );
    const opus = (await view.findByRole('checkbox', {
      name: 'Claude Opus 5.5',
    })) as HTMLInputElement;
    const sonnet = view.getByRole('checkbox', { name: 'Claude Sonnet 5.5' }) as HTMLInputElement;
    await fireEvent.click(opus);
    await fireEvent.click(saveButton(view));
    await waitFor(() => expect(updates()).toHaveLength(1));

    // An edit while the save is sent cannot be made, rather than made and then thrown away.
    expect(sonnet.disabled).toBe(true);
    for (const select of view.container.querySelectorAll('select')) {
      expect(select.disabled).toBe(true);
    }
    await fireEvent.click(sonnet);
    expect(sonnet.checked).toBe(true);

    release();
    await waitFor(() => expect(sonnet.disabled).toBe(false));
    expect(view.queryByRole('group', { name: 'Form actions' })).toBeNull();
    expect(opus.checked).toBe(false);
    expect(sonnet.checked).toBe(true);
  });
});

describe('the preferences', () => {
  test('Prefer and Default effort save together with the models in one Save, and count as two changes', async () => {
    const view = await ready(open({ connected: true }));
    await view.findByRole('checkbox', { name: 'Claude Opus 5.5' });
    const prefer = view.container.querySelector<HTMLElement>(
      '[data-setting="preferences.prefer"] select',
    );
    const effort = view.container.querySelector<HTMLElement>(
      '[data-setting="preferences.effort"] select',
    );
    await fireEvent.change(prefer as HTMLElement, { target: { value: 'speed' } });
    await fireEvent.change(effort as HTMLElement, { target: { value: 'low' } });
    const bar = await view.findByRole('group', { name: 'Form actions' });
    expect(bar.textContent).toContain('2 unsaved changes');

    await fireEvent.click(saveButton(view));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: {
        modelPolicy: {
          policyRevision: 2,
          users: { [LOCAL_PROFILE]: { defaultEffort: 'low', latencyPreference: 'lowest-latency' } },
        },
      },
      expectedRevision: 3,
    });
  });

  test('Prefer offers Neither, Lowest cost and Fastest, and reads a policy that holds both as its own choice', async () => {
    const view = await ready(open());
    const prefer = view.container.querySelector(
      '[data-setting="preferences.prefer"] select',
    ) as HTMLSelectElement;
    expect([...prefer.options].map((option) => option.textContent)).toEqual([
      'Neither',
      'Lowest cost',
      'Fastest',
    ]);
    cleanup();
    host?.restore();
    stub?.restore();
    const both = await ready(
      open({
        served: served(
          {},
          {
            policyRevision: 1,
            users: {
              [LOCAL_PROFILE]: {
                costPreference: 'lowest-cost',
                latencyPreference: 'lowest-latency',
              },
            },
          },
        ),
      }),
    );
    const select = both.container.querySelector(
      '[data-setting="preferences.prefer"] select',
    ) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe('Lowest cost and fastest');
  });

  test('a policy that sets no effort reads Not set, and a stored one leaves that choice out', async () => {
    const view = await ready(open({ served: served({}, { policyRevision: 0 }) }));
    const effort = view.container.querySelector(
      '[data-setting="preferences.effort"] select',
    ) as HTMLSelectElement;
    expect(effort.selectedOptions[0]?.textContent).toBe('Not set');
  });
});

describe('a host-locked policy', () => {
  test('says the host sets it and disables every control, with Save held back', async () => {
    const view = await ready(
      open({ connected: true, served: served({ locked: new Set(['modelPolicy']) }) }),
    );
    await view.findByRole('checkbox', { name: 'Claude Opus 5.5' });
    expect(view.container.textContent).toContain(ALLOWED_MODELS_COPY.lockedNote);
    for (const checkbox of view.getAllByRole('checkbox')) {
      expect((checkbox as HTMLInputElement).disabled).toBe(true);
    }
    for (const select of view.container.querySelectorAll('select')) {
      expect(select.disabled).toBe(true);
    }
  });
});

describe('the restart notice', () => {
  test('is the same banner as every other section, with Revert and Restart now', async () => {
    const view = await ready(
      open({
        served: served({ pendingRestart: new Set(['engine.workflowClaimRenewInterval']) }),
      }),
    );
    const banner = await view.findByTestId('settings-restart-summary');
    expect(banner.textContent).toContain('1 change waits for a restart');
    expect(banner.textContent).toContain('Workflow claim renew interval');
    expect(within(banner).getByRole('button', { name: 'Revert 1 change' })).not.toBeNull();
    expect(within(banner).getByRole('button', { name: 'Restart now' })).not.toBeNull();
    expect(banner.querySelector('.cinder-banner__dismiss')).toBeNull();
  });
});

describe('the shortcut', () => {
  test('⌘Enter saves from anywhere on the page, and is registered for this route only', async () => {
    const view = await ready(open({ connected: true }));
    await fireEvent.click(await view.findByRole('checkbox', { name: 'Claude Opus 5.5' }));
    await view.findByRole('group', { name: 'Form actions' });
    const press = (routePattern: string) =>
      shortcuts.handleKey(
        { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
        { routePattern, regions: [] },
        0,
      );
    expect(press('/settings')).toBe(false);
    expect(press('/settings/allowed-models')).toBe(true);
    await waitFor(() => expect(updates()).toHaveLength(1));
  });
});
