/** Component tests for `<RevisionDetail>` (COR-1464): the fields `weft.workflows.revisions.get` returns, and every non-success state. */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../../lib/query.ts';
import RevisionDetailFixture from './revision-detail-fixture.test-harness.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { ScriptedFetch, jsonRpcRequests, realClient } from './system-test-support.test-support.ts';
import { revisionRecord } from './workflow-revisions-panel-fixtures.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function renderDetail() {
  return render(SystemRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: RevisionDetailFixture,
    },
  });
}

describe('RevisionDetail', () => {
  test('shows the fields weft.workflows.revisions.get returns for the selected revision', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(
      'weft.workflows.revisions.get',
      revisionRecord('order-processing-rev-1'),
    );

    const { findByText, getByText, container } = renderDetail();

    expect(await findByText('order-processing-rev-1')).not.toBeNull();
    expect(getByText('Workflow name')).not.toBeNull();
    expect(getByText('sha256:order-processing-rev-1-hash')).not.toBeNull();
    expect(getByText('2023-11-14T22:13:20.000Z')).not.toBeNull();
    expect(container.textContent).toContain('"workflowVersion": "0.0.0"');
  });

  test('the Close detail button calls onClose', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(
      'weft.workflows.revisions.get',
      revisionRecord('order-processing-rev-1'),
    );

    const { findByRole, findByText } = renderDetail();
    await fireEvent.click(await findByRole('button', { name: 'Close detail' }));

    expect(await findByText('Detail closed')).not.toBeNull();
  });

  test('asks for exactly the selected name and revision', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(
      'weft.workflows.revisions.get',
      revisionRecord('order-processing-rev-1'),
    );

    const { findByText } = renderDetail();
    await findByText('Workflow name');

    expect(
      jsonRpcRequests(scripted.calls, 'weft.workflows.revisions.get').map(
        (request) => request.params,
      ),
    ).toEqual([{ name: 'order-processing', revision: 'order-processing-rev-1' }]);
  });

  test('shows a loading status before the record arrives', () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcDeferred('weft.workflows.revisions.get', new Promise(() => {}));

    const { getByRole } = renderDetail();

    expect(getByRole('status', { name: 'Loading revision detail' })).not.toBeNull();
  });

  test('shows the not-found fault when the revision is no longer installed', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcError('weft.workflows.revisions.get', {
      code: -32004,
      message: 'Revision order-processing-rev-1 is not installed.',
      data: { httpStatus: 404, weftCode: 'NotFound' },
    });

    const { findByText } = renderDetail();

    expect(await findByText('Not found')).not.toBeNull();
    expect(await findByText('Revision order-processing-rev-1 is not installed.')).not.toBeNull();
  });

  test('shows the denied fault for a principal the server refuses', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcError('weft.workflows.revisions.get', {
      code: -32003,
      message: 'Requires workflows:read.',
      data: { httpStatus: 403, weftCode: 'Forbidden' },
    });

    const { findByText } = renderDetail();

    expect(await findByText('Not authorized')).not.toBeNull();
  });

  test('shows a malformed-response alert, and no fields, for a payload that is not a revision record', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.get', { unexpected: true });

    const { findByRole, queryByText } = renderDetail();

    const alert = await findByRole('alert');
    await waitFor(() => expect(alert.textContent).toContain("doesn't recognize"));
    expect(queryByText('Workflow name')).toBeNull();
  });
});
