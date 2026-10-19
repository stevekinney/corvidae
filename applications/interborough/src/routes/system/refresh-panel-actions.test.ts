/**
 * Component tests for `<RefreshPanel>`'s actions (COR-166): Check now, Check
 * and activate, and Activate candidate; their outcomes, the one-action-at-a-time
 * rule, scope gating, and query invalidation. What the panel shows lives in
 * `refresh-panel.test.ts`.
 */
import { fireEvent, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  DIAGNOSTICS_METHOD,
  installedSource,
  REFRESH_METHOD,
  renderRefreshPanel,
} from './refresh-panel-fixtures.test-support.ts';
import { jsonRpcRequests, ScriptedFetch } from './system-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function script(): ScriptedFetch {
  scripted = new ScriptedFetch();
  scripted.routeJsonRpcMethod(DIAGNOSTICS_METHOD, { sources: [installedSource()] });
  return scripted;
}

async function panelFor(scopes?: Parameters<typeof renderRefreshPanel>[0]) {
  const rendered = await renderRefreshPanel(scopes);
  const panel = await rendered.findByRole('region', { name: 'Conditional refresh' });
  await within(panel).findByText('Candidate revision');
  return { ...rendered, panel: within(panel) };
}

function refreshRequests(calls: ScriptedFetch['calls']) {
  return jsonRpcRequests(calls, REFRESH_METHOD).map((request) => request.params);
}

describe('RefreshPanel Check now', () => {
  test('checks without activating, shows the installed outcome, and re-reads the diagnostics', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, { status: 'installed', revision: 'rev-2' });
    const { panel } = await panelFor();
    const readsBefore = jsonRpcRequests(fetch.calls, DIAGNOSTICS_METHOD).length;

    await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

    expect(
      await panel.findByText(/Candidate revision "rev-2" is installed and warmed/),
    ).not.toBeNull();
    expect(refreshRequests(fetch.calls)).toEqual([{ name: 'order-processing' }]);
    await waitFor(() =>
      expect(jsonRpcRequests(fetch.calls, DIAGNOSTICS_METHOD).length).toBeGreaterThan(readsBefore),
    );
  });

  test('a 304 reads Not modified', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, { status: 'not-modified', etag: 'sha256:etag-2' });
    const { panel } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

    expect(await panel.findByText('Not modified', { selector: 'span' })).not.toBeNull();
    expect(await panel.findByText(/The source answered 304/)).not.toBeNull();
  });

  const refusals = [
    ['refresh-integrity', /Integrity check failed/],
    ['refresh-identity', /Identity mismatch/],
    ['refresh-contract', /Contract hash mismatch/],
    ['refresh-runtime', /Runtime validation failed/],
    ['refresh-warming', /Warming failed/],
  ] as const;

  for (const [reason, pattern] of refusals) {
    test(`a ${reason} refusal is shown as its own outcome, with nothing installed`, async () => {
      const fetch = script();
      fetch.routeJsonRpcError(REFRESH_METHOD, {
        code: -32009,
        message: 'refused',
        data: { httpStatus: 409, weftCode: 'Conflict', reason },
      });
      const { panel } = await panelFor();

      await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

      expect(await panel.findByText(pattern)).not.toBeNull();
      expect(await panel.findByText(/Nothing was installed/)).not.toBeNull();
    });
  }

  test('an unreachable source reads Source unavailable', async () => {
    const fetch = script();
    fetch.routeJsonRpcError(REFRESH_METHOD, {
      code: -32010,
      message: 'unavailable',
      data: { httpStatus: 503, weftCode: 'Unavailable', reason: 'refresh-source' },
    });
    const { panel } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

    expect(await panel.findByText('Source unavailable')).not.toBeNull();
  });

  test('a refused principal reads Not authorized', async () => {
    const fetch = script();
    fetch.routeJsonRpcError(REFRESH_METHOD, {
      code: -32003,
      message: 'forbidden',
      data: { httpStatus: 403, weftCode: 'Forbidden' },
    });
    const { panel } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

    expect(await panel.findByText('Not authorized')).not.toBeNull();
  });

  const faults = [
    ['No source', 404, 'NotFound', {}],
    ['Conflict', 409, 'Conflict', { reason: 'catalog-conflict' }],
    ['Invalid request', 400, 'InvalidParams', {}],
    ['Failed', 500, 'EngineFailure', {}],
  ] as const;

  for (const [label, status, weftCode, data] of faults) {
    test(`a ${status} ${weftCode} fault reads "${label}"`, async () => {
      const fetch = script();
      fetch.routeJsonRpcError(REFRESH_METHOD, {
        code: -32000,
        message: 'server said no',
        data: { httpStatus: status, weftCode, ...data },
      });
      const { panel } = await panelFor();

      await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

      expect(await panel.findByText(label, { selector: 'span' })).not.toBeNull();
    });
  }

  test('a malformed result is shown as such', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, { status: 'sleeping' });
    const { panel } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

    expect(await panel.findByText('Malformed response')).not.toBeNull();
  });
});

describe('RefreshPanel Check and activate', () => {
  async function confirmCheckAndActivate(panel: Awaited<ReturnType<typeof panelFor>>) {
    await fireEvent.click(panel.panel.getByRole('button', { name: 'Check and activate' }));
    const dialog = await panel.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Check and activate' }));
  }

  test('sends activate "if-compatible" under the active generation after confirmation', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, {
      status: 'activated',
      revision: 'rev-2',
      activation: { applied: true, pointer: { revision: 'rev-2', generation: 4, activatedAt: 1 } },
    });
    const panel = await panelFor();

    await confirmCheckAndActivate(panel);

    expect(
      await panel.panel.findByText(/Activated revision "rev-2" \(generation 4\)/),
    ).not.toBeNull();
    expect(refreshRequests(fetch.calls)).toEqual([
      { name: 'order-processing', activate: 'if-compatible', expectedGeneration: 3 },
    ]);
  });

  test('a stale-generation refusal leaves the candidate installed and names the current generation', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, {
      status: 'installed',
      revision: 'rev-2',
      activation: { applied: false, reason: 'stale-generation', currentGeneration: 7 },
    });
    const panel = await panelFor();

    await confirmCheckAndActivate(panel);

    expect(await panel.panel.findByText(/current generation 7/)).not.toBeNull();
    expect(await panel.panel.findByText('Not activated')).not.toBeNull();
  });

  test('Refresh on a not-activated outcome re-reads the refresh sources', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, {
      status: 'installed',
      revision: 'rev-2',
      activation: { applied: false, reason: 'stale-generation', currentGeneration: 7 },
    });
    const panel = await panelFor();
    await confirmCheckAndActivate(panel);
    await panel.panel.findByText(/current generation 7/);
    const readsBefore = jsonRpcRequests(fetch.calls, DIAGNOSTICS_METHOD).length;

    await fireEvent.click(panel.panel.getByRole('button', { name: 'Refresh' }));

    await waitFor(() =>
      expect(jsonRpcRequests(fetch.calls, DIAGNOSTICS_METHOD).length).toBeGreaterThan(readsBefore),
    );
  });

  test('the next attempt after a stale refusal uses the generation the refusal reported', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethodSequence(REFRESH_METHOD, [
      {
        status: 'installed',
        revision: 'rev-2',
        activation: { applied: false, reason: 'stale-generation', currentGeneration: 7 },
      },
      { status: 'installed', revision: 'rev-2' },
    ]);
    const panel = await panelFor();

    await confirmCheckAndActivate(panel);
    await panel.panel.findByText(/current generation 7/);
    await confirmCheckAndActivate(panel);

    await waitFor(() => expect(refreshRequests(fetch.calls)).toHaveLength(2));
    expect(refreshRequests(fetch.calls)[1]).toMatchObject({ expectedGeneration: 7 });
  });

  test('after a stale refusal the dialog names the generation the request will send', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, {
      status: 'installed',
      revision: 'rev-2',
      activation: { applied: false, reason: 'stale-generation', currentGeneration: 7 },
    });
    const panel = await panelFor();
    await fireEvent.click(panel.panel.getByRole('button', { name: 'Check and activate' }));
    const first = await panel.findByRole('dialog');
    expect(first.textContent).toContain('generation 3');
    await fireEvent.click(within(first).getByRole('button', { name: 'Check and activate' }));
    await panel.panel.findByText(/current generation 7/);

    await fireEvent.click(panel.panel.getByRole('button', { name: 'Check and activate' }));

    const second = await panel.findByRole('dialog');
    expect(second.textContent).toContain('generation 7');
    expect(second.textContent).not.toContain('generation 3');
  });

  test('an incompatible refusal lists the workflow-version and contract-hash reasons', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod(REFRESH_METHOD, {
      status: 'installed',
      revision: 'rev-2',
      activation: {
        applied: false,
        reason: 'incompatible',
        compatibilityReasons: ['workflow-version-incompatible', 'contract-hash-mismatch'],
      },
    });
    const panel = await panelFor();

    await confirmCheckAndActivate(panel);

    expect(await panel.panel.findByText('Incompatible')).not.toBeNull();
    expect(await panel.panel.findByText(/workflow-version-incompatible/)).not.toBeNull();
    expect(await panel.panel.findByText(/contract-hash-mismatch/)).not.toBeNull();
  });

  test('cancelling the confirmation sends nothing', async () => {
    const fetch = script();
    const panel = await panelFor();

    await fireEvent.click(panel.panel.getByRole('button', { name: 'Check and activate' }));
    const dialog = await panel.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(refreshRequests(fetch.calls)).toHaveLength(0);
  });
});

describe('RefreshPanel Activate candidate', () => {
  test('activates the installed candidate revision under the active generation', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod('weft.workflows.revisions.activate', {
      applied: true,
      pointer: { revision: 'rev-2', generation: 4, activatedAt: 1 },
    });
    const { panel, findByRole } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Activate candidate' }));
    const dialog = await findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    expect(await panel.findByText('Compatible')).not.toBeNull();
    expect(
      jsonRpcRequests(fetch.calls, 'weft.workflows.revisions.activate').map((r) => r.params),
    ).toEqual([{ name: 'order-processing', revision: 'rev-2', expectedGeneration: 3 }]);
  });

  test('a stale activation refusal offers Refresh, which re-reads the refresh sources', async () => {
    const fetch = script();
    fetch.routeJsonRpcError('weft.workflows.revisions.activate', {
      code: -32009,
      message: 'stale',
      data: {
        httpStatus: 409,
        weftCode: 'Conflict',
        reason: 'stale-generation',
        currentGeneration: 9,
      },
    });
    const { panel, findByRole } = await panelFor();
    await fireEvent.click(panel.getByRole('button', { name: 'Activate candidate' }));
    const dialog = await findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
    await panel.findByText(/current generation 9/);
    const readsBefore = jsonRpcRequests(fetch.calls, DIAGNOSTICS_METHOD).length;

    await fireEvent.click(panel.getByRole('button', { name: 'Refresh' }));

    await waitFor(() =>
      expect(jsonRpcRequests(fetch.calls, DIAGNOSTICS_METHOD).length).toBeGreaterThan(readsBefore),
    );
  });

  test('a malformed activation response is an error, never an activation', async () => {
    const fetch = script();
    fetch.routeJsonRpcMethod('weft.workflows.revisions.activate', { applied: true });
    const { panel, findByRole, queryByText } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Activate candidate' }));
    const dialog = await findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(fetch.calls.length).toBeGreaterThan(1));
    expect(queryByText('Compatible')).toBeNull();
  });

  test('an incompatible candidate is refused with its reasons', async () => {
    const fetch = script();
    fetch.routeJsonRpcError('weft.workflows.revisions.activate', {
      code: -32009,
      message: 'incompatible',
      data: {
        httpStatus: 409,
        weftCode: 'Conflict',
        reason: 'incompatible',
        compatibilityReasons: ['workflow-version-incompatible'],
      },
    });
    const { panel, findByRole } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Activate candidate' }));
    const dialog = await findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));

    expect(await panel.findByText('Incompatible')).not.toBeNull();
    expect(await panel.findByText(/workflow-version-incompatible/)).not.toBeNull();
  });
});

describe('RefreshPanel actions are one at a time and scoped', () => {
  test('while an action is in flight every action is disabled', async () => {
    const fetch = script();
    fetch.routeJsonRpcDeferred(REFRESH_METHOD, new Promise(() => {}));
    const { panel } = await panelFor();

    await fireEvent.click(panel.getByRole('button', { name: 'Check now' }));

    await waitFor(() => {
      for (const name of ['Check now', 'Check and activate', 'Activate candidate']) {
        expect(panel.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
      }
    });
  });

  test('without workflows:admin every action is disabled and says what it needs', async () => {
    script();
    const { panel } = await panelFor(['workflows:read']);

    for (const name of ['Check now', 'Check and activate', 'Activate candidate']) {
      const button = panel.getByRole('button', { name });
      expect(button.hasAttribute('disabled')).toBe(true);
    }
    expect(panel.getByRole('button', { name: 'Check now' }).getAttribute('title')).toBe(
      'Requires workflows:admin',
    );
  });
});
