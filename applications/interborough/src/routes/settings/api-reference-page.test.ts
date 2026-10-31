/**
 * Component tests for Settings › API reference (`routes/settings/api-reference.svelte`): one page
 * with a side list of four groups (operations, discovery documents, your scopes, workflow
 * sources), not tabs. Covers URL-owned group state: the default group, a click updates `?group=`,
 * a deep link opens its group on load, an unknown value falls back, a failed read is an error in
 * its group and not an empty group, and each group renders from live data. What moved to Health is
 * covered by `routes/health/health-page.test.ts`.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import SystemRouteTestHarness from '../system/system-route-test-harness.test-harness.svelte';
import {
  realClient,
  ScriptedFetch,
  withContractHashes,
} from '../system/system-test-support.test-support.ts';
import SettingsApiReference from './api-reference.svelte';

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

const EMPTY_REGISTRY: RegistrySnapshotSource = {
  registryVersion: 2,
  generatedAt: '2026-01-01T00:00:00.000Z',
  workflows: [],
  activeRevisions: {},
  activities: {},
};

async function renderSystemRoute(
  configure: (fetch: ScriptedFetch) => void = () => {},
  registry: RegistrySnapshotSource = EMPTY_REGISTRY,
) {
  scripted = new ScriptedFetch();
  scripted.routeJsonRpcMethod('weft.system.registry', await withContractHashes(registry));
  // The sources group subscribes to the harness's shared `FleetEventSource` on mount — an
  // open-ended stream avoids a real fetch failure driving a background reconnect loop for the rest
  // of the test (`ScriptedFetch.routeSseStream`'s own doc: "stays open … never closes on its own").
  scripted.routeSseStream('/v1/events/sse', []);
  configure(scripted);

  return render(SystemRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: SettingsApiReference,
    },
  });
}

const DOCUMENTS = (fetch: ScriptedFetch): void => {
  fetch.routeUrl('/openapi.json', {
    paths: {
      '/api/v1/workflows': {
        get: { operationId: 'weft.workflows.list', summary: 'List workflows', tags: ['x'] },
      },
    },
  });
  fetch.routeUrl('/openrpc.json', {
    methods: [{ name: 'weft.workflows.list', summary: 'List workflows' }],
  });
  fetch.routeUrl('/asyncapi.json', { channels: {} });
};

describe('Settings › API reference', () => {
  test('lists the four groups in words, opens the first, and has no tab strip', async () => {
    const { findByRole, queryAllByRole } = await renderSystemRoute(DOCUMENTS);

    const list = await findByRole('navigation', { name: 'API reference groups' });
    const links = Array.from(list.querySelectorAll('a'));
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      'Operations',
      'Discovery documents',
      'Your scopes',
      'Workflow sources',
    ]);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[1]?.getAttribute('aria-current')).toBeNull();
    expect(queryAllByRole('tab')).toEqual([]);
    expect(queryAllByRole('tablist')).toEqual([]);
  });

  test('clicking a group updates the URL and renders that group', async () => {
    const { findByRole, findByText } = await renderSystemRoute(DOCUMENTS);

    await fireEvent.click(await findByRole('link', { name: 'Your scopes' }));

    expect(router.search.get('group')).toBe('scopes');
    expect(await findByText('Granted scopes')).not.toBeNull();
    const scopes = await findByRole('link', { name: 'Your scopes' });
    expect(scopes.getAttribute('aria-current')).toBe('page');
  });

  test('a deep link opens its group on load', async () => {
    resetLocation('/settings/api-reference?group=sources');
    const { findByRole } = await renderSystemRoute(DOCUMENTS);
    expect(await findByRole('region', { name: 'Workflow sources' })).not.toBeNull();
  });

  test('an unknown group opens Operations', async () => {
    resetLocation('/settings/api-reference?group=nonsense');
    const { findByRole, findByText } = await renderSystemRoute(DOCUMENTS);
    const operations = await findByRole('link', { name: 'Operations' });
    expect(operations.getAttribute('aria-current')).toBe('page');
    expect(await findByText('weft.workflows.list')).not.toBeNull();
  });

  test('the retired ?tab= address opens Operations too', async () => {
    resetLocation('/settings/api-reference?tab=registry');
    const { findByRole } = await renderSystemRoute(DOCUMENTS);
    const operations = await findByRole('link', { name: 'Operations' });
    expect(operations.getAttribute('aria-current')).toBe('page');
  });

  test('a failed read is an error in its group, and the side list stays', async () => {
    const { findByText, findAllByRole, queryByText } = await renderSystemRoute((fetch) => {
      fetch.routeUrlStatus('/openapi.json', 500, 'Internal Server Error');
      fetch.routeUrl('/openrpc.json', { methods: [] });
    });
    expect(await findByText('Something went wrong')).not.toBeNull();
    expect(queryByText('The discovery documents do not list', { exact: false })).toBeNull();
    const links = await findAllByRole('link');
    expect(links.map((link) => link.textContent?.trim())).toContain('Workflow sources');
  });

  test('Discovery documents opens the document the address names', async () => {
    resetLocation('/settings/api-reference?group=discovery&document=openrpc');
    const { findByRole } = await renderSystemRoute(DOCUMENTS);
    expect(await findByRole('table', { name: 'OpenRPC methods' })).not.toBeNull();
  });

  test('choosing another discovery document puts it in the address', async () => {
    resetLocation('/settings/api-reference?group=discovery');
    const { findByRole, findByText } = await renderSystemRoute(DOCUMENTS);
    await fireEvent.click(await findByRole('radio', { name: 'AsyncAPI' }));
    expect(router.search.get('group')).toBe('discovery');
    expect(router.search.get('document')).toBe('asyncapi');
    expect(await findByText('This document lists nothing')).not.toBeNull();
  });

  test('renders public Cinder badges throughout the Workflow sources group', async () => {
    resetLocation('/settings/api-reference?group=sources');
    const { findAllByText, findByRole, findByText } = await renderSystemRoute(undefined, {
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
