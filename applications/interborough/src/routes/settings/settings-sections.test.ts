/**
 * The sections of Settings (COR-1837): the section navigation lists General, Models, Model policy, Data and retention, and
 * API reference, marks the one that is open, and moves between them; Data and retention carries the
 * retention overview and API reference carries the server's reference groups.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Component } from 'svelte';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import SystemRouteTestHarness from '../system/system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from '../system/system-test-support.test-support.ts';
import ApiReference from './api-reference.svelte';
import DataAndRetention from './data-and-retention.svelte';
import SettingsSectionNav from './settings-section-nav.svelte';
import { SETTINGS_SECTIONS } from './settings-sections.ts';

let scripted: ScriptedFetch | undefined;

/** Gives the window a real origin, which `history.pushState` needs, then opens `path`. */
function openAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => openAt('/settings/data-and-retention'));

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function renderInHarness(component: Component) {
  return render(SystemRouteTestHarness, {
    props: { client: realClient(), queryClient: createQueryClient(), component },
  });
}

describe('the section navigation', () => {
  test('lists every section in order, each linking to its own route', () => {
    const { getByRole } = render(SettingsSectionNav);
    const links = [...getByRole('navigation', { name: 'Settings sections' }).querySelectorAll('a')];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      'General',
      'Models',
      'Model policy',
      'Plugins',
      'Data and retention',
      'API reference',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      SETTINGS_SECTIONS.map((section) => section.path),
    );
    expect(SETTINGS_SECTIONS.map((section) => section.path)).toEqual([
      '/settings',
      '/settings/models',
      '/settings/model-policy',
      '/settings/plugins',
      '/settings/data-and-retention',
      '/settings/api-reference',
    ]);
  });

  test('marks the open section as the current page, and only that one', () => {
    const { getByRole } = render(SettingsSectionNav);
    const current = [...getByRole('navigation').querySelectorAll('a[aria-current="page"]')];
    expect(current.map((link) => link.textContent?.trim())).toEqual(['Data and retention']);
  });

  test('opens a section in the client router when its link is clicked', async () => {
    const { getByRole } = render(SettingsSectionNav);
    await fireEvent.click(getByRole('link', { name: 'API reference' }));
    expect(router.pathname).toBe('/settings/api-reference');
  });
});

describe('Settings › Data and retention', () => {
  test('names itself, carries the section navigation, and shows the retention overview', async () => {
    scripted = new ScriptedFetch();
    scripted.routeUrl('/retention', {
      defaultRetention: null,
      sweepIntervalMs: 300000,
      sweepBatchSize: 1000,
      nextSweepAt: null,
      workflowTypes: [],
    });
    const { findByRole, findByText } = renderInHarness(DataAndRetention);

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Data and retention');
    expect(await findByRole('navigation', { name: 'Settings sections' })).not.toBeNull();
    expect(await findByText('Sweep interval')).not.toBeNull();
    expect(await findByText('300000ms')).not.toBeNull();
  });
});

describe('Settings › API reference', () => {
  test('names itself, carries the section navigation, and lists the reference groups', async () => {
    openAt('/settings/api-reference');
    scripted = new ScriptedFetch();
    scripted.routeSseStream('/v1/events/sse', []);
    scripted.routeJsonRpcMethod('weft.system.registry', {
      registryVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflows: [],
      activeRevisions: {},
      activities: {},
    });
    const { findByRole, queryAllByRole } = renderInHarness(ApiReference);

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('API reference');
    expect(await findByRole('navigation', { name: 'Settings sections' })).not.toBeNull();
    const groups = await findByRole('navigation', { name: 'API reference groups' });
    expect(
      Array.from(groups.querySelectorAll('a')).map((link) => link.textContent?.trim()),
    ).toEqual(['Operations', 'Discovery documents', 'Your scopes', 'Workflow sources']);
    expect(queryAllByRole('tab')).toEqual([]);
  });
});
