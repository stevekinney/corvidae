/**
 * The run detail page's attributes, streams and updates sections, by the scopes the principal holds
 * (COR-1461, COR-1462, COR-1463): each section draws only for a principal who may read what it shows,
 * and offers the write that goes with it only to one who may make it. The sections' own behavior is
 * tested beside them; this is the page deciding which to draw.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { QueryClient } from '@tanstack/svelte-query';
import { render } from '@testing-library/svelte';

import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type Principal } from '../../../lib/scopes.svelte.ts';
import { realClient, ScriptedFetch } from '../list/workflow-test-support.test-support.ts';
import WorkflowDetailHarness from './workflow-detail.test-harness.svelte';

function principalWith(...scopes: Principal['scopes']): Principal {
  return { scopes, unauthenticatedAccess: null };
}

const ALL_BUT = (...withheld: Principal['scopes']): Principal =>
  principalWith(...AUTHORIZATION_SCOPES.filter((scope) => !withheld.includes(scope)));

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window))
    throw new Error('expected the test window to be backed by happy-dom');
  return window.happyDOM;
}

function resetLocation(path: string): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function runningWorkflow(id: string): Record<string, unknown> {
  return {
    id,
    type: 'order-fulfillment',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1.0.0' },
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

let fetchScript: ScriptedFetch;

beforeEach(() => {
  fetchScript = new ScriptedFetch();
  fetchScript.routeSseStream('/v1/events/sse');
});

afterEach(() => {
  fetchScript.restore();
  // The address is shared with every test that runs after this file: leave it at the root, since a
  // `?tab=` left behind changes what the list views render.
  resetLocation('/');
});

function jsonRpcMethodsCalled(): string[] {
  return fetchScript.calls.flatMap((call) => {
    if (typeof call.init?.body !== 'string') return [];
    try {
      const body: unknown = JSON.parse(call.init.body);
      return typeof body === 'object' &&
        body !== null &&
        'method' in body &&
        typeof body.method === 'string'
        ? [body.method]
        : [];
    } catch {
      return [];
    }
  });
}

describe('WorkflowDetail — attributes section', () => {
  test('draws the run’s attributes for a principal who can read them, with edits when it can write', async () => {
    const id = 'wf-sections-attributes-1';
    fetchScript.routeJsonRpcMethod('weft.workflows.attributes.get', { region: 'us-east' });
    fetchScript.routeUrl(`/workflows/${id}`, runningWorkflow(id));
    resetLocation(`/runs/${id}`);

    const { findByText, getByRole } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: ALL_BUT(), queryClient: newQueryClient() },
    });

    expect(await findByText('us-east')).not.toBeNull();
    expect(getByRole('button', { name: 'Edit region' })).not.toBeNull();
  });

  test('draws it read-only for a principal who can read but not write', async () => {
    const id = 'wf-sections-attributes-2';
    fetchScript.routeJsonRpcMethod('weft.workflows.attributes.get', { region: 'us-east' });
    fetchScript.routeUrl(`/workflows/${id}`, runningWorkflow(id));
    resetLocation(`/runs/${id}`);

    const { findByText, queryByRole } = render(WorkflowDetailHarness, {
      props: {
        client: realClient(),
        principal: ALL_BUT('attributes:write'),
        queryClient: newQueryClient(),
      },
    });

    expect(await findByText('us-east')).not.toBeNull();
    expect(queryByRole('button', { name: /^Edit/ })).toBeNull();
  });

  test('draws no section, and reads nothing, without attributes:read', async () => {
    const id = 'wf-sections-attributes-3';
    fetchScript.routeJsonRpcMethod('weft.workflows.attributes.get', { region: 'us-east' });
    fetchScript.routeUrl(`/workflows/${id}`, runningWorkflow(id));
    resetLocation(`/runs/${id}`);

    const { findByRole, queryByText } = render(WorkflowDetailHarness, {
      props: {
        client: realClient(),
        principal: ALL_BUT('attributes:read', 'attributes:write'),
        queryClient: newQueryClient(),
      },
    });

    await findByRole('heading', { name: 'order-fulfillment' });
    expect(queryByText('Search attributes')).toBeNull();
    expect(queryByText('us-east')).toBeNull();
    expect(jsonRpcMethodsCalled()).not.toContain('weft.workflows.attributes.get');
  });
});

describe('WorkflowDetail — updates tab', () => {
  function routeUpdates(id: string): void {
    fetchScript.routeJsonRpcMethod('weft.workflows.updates.list', {
      items: [
        {
          updateId: 'u-1',
          name: 'applyDiscount',
          receivedAt: 1_000,
          outcome: 'failed',
          completedAt: 1_100,
          error: 'insufficient balance',
        },
      ],
    });
    fetchScript.routeUrl(`/workflows/${id}`, runningWorkflow(id));
    resetLocation(`/runs/${id}?tab=updates`);
  }

  test('lists the run’s updates and draws the send form for a principal holding updates:write', async () => {
    const id = 'wf-sections-updates-1';
    routeUpdates(id);

    const { findByText, getByLabelText } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: ALL_BUT(), queryClient: newQueryClient() },
    });

    expect(await findByText('insufficient balance')).not.toBeNull();
    // The header also has a "Send update" shortcut to this tab; the form is what holds the name field.
    expect(getByLabelText('Update name')).not.toBeNull();
  });

  test('still lists them, with no send form, without updates:write', async () => {
    const id = 'wf-sections-updates-2';
    routeUpdates(id);

    const { container, findByText } = render(WorkflowDetailHarness, {
      props: {
        client: realClient(),
        principal: ALL_BUT('updates:write'),
        queryClient: newQueryClient(),
      },
    });

    expect(await findByText('insufficient balance')).not.toBeNull();
    // The header keeps its "Send update" shortcut to this tab; the form is what holds these fields.
    // (A label query that finds nothing scans the whole page, so the form's ids are checked instead.)
    expect(container.querySelector('[id^="update-name-"]')).toBeNull();
    expect(container.querySelector('[id^="update-payload-"]')).toBeNull();
  });
});

describe('WorkflowDetail — stream links in the timeline', () => {
  function routeTimeline(id: string): void {
    fetchScript.routeJsonRpcMethod('weft.workflows.activities.pending.list', { items: [] });
    fetchScript.routeUrl(`/workflows/${id}/timeline`, [
      {
        step: 1,
        operationType: 'stream',
        operationLabel: 'progress',
        inputSummary: '{"key":"progress"}',
        timestamp: 1_000,
        status: 'completed',
      },
    ]);
    fetchScript.routeUrl(`/workflows/${id}`, runningWorkflow(id));
    resetLocation(`/runs/${id}?tab=timeline`);
  }

  test('links a stream step to its chunks for a principal holding streams:read', async () => {
    const id = 'wf-sections-streams-1';
    routeTimeline(id);

    const { findByRole } = render(WorkflowDetailHarness, {
      props: { client: realClient(), principal: ALL_BUT(), queryClient: newQueryClient() },
    });

    expect(await findByRole('button', { name: 'View chunks of progress' })).not.toBeNull();
  });

  test('draws no stream link without streams:read', async () => {
    const id = 'wf-sections-streams-2';
    routeTimeline(id);

    const { findByText, queryByRole } = render(WorkflowDetailHarness, {
      props: {
        client: realClient(),
        principal: ALL_BUT('streams:read'),
        queryClient: newQueryClient(),
      },
    });

    await findByText('Stream');
    expect(queryByRole('button', { name: /View chunks/ })).toBeNull();
  });
});
