/**
 * `<PluginProblemCard>` (COR-1895): one card per problem code, with the status, title, body and
 * action of the owner's table (Interborough plugins, boards 26–28). The words are written out here,
 * not read from `copy.ts`, so a change to the copy has to change a test too.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { PluginProblem } from '../../../lib/host-plugins.ts';
import Harness from './plugin-problem-card.test-harness.svelte';

afterEach(() => cleanup());

function card(problem: PluginProblem, extra: Record<string, unknown> = {}) {
  const view = render(Harness, { props: { problem, ...extra } } as never);
  const root = view.container.querySelector<HTMLElement>('[data-plugin-problem]');
  expect(root).not.toBeNull();
  return { ...view, root: root! };
}

describe('the six cards of the table', () => {
  test('secret-missing', async () => {
    const onSecret = mock((_key: string) => undefined);
    const { root, getByRole } = card(
      {
        code: 'secret-missing',
        key: 'gemini-api-key',
        contributions: ['gemini:chat', 'gemini:embed'],
      },
      { onSecret },
    );

    expect(root.getAttribute('data-plugin-problem')).toBe('secret-missing');
    expect(root.textContent).toContain('Needs setup');
    expect(root.textContent).toContain('A secret isn’t saved yet');
    expect(root.textContent).toContain(
      'gemini-api-key isn’t saved, so gemini:chat, gemini:embed is unavailable. Save it and it works at once; no restart.',
    );
    await fireEvent.click(getByRole('button', { name: 'Add the key' }));
    expect(onSecret).toHaveBeenCalledWith('gemini-api-key');
  });

  test('secret-missing is held back while the host keeps its secrets in its deployment', () => {
    const { getByRole } = card(
      { code: 'secret-missing', key: 'k', contributions: ['a:b'] },
      { onSecret: () => undefined, locked: true },
    );
    expect(getByRole('button', { name: 'Add the key' }).hasAttribute('disabled')).toBe(true);
  });

  test('configuration-invalid', async () => {
    const onFixSetting = mock(() => undefined);
    const { root, getByRole } = card(
      {
        code: 'configuration-invalid',
        field: 'teamKey',
        message: 'Team key must be 2 to 5 capital letters. You entered cor.',
      },
      { onFixSetting },
    );

    expect(root.textContent).toContain('Not loaded');
    expect(root.textContent).toContain('A setting is invalid');
    expect(root.textContent).toContain(
      'teamKey: Team key must be 2 to 5 capital letters. You entered cor.',
    );
    await fireEvent.click(getByRole('button', { name: 'Fix the setting' }));
    expect(onFixSetting).toHaveBeenCalledTimes(1);
  });

  test('reference-unresolved', () => {
    const { root, getByRole } = card({
      code: 'reference-unresolved',
      file: 'linear:triager',
      id: 'linear:create-isue',
    });

    expect(root.textContent).toContain('Loaded, 1 file skipped');
    expect(root.textContent).toContain('An agent names something nobody adds');
    expect(root.textContent).toContain(
      'linear:triager lists linear:create-isue, which no loaded plugin adds. The agent is unavailable until the name matches.',
    );
    expect(getByRole('link', { name: 'Open the file' }).getAttribute('href')).toBe(
      '/agents/linear%3Atriager/edit',
    );
  });

  test('name-clash between a package and a folder', async () => {
    const onShowBoth = mock(() => undefined);
    const { root, getByRole } = card(
      {
        code: 'name-clash',
        name: 'linear',
        first: { source: 'package', location: '@lostgradient/plugin-linear' },
        second: { source: 'folder', location: 'plugins/linear' },
      },
      { onShowBoth },
    );

    expect(root.textContent).toContain('Not loaded');
    expect(root.textContent).toContain('Two plugins share a name');
    expect(root.textContent).toContain(
      'The package @lostgradient/plugin-linear and the folder plugins/linear are both named linear. The package @lostgradient/plugin-linear loaded; rename the other.',
    );
    await fireEvent.click(getByRole('button', { name: 'Show both' }));
    expect(onShowBoth).toHaveBeenCalledTimes(1);
  });

  test('name-clash words a built-in plugin by its name', () => {
    const { root } = card({
      code: 'name-clash',
      name: 'bureau',
      first: { source: 'built-in', location: '@lostgradient/bureau' },
      second: { source: 'folder', location: 'plugins/bureau' },
    });
    expect(root.textContent).toContain(
      'The built-in bureau plugin and the folder plugins/bureau are both named bureau. The built-in bureau plugin loaded; rename the other.',
    );
  });

  test('pinned-version-unavailable, for one waiting run and for several', () => {
    const one = card({
      code: 'pinned-version-unavailable',
      id: 'linear:sync-issue',
      version: '0.3.0',
      waitingRuns: 1,
    });
    expect(one.root.textContent).toContain('After a restart');
    expect(one.root.textContent).toContain('A waiting run needs a version that isn’t loaded');
    expect(one.root.textContent).toContain(
      '1 waiting run is pinned to linear:sync-issue@0.3.0, so it shows as unavailable. Cancel it, or go back to 0.3.0 and restart.',
    );
    expect(one.getByRole('link', { name: 'Open the run' }).getAttribute('href')).toBe('/runs');
    cleanup();

    const many = card({
      code: 'pinned-version-unavailable',
      id: 'linear:sync-issue',
      version: '0.3.0',
      waitingRuns: 3,
    });
    expect(many.root.textContent).toContain(
      '3 waiting runs are pinned to linear:sync-issue@0.3.0, so they show as unavailable. Cancel them, or go back to 0.3.0 and restart.',
    );
  });

  test('development-source copies the folder’s path, because a browser cannot open a folder', async () => {
    const writeText = mock(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { root, getByRole, findByText } = card({
      code: 'development-source',
      path: '~/code/linear-plugin',
    });

    expect(root.textContent).toContain('Development');
    expect(root.textContent).toContain('Loaded from your working copy');
    expect(root.textContent).toContain(
      'Started with --plugin ~/code/linear-plugin. Interborough restarts when its code changes; its agents and workflows reload without one.',
    );
    await fireEvent.click(getByRole('button', { name: 'Open the folder' }));
    expect(writeText).toHaveBeenCalledWith('~/code/linear-plugin');
    expect(await findByText('The folder’s path is copied.')).not.toBeNull();
  });

  test('development-source says so when the path cannot be copied', async () => {
    const writeText = mock(async (_text: string) => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { getByRole, findByText } = card({ code: 'development-source', path: '/code/x' });

    await fireEvent.click(getByRole('button', { name: 'Open the folder' }));
    expect(await findByText('The folder’s path could not be copied.')).not.toBeNull();
  });
});

describe('the cards for the codes the host added', () => {
  test('secret-refused words the host’s message and has no button', () => {
    const { root } = card({
      code: 'secret-refused',
      key: 'approval-secret',
      message: 'Plugin "x" declares the secret "approval-secret", which the host keeps for itself.',
    });
    expect(root.textContent).toContain('Not loaded');
    expect(root.textContent).toContain('A secret can’t be kept here');
    expect(root.textContent).toContain(
      'Plugin "x" declares the secret "approval-secret", which the host keeps for itself.',
    );
    expect(root.querySelector('button, a')).toBeNull();
  });

  test('secret-refused names the key when the host sent no message', () => {
    const { root } = card({ code: 'secret-refused', key: 'approval-secret' });
    expect(root.textContent).toContain('approval-secret can’t be used as this plugin’s secret.');
  });

  test('load-failed', () => {
    const { root } = card({
      code: 'load-failed',
      message: 'Cannot find package "left-pad" imported from plugins/x/plugin.ts.',
    });
    expect(root.textContent).toContain('Not loaded');
    expect(root.textContent).toContain('The plugin’s code didn’t load');
    expect(root.textContent).toContain(
      'Cannot find package "left-pad" imported from plugins/x/plugin.ts.',
    );
    expect(root.querySelector('button, a')).toBeNull();
  });

  test('setup-failed', () => {
    const { root } = card({ code: 'setup-failed', message: 'The team key is required.' });
    expect(root.textContent).toContain('Not loaded');
    expect(root.textContent).toContain('The plugin’s setup failed');
    expect(root.textContent).toContain('The team key is required.');
  });

  test('after-start-failed keeps the plugin loaded', () => {
    const { root } = card({ code: 'after-start-failed', message: 'Connection refused.' });
    expect(root.textContent).toContain('Loaded, a step after startup failed');
    expect(root.textContent).toContain('A step after startup failed');
    expect(root.textContent).toContain('Connection refused.');
  });

  test('configuration-invalid on a provider’s model list has its own title', async () => {
    const onFixSetting = mock(() => undefined);
    const { root, getByRole } = card(
      {
        code: 'configuration-invalid',
        field: 'models[1]',
        message: 'No current model of anthropic matches "sonet".',
      },
      { onFixSetting },
    );
    expect(root.textContent).toContain('Not loaded');
    expect(root.textContent).toContain('A model list names a model nobody offers');
    expect(root.textContent).toContain('models[1]: No current model of anthropic matches "sonet".');
    await fireEvent.click(getByRole('button', { name: 'Fix the setting' }));
    expect(onFixSetting).toHaveBeenCalledTimes(1);
  });

  test('a code this page has no words for still lists, with the code', () => {
    const { root } = card({ code: 'brand-new-code' });
    expect(root.textContent).toContain('Needs attention');
    expect(root.textContent).toContain('Reported as brand-new-code.');
    expect(root.querySelector('button, a')).toBeNull();
  });
});

describe('actions the page has not given the card', () => {
  test('a button for something the page did not wire is not drawn', async () => {
    const { root } = card({ code: 'name-clash', name: 'x', first: {}, second: {} });
    await waitFor(() => expect(root.textContent).toContain('Two plugins share a name'));
    expect(root.querySelector('button')).toBeNull();
  });
});
