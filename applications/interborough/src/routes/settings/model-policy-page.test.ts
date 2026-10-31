/**
 * `/settings/model-policy`: the model policy in plain words, as Allowed models and Your preferences.
 * It is the `modelPolicy` setting, saved with the same `bureau.settings.update` as every other, with
 * the revision raised by the save and never typed. The Bureau is a stub
 * (`settings-fixtures.test-support.ts`); the real one is exercised by the Playwright suite.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { MODEL_POLICY_COPY, SETTINGS_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import { landAt } from '../chat/pages.test-support.ts';
import { LOCAL_PROFILE } from './model-policy-edit.ts';
import { installSettingsBureau, servedSettings } from './settings-fixtures.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(served = servedSettings()) {
  stub = installSettingsBureau(served);
  landAt('/settings/model-policy');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const updates = () => stub?.callsTo('bureau.settings.update') ?? [];

/** The control a label names: a list is labelled twice, by its input and by its tags. */
function field(
  query: (label: string) => HTMLElement[],
  label: string,
): HTMLInputElement & HTMLSelectElement {
  const control = query(label).find((element) => ['INPUT', 'SELECT'].includes(element.tagName));
  if (control === undefined) throw new Error(`No control named ${label}`);
  return control as HTMLInputElement & HTMLSelectElement;
}

async function addTag(input: HTMLElement, tag: string): Promise<void> {
  await fireEvent.input(input, { target: { value: tag } });
  await fireEvent.keyDown(input, { key: 'Enter' });
}

describe('Settings › Model policy', () => {
  test('has two sections in plain words, and never says deployment, Bureau or revision', async () => {
    const { container, findByRole } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });

    expect(
      [...container.querySelectorAll('h2')].map((heading) => heading.textContent?.trim()),
    ).toEqual([MODEL_POLICY_COPY.allowedModels.title, MODEL_POLICY_COPY.yourPreferences.title]);
    const text = container.textContent?.toLowerCase() ?? '';
    for (const word of ['deployment', 'bureau', 'revision', 'json']) {
      expect(text, word).not.toContain(word);
    }
    expect(container.querySelector('textarea')).toBeNull();
    // The nav names the section, and the page is one of Settings'.
    expect(container.querySelector('[data-page="settings-model-policy"]')).not.toBeNull();
  });

  test('writes what is not allowed to the shared layer, and raises the revision on save', async () => {
    const served = servedSettings({
      revision: 4,
      values: { ...servedSettings().values, modelPolicy: { policyRevision: 6 } },
    });
    const { container, findByRole, getAllByLabelText } = open(served);
    const group = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const save = within(group).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await addTag(field(getAllByLabelText, MODEL_POLICY_COPY.fields.deniedProviders), 'openai');
    await fireEvent.change(field(getAllByLabelText, MODEL_POLICY_COPY.fields.requireDataPolicy), {
      target: { value: 'no-retention' },
    });
    expect(
      container.querySelector('[data-setting="modelPolicy"]')?.getAttribute('data-dirty'),
    ).toBe('true');
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params).toEqual({
      patch: {
        modelPolicy: {
          deployment: { deniedProviders: ['openai'], requireDataPolicy: 'no-retention' },
          policyRevision: 7,
        },
      },
      expectedRevision: 4,
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-setting="modelPolicy"]')?.getAttribute('data-dirty'),
      ).toBe('false'),
    );
  });

  test('will not save while a list holds text that was typed and not added', async () => {
    const { container, findByRole, getAllByLabelText } = open(servedSettings({ revision: 4 }));
    const group = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const save = within(group).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    // Another edit is waiting, so the typed text is all that stands between the page and a save.
    await fireEvent.change(field(getAllByLabelText, MODEL_POLICY_COPY.fields.requireDataPolicy), {
      target: { value: 'no-retention' },
    });
    await waitFor(() => expect(save.disabled).toBe(false));

    const providers = field(getAllByLabelText, MODEL_POLICY_COPY.fields.deniedProviders);
    await fireEvent.input(providers, { target: { value: 'openai' } });
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(container.textContent).toContain(MODEL_POLICY_COPY.pendingEntry);
    await fireEvent.click(save);
    expect(updates()).toHaveLength(0);
    expect(container.textContent).not.toContain(SETTINGS_COPY.saved.title);

    // Clearing the text lets the save through without it.
    await fireEvent.input(providers, { target: { value: '' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(container.textContent).not.toContain(MODEL_POLICY_COPY.pendingEntry);

    // Adding it puts it in the policy that is saved.
    await addTag(providers, 'openai');
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({
      modelPolicy: {
        deployment: { deniedProviders: ['openai'], requireDataPolicy: 'no-retention' },
        policyRevision: 1,
      },
    });
  });

  test('writes the caller’s own preferences under their entry, and keeps the rest of the policy', async () => {
    const served = servedSettings({
      values: {
        ...servedSettings().values,
        modelPolicy: {
          policyRevision: 1,
          bureau: { deniedRegions: ['eu'] },
          users: { other: { dataPolicy: 'standard' } },
        },
      },
    });
    const { findByRole, getAllByLabelText } = open(served);
    const group = await findByRole('group', { name: SETTINGS_COPY.formLabel });

    await fireEvent.change(field(getAllByLabelText, MODEL_POLICY_COPY.fields.defaultEffort), {
      target: { value: 'high' },
    });
    await fireEvent.change(field(getAllByLabelText, MODEL_POLICY_COPY.fields.costPreference), {
      target: { value: 'lowest-cost' },
    });
    const save = within(group).getByRole('button', {
      name: SETTINGS_COPY.saveAction,
    }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({
      modelPolicy: {
        policyRevision: 2,
        bureau: { deniedRegions: ['eu'] },
        users: {
          other: { dataPolicy: 'standard' },
          [LOCAL_PROFILE]: { defaultEffort: 'high', costPreference: 'lowest-cost' },
        },
      },
    });
  });

  test('is no change at all once an edit is put back', async () => {
    const { container, findByRole, getAllByLabelText } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const select = field(getAllByLabelText, MODEL_POLICY_COPY.fields.dataPolicy);
    const section = () => container.querySelector('[data-setting="modelPolicy"]');

    await fireEvent.change(select, { target: { value: 'standard' } });
    expect(section()?.getAttribute('data-dirty')).toBe('true');
    await fireEvent.change(select, { target: { value: '' } });
    expect(section()?.getAttribute('data-dirty')).toBe('false');
  });

  test('takes only a provider’s name where a provider is named', async () => {
    const { findByRole, getAllByLabelText } = open();
    const group = await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const input = field(getAllByLabelText, MODEL_POLICY_COPY.fields.deniedProviders);
    await addTag(input, 'Not A Provider');
    expect(
      (within(group).getByRole('button', { name: SETTINGS_COPY.saveAction }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(group.textContent).toContain(MODEL_POLICY_COPY.providerName);
  });

  test('is read-only, and says why, when the host sets the policy', async () => {
    const { container, findByRole, getAllByLabelText } = open(
      servedSettings({ locked: new Set(['modelPolicy']) }),
    );
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    expect(container.textContent).toContain(MODEL_POLICY_COPY.lockedNote);
    expect(
      (field(getAllByLabelText, MODEL_POLICY_COPY.fields.defaultEffort) as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect(
      (field(getAllByLabelText, MODEL_POLICY_COPY.fields.deniedProviders) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  test('saves on ⌘Enter from this section’s own route, and not from General’s', async () => {
    const { findByRole, getAllByLabelText } = open();
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    await fireEvent.change(field(getAllByLabelText, MODEL_POLICY_COPY.fields.defaultEffort), {
      target: { value: 'low' },
    });
    const press = (routePattern: string) =>
      shortcuts.handleKey(
        { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
        { routePattern, regions: [] },
        0,
      );
    expect(press('/settings')).toBe(false);
    expect(press('/settings/model-policy')).toBe(true);
    await waitFor(() => expect(updates()).toHaveLength(1));
  });
});
