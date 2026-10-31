/**
 * The four counts on the Health overview, read through the page: a number is coloured only when
 * it is not zero and bad, a count whose scope the principal lacks shows a dash and leaves the
 * others alone, and Schedules counts the active schedules.
 */
import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import DashboardIndexHarness from './dashboard-index-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './dashboard-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const EMPTY_SUMMARY = {
  stuckQueued: 0,
  staleInflight: 0,
  retryStorms: 0,
  allWorkersAtCapacity: 0,
  deadLettered: 0,
  delayed: 0,
  unadoptedTerminal: 0,
};

/** An engine whose runs are `aggregate`, with nothing to diagnose, no reviews, and three schedules. */
function scriptedEngine(aggregate: unknown): ScriptedFetch {
  const fetch = new ScriptedFetch();
  fetch.routeUrl('/v1/health', { status: 'ok' });
  fetch.routeJsonRpcMethod('weft.workflows.aggregate', aggregate);
  fetch.routeJsonRpcMethod('weft.tasks.diagnostics', {
    items: [],
    summary: EMPTY_SUMMARY,
    limit: 50,
  });
  fetch.routeUrl('/v1/schedules', {
    items: [
      { id: 's-1', status: 'active' },
      { id: 's-2', status: 'active' },
      { id: 's-3', status: 'paused' },
    ],
    total: 3,
  });
  fetch.routeUrl('/reviews', { items: [] });
  return fetch;
}

function valueOf(container: Element, label: string): HTMLElement {
  const link = Array.from(container.querySelectorAll('.weft-health-count')).find(
    (candidate) => candidate.querySelector('.weft-health-count__label')?.textContent === label,
  );
  const value = link?.querySelector<HTMLElement>('.weft-health-count__value');
  if (!value) throw new Error(`no count named ${label}`);
  return value;
}

describe('the Health overview counts', () => {
  test('colour a number only when it is not zero and it is bad', async () => {
    scripted = scriptedEngine({
      total: 5,
      groups: [{ key: 'running', count: 5 }],
      truncated: false,
    });
    const { container } = render(DashboardIndexHarness, { props: { client: realClient() } });

    // The scripted aggregate answers every count with five, so Failed in 24h reads five too.
    await waitFor(() => expect(valueOf(container, 'Failed in 24h').textContent?.trim()).toBe('5'));
    expect(valueOf(container, 'Failed in 24h').dataset['tone']).toBe('danger');
    // Working now is five and plain: a running run is not a problem.
    expect(valueOf(container, 'Working now').textContent?.trim()).toBe('5');
    expect(valueOf(container, 'Working now').dataset['tone']).toBe('neutral');
  });

  test('leave a zero plain', async () => {
    // One completed run: the page is not empty, and nothing is running.
    scripted = scriptedEngine({
      total: 1,
      groups: [{ key: 'completed', count: 1 }],
      truncated: false,
    });
    const { container } = render(DashboardIndexHarness, { props: { client: realClient() } });

    await waitFor(() => expect(valueOf(container, 'Working now').textContent?.trim()).toBe('0'));
    expect(valueOf(container, 'Working now').dataset['tone']).toBe('neutral');
  });

  test('show a dash for a count whose scope the principal lacks, and read the others', async () => {
    scripted = scriptedEngine({
      total: 2,
      groups: [{ key: 'running', count: 2 }],
      truncated: false,
    });
    const scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES.filter(
      (scope) => scope !== 'schedules:read',
    );
    const { container } = render(DashboardIndexHarness, {
      props: { client: realClient(), scopes },
    });

    await waitFor(() => expect(valueOf(container, 'Working now').textContent?.trim()).toBe('2'));
    expect(valueOf(container, 'Schedules').textContent?.trim()).toBe('—');
  });

  test('count the active schedules, not the paused ones', async () => {
    scripted = scriptedEngine({
      total: 2,
      groups: [{ key: 'running', count: 2 }],
      truncated: false,
    });
    const { container } = render(DashboardIndexHarness, { props: { client: realClient() } });

    await waitFor(() => expect(valueOf(container, 'Schedules').textContent?.trim()).toBe('2'));
  });
});
