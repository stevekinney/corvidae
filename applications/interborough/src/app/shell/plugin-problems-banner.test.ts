/**
 * The banner every page shows after a startup where a plugin did not load (COR-1895): it counts
 * the plugins the host lists `skipped` and the folders it could not load a plugin from, and it can
 * be dismissed until the next startup.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from '../../routes/settings/plugins/plugins-host.test-support.ts';
import Harness from './plugin-problems-banner.test-harness.svelte';

let host: FakePluginHost | undefined;

afterEach(() => {
  cleanup();
  host?.restore();
  host = undefined;
});

const SKIPPED: PluginFixture = { name: 'linear', status: 'skipped' };
const UNLOADED: FakePluginHost['unloaded'][number] = {
  source: 'folder',
  location: '/home/.interborough/plugins/broken',
  status: 'skipped',
  problems: [{ code: 'load-failed', message: 'No plugin.ts.' }],
};

function mount(
  plugins: PluginFixture[],
  unloaded: FakePluginHost['unloaded'] = [],
  unreachable = false,
) {
  host = installFakePluginHost(plugins);
  host.unloaded = unloaded;
  const view = render(Harness, { props: { unreachable } } as never);
  const region = () =>
    view.container.querySelector<HTMLElement>('[data-testid="plugins-startup-banner"]');
  return { ...view, region };
}

describe('the plugins that did not load banner', () => {
  test('counts the plugins that were skipped and the folders that never became one', async () => {
    const { region } = mount(
      [{ name: 'anthropic' }, SKIPPED, { name: 'typesafe', status: 'skipped' }],
      [UNLOADED],
    );

    await waitFor(() => expect(region()).not.toBeNull());
    expect(region()?.textContent).toContain(
      '3 plugins didn’t load at startup. Agents and workflows that use them show as unavailable.',
    );
  });

  test('counts a folder with no descriptor when no plugin was skipped', async () => {
    const { region } = mount([{ name: 'anthropic' }], [UNLOADED]);

    await waitFor(() => expect(region()).not.toBeNull());
    expect(region()?.textContent).toContain(
      '1 plugin didn’t load at startup. Agents and workflows that use it show as unavailable.',
    );
  });

  test('is absent when every plugin loaded, whatever else is wrong with them', async () => {
    const { region } = mount([
      { name: 'anthropic' },
      { name: 'demo', enabled: false },
      { name: 'typesafe', status: 'needs-setup' },
    ]);

    await waitFor(() => expect(host?.requests.length).toBeGreaterThan(0));
    await waitFor(() => expect(region()).toBeNull());
  });

  test('is absent when the host cannot be read', async () => {
    host = installFakePluginHost([SKIPPED]);
    host.failReads = 1;
    const view = render(Harness, { props: { unreachable: false } } as never);

    await waitFor(() => expect(host?.requests.length).toBeGreaterThan(0));
    expect(view.container.querySelector('[data-testid="plugins-startup-banner"]')).toBeNull();
  });

  test('links to Settings › Plugins', async () => {
    const { region, getByRole } = mount([SKIPPED]);

    await waitFor(() => expect(region()).not.toBeNull());
    expect(getByRole('link', { name: 'Open Plugins' }).getAttribute('href')).toBe(
      '/settings/plugins',
    );
  });

  test('is dismissed until the next startup', async () => {
    const { region, getByRole, rerender } = mount([SKIPPED]);
    await waitFor(() => expect(region()).not.toBeNull());

    await fireEvent.click(getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(region()).toBeNull());

    // The same startup, reading the plugins again: still dismissed.
    await rerender({ unreachable: false });
    expect(region()).toBeNull();

    // The host stops answering and comes back: a new startup, and the plugin still did not load.
    await rerender({ unreachable: true });
    await rerender({ unreachable: false });
    await waitFor(() => expect(region()).not.toBeNull());
  });
});
