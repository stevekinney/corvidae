/**
 * Component tests for `<WorkflowRevisionsPanel>`'s revision detail and install
 * control (COR-1464): selecting a row reads `weft.workflows.revisions.get`, and
 * a successful install refreshes the list so it includes the new revision.
 * Activation lives in `workflow-revisions-panel-activation*.test.ts`.
 */
import { fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ScriptedFetch, jsonRpcRequests } from './system-test-support.test-support.ts';
import {
  activePointer,
  renderPanel,
  revisionRecord,
} from './workflow-revisions-panel-fixtures.test-support.ts';

let scripted: ScriptedFetch | undefined;

/** `weft.workflows.active.get` faults NotFound for a workflow that was never activated. */
function routeNeverActivated(script: ScriptedFetch): void {
  script.routeJsonRpcError('weft.workflows.active.get', {
    code: -32020,
    message: 'never activated',
    data: { weftCode: 'NotFound', httpStatus: 404 },
  });
}

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

describe('WorkflowRevisionsPanel revision detail', () => {
  test('selecting an installed revision shows the fields weft.workflows.revisions.get returns for it', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
      revisionRecord('order-processing-rev-2'),
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    scripted.routeJsonRpcMethod(
      'weft.workflows.revisions.get',
      revisionRecord('order-processing-rev-2'),
    );

    const { findByRole } = await renderPanel();
    await fireEvent.click(
      await findByRole('button', { name: 'View detail for revision order-processing-rev-2' }),
    );

    const detail = await findByRole('region', { name: 'Revision order-processing-rev-2 detail' });
    expect(detail.textContent).toContain('sha256:order-processing-rev-2-hash');
    expect(detail.textContent).toContain('"name": "order-processing"');
    expect(
      jsonRpcRequests(scripted.calls, 'weft.workflows.revisions.get').map(
        (request) => request.params,
      ),
    ).toEqual([{ name: 'order-processing', revision: 'order-processing-rev-2' }]);
  });

  test('closing the detail hides it again', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
    ]);
    routeNeverActivated(scripted);
    scripted.routeJsonRpcMethod(
      'weft.workflows.revisions.get',
      revisionRecord('order-processing-rev-1'),
    );

    const { findByRole, getByRole, queryByRole } = await renderPanel();
    await fireEvent.click(
      await findByRole('button', { name: 'View detail for revision order-processing-rev-1' }),
    );
    await findByRole('region', { name: 'Revision order-processing-rev-1 detail' });
    await fireEvent.click(getByRole('button', { name: 'Close detail' }));

    await waitFor(() =>
      expect(
        queryByRole('region', { name: 'Revision order-processing-rev-1 detail' })?.outerHTML ??
          null,
      ).toBeNull(),
    );
  });
});

describe('WorkflowRevisionsPanel install', () => {
  const manifestText = JSON.stringify(revisionRecord('order-processing-rev-3').manifest);

  test('a successful install refreshes the revision list so it includes the new revision', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethodSequence('weft.workflows.revisions.list', [
      [revisionRecord('order-processing-rev-1')],
      [revisionRecord('order-processing-rev-1'), revisionRecord('order-processing-rev-3')],
    ]);
    scripted.routeJsonRpcMethod(
      'weft.workflows.active.get',
      activePointer('order-processing-rev-1'),
    );
    scripted.routeJsonRpcMethod(
      'weft.workflows.revisions.install',
      revisionRecord('order-processing-rev-3'),
    );

    const { findByLabelText, findByRole, findByText, queryByText } = await renderPanel();
    await findByRole('button', { name: 'View detail for revision order-processing-rev-1' });
    expect(queryByText('order-processing-rev-3')).toBeNull();

    await fireEvent.input(await findByLabelText('Revision manifest (JSON)'), {
      target: { value: manifestText },
    });
    await fireEvent.click(await findByRole('button', { name: 'Install revision' }));

    expect(
      await findByRole('button', { name: 'View detail for revision order-processing-rev-3' }),
    ).not.toBeNull();
    expect(await findByText(/Installed revision "order-processing-rev-3"/)).not.toBeNull();
  });

  test('a rejected manifest shows the fault and leaves the list as it was', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
    ]);
    routeNeverActivated(scripted);
    scripted.routeJsonRpcError('weft.workflows.revisions.install', {
      code: -32602,
      message: 'Manifest is invalid.',
      data: { httpStatus: 400, weftCode: 'InvalidParams' },
    });

    const { findByLabelText, findByRole, findByText, queryByRole } = await renderPanel();
    await findByRole('button', { name: 'View detail for revision order-processing-rev-1' });
    await fireEvent.input(await findByLabelText('Revision manifest (JSON)'), {
      target: { value: '{"name":"order-processing"}' },
    });
    await fireEvent.click(await findByRole('button', { name: 'Install revision' }));

    expect(await findByText('Manifest is invalid.')).not.toBeNull();
    expect(
      queryByRole('button', { name: 'View detail for revision order-processing-rev-3' }),
    ).toBeNull();
  });

  test('the install control is available when no revision is installed yet', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', []);
    routeNeverActivated(scripted);

    const { findByText, findByRole } = await renderPanel();

    expect(await findByText('No revisions installed for this workflow yet.')).not.toBeNull();
    expect(await findByRole('button', { name: 'Install revision' })).not.toBeNull();
  });

  test('without workflows:admin the panel offers no install control', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod('weft.workflows.revisions.list', [
      revisionRecord('order-processing-rev-1'),
    ]);
    routeNeverActivated(scripted);

    const { findByRole, queryByRole } = await renderPanel(['workflows:read']);
    await findByRole('button', { name: 'View detail for revision order-processing-rev-1' });

    expect(queryByRole('button', { name: 'Install revision' })).toBeNull();
  });
});
