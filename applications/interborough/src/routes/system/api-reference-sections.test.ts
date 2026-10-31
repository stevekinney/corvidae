/**
 * Component tests for Settings › API reference (`routes/settings/api-reference.svelte`), the
 * System page's tabs for what the engine exposes (plan §9.7). Covers URL-owned tab state: default
 * tab, switching tabs updates `?tab=`, and a deep link into a non-default tab renders that tab on
 * load. The tabs that moved to Health are covered by `routes/health/health-page.test.ts`.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import SettingsApiReference from '../settings/api-reference.svelte';
import type { RegistrySnapshotSource } from './registry-view.ts';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import {
  realClient,
  ScriptedFetch,
  withContractHashes,
} from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

/**
 * happy-dom's default `window.location` is `about:blank` (no origin), and
 * `history.pushState`/`replaceState` are silent no-ops from a non-hierarchical
 * origin — same convention `router.svelte.test.ts` (T1.3) establishes: give
 * the window a real origin before every test touches the reactive `router`
 * singleton.
 */
function resetLocation(path = '/settings/api-reference'): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => {
  resetLocation();
});

/** Puts back the `fetch` the last render scripted. */
function restoreScripted(): void {
  scripted?.restore();
  scripted = undefined;
}

afterEach(restoreScripted);

async function renderSystemRoute(
  registry: RegistrySnapshotSource = {
    registryVersion: 2,
    generatedAt: '2026-01-01T00:00:00.000Z',
    workflows: [],
    activeRevisions: {},
    activities: {},
  },
) {
  scripted = new ScriptedFetch();
  scripted.routeJsonRpcMethod('weft.system.registry', await withContractHashes(registry));
  // The "deep-linking to ?tab=alerts" test below mounts `<AlertsTab>`, which
  // subscribes to the harness's shared `FleetEventSource` on mount — an
  // open-ended stream avoids a real fetch failure driving a background
  // reconnect loop for the rest of the test (`ScriptedFetch.routeSseStream`'s
  // own doc: "stays open … never closes on its own").
  scripted.routeSseStream('/v1/events/sse', []);

  return render(SystemRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: SettingsApiReference,
    },
  });
}

describe('Settings › API reference', () => {
  test('defaults to the Workflow types tab when no ?tab= is present', async () => {
    const { findByRole } = await renderSystemRoute();
    const registryTrigger = await findByRole('tab', { name: 'Workflow types' });
    expect(registryTrigger.getAttribute('aria-selected')).toBe('true');
  });

  test('names every tab in words, and keeps the address each one had', async () => {
    const { findAllByRole, unmount } = await renderSystemRoute();

    const tabs = await findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Workflow types',
      'Discovery',
      'Operations',
      'Scopes',
    ]);
    unmount();
    // Each render installs its own scripted `fetch` over the last, so the one before is put back first.
    restoreScripted();

    // `registry` is what the first tab was called, and an address that names it still works.
    resetLocation('/settings/api-reference?tab=registry');
    const opened = await renderSystemRoute();
    const tab = await opened.findByRole('tab', { name: 'Workflow types' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    opened.unmount();
    restoreScripted();
  });

  test('clicking a tab updates the URL and renders that tab', async () => {
    const { findByRole } = await renderSystemRoute();

    await fireEvent.click(await findByRole('tab', { name: 'Scopes' }));

    expect(router.search.get('tab')).toBe('scopes');
    const scopesTrigger = await findByRole('tab', { name: 'Scopes' });
    expect(scopesTrigger.getAttribute('aria-selected')).toBe('true');
  });

  test('switching to Discovery and Operations mounts each tab panel', async () => {
    const { findByRole, findByText } = await renderSystemRoute();
    scripted?.routeUrl('/openapi.json', { paths: {} });
    scripted?.routeUrl('/openrpc.json', { methods: [] });
    scripted?.routeUrl('/asyncapi.json', { channels: {} });

    await fireEvent.click(await findByRole('tab', { name: 'Discovery' }));
    expect(await findByRole('radio', { name: 'OpenAPI' })).not.toBeNull();

    await fireEvent.click(await findByRole('tab', { name: 'Operations' }));
    expect(
      await findByText("Required scope isn't advertised by the discovery documents yet", {
        exact: false,
      }),
    ).not.toBeNull();
  });

  test('an unrecognized ?tab= value falls back to Workflow types rather than erroring', async () => {
    resetLocation('/settings/api-reference?tab=nonsense');
    const { findByRole } = await renderSystemRoute();
    const registryTrigger = await findByRole('tab', { name: 'Workflow types' });
    expect(registryTrigger.getAttribute('aria-selected')).toBe('true');
  });

  test('falls back to Workflow types for a tab that moved to Health', async () => {
    resetLocation('/settings/api-reference?tab=alerts');
    const { findByRole, queryByRole } = await renderSystemRoute();
    const registryTrigger = await findByRole('tab', { name: 'Workflow types' });
    expect(registryTrigger.getAttribute('aria-selected')).toBe('true');
    expect(queryByRole('tab', { name: 'Alerts' })).toBeNull();
  });

  test('renders public Cinder badges throughout the Registry route', async () => {
    const { findAllByText, findByRole, findByText } = await renderSystemRoute({
      registryVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflows: [
        {
          manifestVersion: 1,
          name: 'order-processing',
          workflowVersion: '1.0.0',
          revision: 'order-processing-rev',
          contractHash: 'order-processing-hash',
          contract: {
            name: 'order-processing',
            workflowVersion: '1.0.0',
            tags: ['payments'],
            inputSchema: {
              type: 'object',
              required: ['orderId'],
              properties: {
                note: { type: 'string' },
                orderId: { type: 'string' },
              },
            },
          },
        },
        {
          manifestVersion: 1,
          name: 'heartbeat',
          workflowVersion: '1.0.0',
          revision: 'heartbeat-rev',
          contractHash: 'heartbeat-hash',
          contract: { name: 'heartbeat', workflowVersion: '1.0.0' },
        },
      ],
      activeRevisions: {
        'order-processing': 'order-processing-rev',
        heartbeat: 'heartbeat-rev',
      },
      activities: {
        chargeCard: {
          queue: 'default',
          inputSchema: {
            type: 'object',
            properties: { amount: { type: 'number' } },
          },
        },
      },
    });

    const workflowFieldCountBadge = await findByText('2 fields');
    const noSchemaBadge = await findByText('none');
    const queueBadge = await findByText('queue: default');
    const activityFieldCountBadge = await findByText('1 field');
    expect(workflowFieldCountBadge.getAttribute('data-cinder-variant')).toBe('success');
    expect(noSchemaBadge.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(queueBadge.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(activityFieldCountBadge.getAttribute('data-cinder-variant')).toBe('success');

    await fireEvent.click(await findByRole('button', { name: /order-processing/ }));

    const typeBadges = await findAllByText('string');
    expect(typeBadges).toHaveLength(2);
    expect(typeBadges[0]?.getAttribute('data-cinder-monospace')).toBe('');
    const requiredBadge = await findByText('required');
    const optionalBadge = await findByText('optional');
    expect(requiredBadge.getAttribute('data-cinder-variant')).toBe('warning');
    expect(optionalBadge.getAttribute('data-cinder-variant')).toBe('neutral');
  });
});
