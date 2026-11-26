/**
 * `<PluginProblemCard>` (COR-1895): one card per problem code, with the status, title, body and
 * action of the owner's table (Interborough plugins, boards 26–28). The words are written out here,
 * not read from `copy.ts`, so a change to the copy has to change a test too.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { PluginProblem } from '../../../lib/host-plugins.ts';
import Harness from './plugin-problem-card.test-harness.svelte';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
});

/**
 * Stands in for the two places Cinder's `copyToClipboard` writes: the native Async Clipboard API
 * (`native`) and the `document.execCommand('copy')` fallback (`legacy`, which records the text of
 * the textarea it selects). The helper's own cases are tested in Cinder.
 */
function stubClipboard(behavior: {
  native: 'accepts' | 'rejects' | 'unavailable';
  legacy: 'unused' | 'succeeds' | 'returns-false' | 'throws';
}) {
  const nativeWrites: string[] = [];
  const legacyCopies: string[] = [];
  if (behavior.native === 'unavailable') {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          nativeWrites.push(text);
          if (behavior.native === 'rejects') throw new Error('denied');
        },
      },
    });
  }
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (command: string) => {
      expect(command).toBe('copy');
      legacyCopies.push(document.querySelector('textarea')?.value ?? '');
      if (behavior.legacy === 'throws') throw new Error('not allowed');
      return behavior.legacy === 'succeeds';
    },
  });
  return { nativeWrites, legacyCopies };
}

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
      'gemini-api-key isn’t saved, so gemini:chat, gemini:embed are unavailable. Save it and they work at once, with no restart.',
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
    expect(root.textContent).toContain('Team key must be 2 to 5 capital letters. You entered cor.');
    // The field's key is a name in the plugin's code, not words a person reads.
    expect(root.textContent).not.toContain('teamKey');
    await fireEvent.click(getByRole('button', { name: 'Fix the setting' }));
    expect(onFixSetting).toHaveBeenCalledTimes(1);
  });

  test('configuration-invalid puts the field’s name, never its key, before a message that lacks one', () => {
    const { root } = card({
      code: 'configuration-invalid',
      field: 'groundingThreshold',
      message: 'Too small: expected number to be >=0',
    });

    expect(root.textContent).toContain('Grounding threshold: Too small: expected number to be >=0');
    expect(root.textContent).not.toContain('groundingThreshold');
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
    const clipboard = stubClipboard({ native: 'accepts', legacy: 'unused' });
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
    expect(clipboard.nativeWrites).toEqual(['~/code/linear-plugin']);
    expect(clipboard.legacyCopies).toEqual([]);
    expect(await findByText('The folder’s path is copied.')).not.toBeNull();
  });

  describe('the folder’s path, through the Cinder clipboard helper', () => {
    test('is copied by the fallback when the native write rejects, with the original text', async () => {
      const clipboard = stubClipboard({ native: 'rejects', legacy: 'succeeds' });
      const { getByRole, findByText, queryByText } = card({
        code: 'development-source',
        path: '/code/x y',
      });

      await fireEvent.click(getByRole('button', { name: 'Open the folder' }));
      expect(clipboard.nativeWrites).toEqual(['/code/x y']);
      expect(clipboard.legacyCopies).toEqual(['/code/x y']);
      expect(await findByText('The folder’s path is copied.')).not.toBeNull();
      expect(queryByText('The folder’s path could not be copied.')).toBeNull();
    });

    test('is copied by the fallback when the clipboard API is unavailable', async () => {
      const clipboard = stubClipboard({ native: 'unavailable', legacy: 'succeeds' });
      const { getByRole, findByText } = card({ code: 'development-source', path: '/code/x' });

      await fireEvent.click(getByRole('button', { name: 'Open the folder' }));
      expect(clipboard.nativeWrites).toEqual([]);
      expect(clipboard.legacyCopies).toEqual(['/code/x']);
      expect(await findByText('The folder’s path is copied.')).not.toBeNull();
    });

    test.each([
      ['the fallback reports failure', 'returns-false'],
      ['the fallback throws', 'throws'],
    ] as const)('says so when the native write rejects and %s', async (_name, legacy) => {
      const clipboard = stubClipboard({ native: 'rejects', legacy });
      const { getByRole, findByText, queryByText } = card({
        code: 'development-source',
        path: '/code/x',
      });

      await fireEvent.click(getByRole('button', { name: 'Open the folder' }));
      expect(await findByText('The folder’s path could not be copied.')).not.toBeNull();
      expect(clipboard.legacyCopies).toEqual(['/code/x']);
      expect(queryByText('The folder’s path is copied.')).toBeNull();
    });

    test('says so when the clipboard API is unavailable and the fallback fails', async () => {
      stubClipboard({ native: 'unavailable', legacy: 'returns-false' });
      const { getByRole, findByText, queryByText } = card({
        code: 'development-source',
        path: '/code/x',
      });

      await fireEvent.click(getByRole('button', { name: 'Open the folder' }));
      expect(await findByText('The folder’s path could not be copied.')).not.toBeNull();
      expect(queryByText('The folder’s path is copied.')).toBeNull();
    });
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

  test('panel-changed shows the panel’s title, or its identifier in monospace when it has none (COR-2213)', () => {
    const changed = (app: string) => ({
      code: 'panel-changed',
      app,
      uri: 'ui://inspectors/x/v1',
      previousDigest: 'sha256:old',
      contentDigest: 'sha256:new',
    });
    const plugin = {
      descriptor: { name: 'inspectors' },
      contributions: [
        {
          kind: 'panel',
          id: 'inspectors:workflow-revision-review',
          title: 'Review workflow revision',
        },
      ],
    };
    const titled = card(changed('workflow-revision-review'), { plugin });
    expect(titled.root.textContent).toContain('The panel Review workflow revision serves');
    expect(titled.root.textContent).not.toContain('workflow-revision-review');
    expect(titled.root.querySelector('code')).toBeNull();
    cleanup();
    const untitled = card(changed('untitled'), { plugin });
    expect(untitled.root.querySelector('code')?.textContent).toBe('untitled');
    expect(untitled.root.textContent).toContain('The panel untitled serves');
  });

  test('start-failed keeps the plugin loaded', () => {
    const { root } = card({ code: 'start-failed', message: 'Connection refused.' });
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
    expect(root.textContent).toContain('Models: No current model of anthropic matches "sonet".');
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
