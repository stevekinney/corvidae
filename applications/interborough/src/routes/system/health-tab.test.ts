/**
 * Component tests for `<HealthTab>` (plan §9.7 T7.5). Covers the engine
 * lease status from `weft.system.lease` (COR-124), the
 * recover-all Tier-2 confirm flow, and the codegen preview.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import ToastHost from '../../app/toast-host.svelte';
import { createQueryClient, queryKeys } from '../../lib/query.ts';
import HealthTab from './health-tab.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const DISABLED_LEASE = { mode: 'none', status: 'disabled', holdsLease: false } as const;

/** A fresh scripted fetch with a standing `weft.system.lease` route; a later route for the same call wins. */
function scriptedWithLease(lease: unknown = DISABLED_LEASE): ScriptedFetch {
  const fetch = new ScriptedFetch();
  fetch.routeJsonRpcMethod('weft.system.lease', lease);
  return fetch;
}

function routeBaseline(fetch: ScriptedFetch): void {
  fetch.routeJsonRpcMethod('weft.system.registry', {
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
          inputSchema: {
            type: 'object',
            required: ['orderId'],
            properties: { orderId: { type: 'string' } },
          },
        },
      },
    ],
    activeRevisions: { 'order-processing': 'order-processing-rev' },
    activities: {},
  });
}

/**
 * Every test in this file mounts its own `HealthTab`, which owns two
 * concurrent `createQuery`s (registry + lease) and a `createMutation`.
 * Callers explicitly `unmount()` at the end of each test (on top of
 * `@testing-library/svelte`'s own global `afterEach(cleanup)`) to guarantee
 * this test's in-flight query/mutation machinery is torn down before the
 * next test installs a fresh `ScriptedFetch` — without it, a still-settling
 * promise from one test's component occasionally resolved during the next
 * test's run and read from the wrong (already-restored) fetch mock, an
 * intermittent cross-test flake observed empirically.
 */
async function renderHealthTab(queryClient = createQueryClient()) {
  return render(SystemRouteTestHarness, {
    props: { client: realClient(), queryClient, component: HealthTab },
  });
}

/** The production query client without retries, so a non-wire failure settles immediately. */
function queryClientWithoutRetries() {
  const queryClient = createQueryClient();
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
  return queryClient;
}

describe('HealthTab', () => {
  test('reports a disabled engine lease in words', async () => {
    scripted = scriptedWithLease();
    routeBaseline(scripted);
    const { findByText, getByText, unmount } = await renderHealthTab();
    expect(await findByText('Disabled')).not.toBeNull();
    expect(getByText('Lease ownership is not configured for this server.')).not.toBeNull();
    unmount();
  });

  test('reports a contested engine lease with its holder, fencing epoch, and loss reason', async () => {
    scripted = scriptedWithLease({
      mode: 'lease',
      status: 'contested',
      holdsLease: false,
      holderId: 'engine-b',
      heldSince: 1_700_000_000_000,
      expiresAt: 1_700_000_030_000,
      lastRenewedAt: 1_700_000_010_000,
      fencingEpoch: 9,
      lossReason: 'deposed',
    });
    routeBaseline(scripted);
    const { findByText, getByText, getByRole, unmount } = await renderHealthTab();
    expect(await findByText('Contested')).not.toBeNull();
    expect(getByRole('heading', { name: 'Server lease' })).not.toBeNull();
    expect(
      getByText('This server lost the ownership lease: another holder deposed this server.'),
    ).not.toBeNull();
    expect(getByText('engine-b')).not.toBeNull();
    expect(getByText('9')).not.toBeNull();
    expect(getByText('2023-11-14T22:13:50.000Z')).not.toBeNull();
    unmount();
  });

  test('a healthy lease reports its holder and fencing epoch', async () => {
    scripted = scriptedWithLease({
      mode: 'lease',
      status: 'healthy',
      holdsLease: true,
      holderId: 'engine-a',
      heldSince: 1_700_000_000_000,
      expiresAt: 1_700_000_030_000,
      lastRenewedAt: 1_700_000_010_000,
      fencingEpoch: 3,
    });
    routeBaseline(scripted);
    const { findByText, getByText, queryByText, unmount } = await renderHealthTab();
    expect(await findByText('Healthy')).not.toBeNull();
    expect(getByText('engine-a')).not.toBeNull();
    expect(getByText('3')).not.toBeNull();
    expect(queryByText('Not reported')).toBeNull();
    unmount();
  });

  test('a healthy lease without its holder evidence is malformed, never a healthy badge', async () => {
    scripted = scriptedWithLease({ mode: 'lease', status: 'healthy', holdsLease: true });
    routeBaseline(scripted);
    const { findByText, queryByText, unmount } = await renderHealthTab(queryClientWithoutRetries());
    expect(await findByText('Malformed server response')).not.toBeNull();
    expect(queryByText('Healthy')).toBeNull();
    unmount();
  });

  test('a malformed lease response is explicit, never a healthy badge', async () => {
    scripted = scriptedWithLease({ mode: 'lease', status: 'healthy' });
    routeBaseline(scripted);
    const { findByText, queryByText, unmount } = await renderHealthTab(queryClientWithoutRetries());
    expect(await findByText('Malformed server response')).not.toBeNull();
    expect(queryByText('Healthy')).toBeNull();
    unmount();
  });

  test('a failed background refetch drops the cached healthy badge instead of showing it above the fault', async () => {
    scripted = scriptedWithLease({
      mode: 'lease',
      status: 'healthy',
      holdsLease: true,
      holderId: 'engine-a',
      heldSince: 1_700_000_000_000,
      expiresAt: 1_700_000_030_000,
      lastRenewedAt: 1_700_000_010_000,
      fencingEpoch: 3,
    });
    routeBaseline(scripted);
    const queryClient = queryClientWithoutRetries();
    const { findByText, queryByText, unmount } = await renderHealthTab(queryClient);
    expect(await findByText('Healthy')).not.toBeNull();
    // Later routes win: the next lease read faults while the healthy reading stays cached.
    scripted.routeJsonRpcError('weft.system.lease', {
      code: -32000,
      message: 'Forbidden',
      data: { httpStatus: 403 },
    });
    await queryClient.refetchQueries({ queryKey: queryKeys.systemLease() });
    expect(queryClient.getQueryData(queryKeys.systemLease())).toBeDefined();
    expect(await findByText('Not authorized')).not.toBeNull();
    expect(queryByText('Healthy')).toBeNull();
    expect(queryByText('engine-a')).toBeNull();
    unmount();
  });

  test('a forbidden lease read shows the fault banner', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcError('weft.system.lease', {
      code: -32000,
      message: 'Forbidden',
      data: { httpStatus: 403 },
    });
    routeBaseline(scripted);
    const { findByText, unmount } = await renderHealthTab();
    expect(await findByText('Not authorized')).not.toBeNull();
    unmount();
  });

  test('renders a codegen preview for the first schema-bearing workflow', async () => {
    scripted = scriptedWithLease();
    routeBaseline(scripted);
    const { findByText, unmount } = await renderHealthTab();
    // Root cause of the original flake here: `CodeBlock`'s syntax
    // highlighting is a two-phase, client-only enhancement (its own module
    // doc) — first paint is a single plain-text node (a multi-word string
    // match succeeds), then Shiki loads asynchronously and re-renders the
    // line as one `<span>` per token, fragmenting any multi-token string
    // across siblings. Whether an assertion lands before or after that
    // swap is a race, so asserting on the FULL line intermittently failed
    // once Shiki won the race — not a timeout-margin issue (confirmed: it
    // still failed with 3000ms headroom, since a longer wait only made
    // catching the fragmented state MORE likely). Asserting on
    // `OrderProcessingInput` alone is robust either way: it's Shiki's own
    // single token in the highlighted state, and obviously still one text
    // node in the plain-text state.
    expect(await findByText('OrderProcessingInput', { exact: false })).not.toBeNull();
    unmount();
  });

  test('recover-all requires Tier-2 confirmation before calling the operation, then shows a success toast', async () => {
    scripted = scriptedWithLease();
    routeBaseline(scripted);
    scripted.routeJsonRpcMethod('weft.recover.all', { recovered: ['wf_1'] });

    // `showToast` (`src/app/toast-host.svelte`, Foundation-frozen) no-ops
    // with a `console.error` when called with no `<ToastHost>` mounted —
    // correct in production (exactly one host is always mounted by the real
    // app shell) but this test's own mutation calls it in `onSuccess`, so a
    // real host is mounted here too, matching `toast-host.test.ts`'s own
    // pattern. This also verifies the success toast copy, which was
    // previously untested.
    const { findByText: findToastByText } = render(ToastHost);

    const { findByRole, findByText, findAllByRole, unmount } = await renderHealthTab();

    await fireEvent.click(await findByRole('button', { name: 'Recover all' }));
    expect(await findByText('Recover all workflows?')).not.toBeNull();

    const buttons = await findAllByRole('button', { name: 'Recover all' });
    expect(buttons.length).toBe(2);
    await fireEvent.click(buttons[buttons.length - 1]!);

    expect(await findToastByText('Recovery triggered — 1 workflow(s) recovered.')).not.toBeNull();

    const bodies = scripted.calls
      .map((call) => (typeof call.init?.body === 'string' ? call.init.body : ''))
      .filter((body) => body.includes('weft.recover.all'));
    expect(bodies.length).toBeGreaterThan(0);
    unmount();
  });

  test('conformance panel shows the copyable CLI command, not a run button', async () => {
    scripted = scriptedWithLease();
    routeBaseline(scripted);
    const { findByText, queryByRole, unmount } = await renderHealthTab();
    expect(await findByText('weft conformance -- <worker-command>')).not.toBeNull();
    expect(queryByRole('button', { name: 'Run' })).toBeNull();
    unmount();
  });

  test('a failing registry fetch shows the fault banner in the codegen preview panel', async () => {
    scripted = scriptedWithLease();
    // 403, not 500: `shouldRetryQuery` retries a classified `internal` fault with a backoff this test does not wait out, and never an `unauthorized` one.
    scripted.routeUrlStatus('/jsonrpc', 403, 'Forbidden');
    // Later routes win: keep the lease read healthy so only the registry panel faults.
    scripted.routeJsonRpcMethod('weft.system.lease', DISABLED_LEASE);
    const { findByText, unmount } = await renderHealthTab();
    expect(await findByText('Not authorized')).not.toBeNull();
    unmount();
  });

  test('shows an honest empty state when no registered workflow has an input schema', async () => {
    scripted = scriptedWithLease();
    scripted.routeJsonRpcMethod('weft.system.registry', {
      registryVersion: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
      workflows: [
        {
          manifestVersion: 1,
          name: 'heartbeat',
          workflowVersion: '1.0.0',
          revision: 'heartbeat-rev',
          contractHash: 'heartbeat-hash',
          contract: { name: 'heartbeat', workflowVersion: '1.0.0' },
        },
      ],
      activeRevisions: { heartbeat: 'heartbeat-rev' },
      activities: {},
    });
    const { findByText, unmount } = await renderHealthTab();
    expect(await findByText('No workflow with an input schema')).not.toBeNull();
    unmount();
  });
});
