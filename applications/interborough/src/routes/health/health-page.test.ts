/**
 * Component tests for the Health page (`routes/health/index.svelte`): the engine's overview with
 * the diagnostics the System page held below it. Realms is listed only when the engine runs them.
 */
import { render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import SystemRouteTestHarness from '../system/system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from '../system/system-test-support.test-support.ts';
import HealthPage from './index.svelte';

let scripted: ScriptedFetch | undefined;

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

/** Gives the window a real origin, which `history.pushState` needs, then opens `path`. */
function openAt(path: string): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

beforeEach(() => openAt('/health'));

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const POOL = {
  name: 'checkout',
  revision: 'revision-a',
  revisionActive: true,
  realms: [{ state: 'active', realmGeneration: 'gen-1', restartCount: 0, pendingTurnCount: 2 }],
} as const;

/** A scripted engine whose overview is unreachable, so the page settles without its bands. */
function scriptedEngine(): ScriptedFetch {
  const fetch = new ScriptedFetch();
  fetch.routeUrlStatus('/v1/health', 503);
  fetch.routeSseStream('/v1/events/sse', []);
  fetch.routeJsonRpcMethod('weft.system.metrics', {});
  fetch.routeJsonRpcMethod('weft.system.lease', {
    mode: 'none',
    status: 'disabled',
    holdsLease: false,
  });
  return fetch;
}

function renderHealthPage() {
  return render(SystemRouteTestHarness, {
    props: { client: realClient(), queryClient: createQueryClient(), component: HealthPage },
  });
}

describe('Health page', () => {
  test('carries the engine overview, with the metrics, alerts, and health diagnostics below it', async () => {
    scripted = scriptedEngine();
    scripted.routeJsonRpcMethod('weft.realms.diagnostics', { pools: [] });
    const { findByRole, findAllByRole } = renderHealthPage();

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Health');
    expect(await findByRole('heading', { level: 2, name: 'Diagnostics' })).not.toBeNull();
    const tabs = await findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Metrics', 'Alerts', 'Health']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  });

  test('has no Realms tab for an engine that runs no realms', async () => {
    scripted = scriptedEngine();
    scripted.routeJsonRpcMethod('weft.realms.diagnostics', { pools: [] });
    const { findByRole, queryByRole } = renderHealthPage();

    await findByRole('tab', { name: 'Metrics' });
    const calls = scripted.calls;
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            typeof call.init?.body === 'string' &&
            call.init.body.includes('weft.realms.diagnostics'),
        ),
      ).toBe(true),
    );
    expect(queryByRole('tab', { name: 'Realms' })).toBeNull();
  });

  test('has a Realms tab for an engine that runs realms, and opens it from its address', async () => {
    openAt('/health?tab=realms');
    scripted = scriptedEngine();
    scripted.routeJsonRpcMethod('weft.realms.diagnostics', { pools: [POOL] });
    const { findAllByRole, findByRole } = renderHealthPage();

    const realms = await findByRole('tab', { name: 'Realms' });
    const tabs = await findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Metrics',
      'Alerts',
      'Health',
      'Realms',
    ]);
    expect(realms.getAttribute('aria-selected')).toBe('true');
  });

  test('has no Realms tab when the realm diagnostics cannot be read', async () => {
    scripted = scriptedEngine();
    scripted.routeUrlStatus('/jsonrpc', 403, 'Forbidden');
    scripted.routeJsonRpcMethod('weft.system.metrics', {});
    scripted.routeJsonRpcMethod('weft.system.lease', {
      mode: 'none',
      status: 'disabled',
      holdsLease: false,
    });
    const { findByRole, queryByRole } = renderHealthPage();

    await findByRole('tab', { name: 'Metrics' });
    expect(queryByRole('tab', { name: 'Realms' })).toBeNull();
  });

  test('carries the lease and recovery of the System page’s Health tab, and not its retention', async () => {
    openAt('/health?tab=health');
    scripted = scriptedEngine();
    scripted.routeJsonRpcMethod('weft.realms.diagnostics', { pools: [] });
    scripted.routeJsonRpcMethod('weft.system.registry', {
      registryVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflows: [],
      activeRevisions: {},
      activities: {},
    });
    const { findByRole, queryByText } = renderHealthPage();

    expect(await findByRole('heading', { name: 'Engine lease' })).not.toBeNull();
    expect(await findByRole('button', { name: 'Recover all' })).not.toBeNull();
    expect(queryByText('Sweep interval')).toBeNull();
  });
});
