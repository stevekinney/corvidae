/**
 * The edits of `/settings` that a field makes through Cinder's own controls (COR-1842 review round
 * 1): what a `SchemaForm` hands back when a field is only focused, a number that is still being
 * typed, the options of `tools.humanInput`, and the one save a key press may make. The Bureau is
 * a stub (`settings-fixtures.test-support.ts`).
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { SETTINGS_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { shortcuts } from '../../lib/shortcuts.ts';
import { landAt } from '../chat/pages.test-support.ts';
import {
  installSettingsBureau,
  servedSettings,
  SETTING_VALUES,
  type SettingsServed,
} from './settings-fixtures.test-support.ts';

let stub: BureauStub | undefined;
let removeShellKeys: (() => void) | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  removeShellKeys?.();
  removeShellKeys = undefined;
});

function open(served: SettingsServed) {
  stub = installSettingsBureau(served);
  landAt('/settings');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const row = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-setting="${key}"]`);
const updates = () => stub?.callsTo('bureau.settings.update') ?? [];

/** Reads every key press against the shortcut registry as the shell does (`shell.svelte`). */
function readKeysLikeTheShell(): void {
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented && !event.metaKey && !event.ctrlKey) return;
    const handled = shortcuts.handleKey(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        editable: true,
      },
      { routePattern: '/settings', regions: [] },
      Date.now(),
    );
    if (handled) event.preventDefault();
  };
  window.addEventListener('keydown', onKeydown);
  removeShellKeys = () => window.removeEventListener('keydown', onKeydown);
}

function without(...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(SETTING_VALUES).filter(([key]) => !keys.includes(key)));
}

const saveButton = (container: HTMLElement) =>
  within(container).getByRole('button', { name: SETTINGS_COPY.saveAction }) as HTMLButtonElement;

describe('the options of tools.humanInput', () => {
  const STORED = { inputSchemas: { environment: { type: 'string' } } };

  test('keep the stored answer schemas when the switch is turned off and on again', async () => {
    const { container, findByRole } = open(
      servedSettings({ values: { ...SETTING_VALUES, 'tools.humanInput': STORED } }),
    );
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const humanInput = row(container, 'tools.humanInput');
    const toggle = () => humanInput?.querySelector('button[role="switch"]') as HTMLElement;

    await fireEvent.click(toggle());
    expect(humanInput?.querySelector('textarea')).toBeNull();
    await fireEvent.click(toggle());

    const editor = humanInput?.querySelector('textarea') as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual(STORED);
    expect(humanInput?.dataset['dirty']).toBe('false');
    expect(saveButton(container).disabled).toBe(true);
  });

  test('are set as JSON, with no form and no choice between false and an object', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const humanInput = row(container, 'tools.humanInput');
    expect(humanInput?.querySelector('form')).toBeNull();
    expect(humanInput?.textContent).not.toContain('Object');

    const editor = humanInput?.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: JSON.stringify(STORED) } });
    await waitFor(() => expect(saveButton(container).disabled).toBe(false));
    await fireEvent.click(saveButton(container));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'tools.humanInput': STORED });
  });
});

describe('an object a form only had a field focused in', () => {
  test('is no edit for a setting that had no value, and can go back to Not set', async () => {
    const { container, findByRole } = open(servedSettings({ values: without('engine.history') }));
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const history = row(container, 'engine.history') as HTMLElement;
    await fireEvent.click(within(history).getByRole('button', { name: SETTINGS_COPY.setAction }));
    const field = history.querySelector('input') as HTMLInputElement;
    await fireEvent.focus(field);
    await fireEvent.blur(field);

    expect(history.dataset['dirty']).toBe('false');
    expect(saveButton(container).disabled).toBe(true);

    // Typing something is an edit, and Not set undoes it before it is saved.
    await fireEvent.input(field, { target: { value: '5' } });
    await fireEvent.blur(field);
    await waitFor(() => expect(history.dataset['dirty']).toBe('true'));
    await fireEvent.click(within(history).getByRole('button', { name: SETTINGS_COPY.unsetAction }));
    expect(history.querySelector('input')).toBeNull();
    expect(history.dataset['dirty']).toBe('false');
    expect(within(history).getByRole('button', { name: SETTINGS_COPY.setAction })).not.toBeNull();
    expect(saveButton(container).disabled).toBe(true);
  });

  test('is no edit for a limit the Bureau holds as null', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const payload = row(container, 'engine.payloadSize') as HTMLElement;
    const field = payload.querySelector('input') as HTMLInputElement;
    await fireEvent.focus(field);
    await fireEvent.blur(field);

    expect(payload.dataset['dirty']).toBe('false');
    expect(saveButton(container).disabled).toBe(true);
  });
});

describe('a number typed into a form', () => {
  test('is neither an error nor saved until it commits', async () => {
    const { container, findByRole } = open(servedSettings());
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    const history = row(container, 'engine.history') as HTMLElement;
    const field = history.querySelector('input') as HTMLInputElement;
    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: '12' } });
    // What the schema check would say about the text arrives after it has run.
    await quietFor(50);

    expect(history.querySelector('[role="alert"]')).toBeNull();
    expect(history.textContent).not.toContain('must be integer');
    expect(saveButton(container).disabled).toBe(true);

    await fireEvent.blur(field);
    await waitFor(() => expect(saveButton(container).disabled).toBe(false));
    await fireEvent.click(saveButton(container));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'engine.history': { maxEvents: 12 } });
  });
});

describe('⌘Enter in a number field of a form', () => {
  test('makes one save, though the field submits its form and the shell runs the shortcut', async () => {
    const { container, findByRole } = open(servedSettings({ revision: 9 }));
    await findByRole('group', { name: SETTINGS_COPY.formLabel });
    readKeysLikeTheShell();
    const field = row(container, 'engine.history')?.querySelector('input') as HTMLInputElement;
    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: '12' } });
    await fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(updates()).toHaveLength(1));
    // Everything the key press set going has had its turn: a second save would be here by now.
    await waitFor(() => expect(row(container, 'engine.history')?.dataset['dirty']).toBe('false'));
    expect(updates()).toHaveLength(1);
    expect(updates()[0]?.params).toEqual({
      patch: { 'engine.history': { maxEvents: 12 } },
      expectedRevision: 9,
    });
  });
});
