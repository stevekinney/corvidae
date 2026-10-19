/** Component tests for `<RevisionInstallForm>` (COR-1464): scope gating, the install call, and the refused paths. */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import ToastHost from '../../app/toast-host.svelte';
import { createQueryClient } from '../../lib/query.ts';
import RevisionInstallFormFixture from './revision-install-form-fixture.test-harness.svelte';
import SystemRouteTestHarness from './system-route-test-harness.test-harness.svelte';
import { ScriptedFetch, jsonRpcRequests, realClient } from './system-test-support.test-support.ts';
import { revisionRecord } from './workflow-revisions-panel-fixtures.test-support.ts';

let scripted: ScriptedFetch | undefined;

afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

function renderForm(principalScopes?: readonly ('workflows:read' | 'workflows:admin')[]) {
  // A rejected mutation also raises the shared error toast (`lib/query.ts`).
  render(ToastHost);
  return render(SystemRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: RevisionInstallFormFixture,
      ...(principalScopes === undefined ? {} : { principalScopes }),
    },
  });
}

const MANIFEST = revisionRecord('order-processing-rev-3').manifest;

function installRequests(script: ScriptedFetch) {
  return jsonRpcRequests(script.calls, 'weft.workflows.revisions.install');
}

describe('RevisionInstallForm', () => {
  test('renders no install control without workflows:admin', () => {
    scripted = new ScriptedFetch();

    const { queryByRole, queryByLabelText } = renderForm(['workflows:read']);

    expect(queryByRole('button', { name: 'Install revision' })).toBeNull();
    expect(queryByLabelText('Revision manifest (JSON)')).toBeNull();
  });

  test('renders the install control with workflows:admin', () => {
    scripted = new ScriptedFetch();

    const { getByRole, getByLabelText } = renderForm(['workflows:admin']);

    expect(getByLabelText('Revision manifest (JSON)')).not.toBeNull();
    expect(getByRole('button', { name: 'Install revision' })).not.toBeNull();
  });

  test('submits the parsed manifest to weft.workflows.revisions.install and reports the installed revision', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcMethod(
      'weft.workflows.revisions.install',
      revisionRecord('order-processing-rev-3'),
    );

    const { getByRole, getByLabelText, findByText } = renderForm();
    await fireEvent.input(getByLabelText('Revision manifest (JSON)'), {
      target: { value: JSON.stringify(MANIFEST) },
    });
    await fireEvent.click(getByRole('button', { name: 'Install revision' }));

    expect(
      await findByText(/Installed revision "order-processing-rev-3" of order-processing/),
    ).not.toBeNull();
    expect(installRequests(scripted).map((request) => request.params)).toEqual([
      { manifest: MANIFEST },
    ]);
  });

  test('says so when the installed manifest belongs to another workflow', async () => {
    scripted = new ScriptedFetch();
    const other = revisionRecord('billing-rev-1');
    scripted.routeJsonRpcMethod('weft.workflows.revisions.install', {
      ...other,
      manifest: { ...other.manifest, name: 'billing' },
    });

    const { getByRole, getByLabelText, findByText } = renderForm();
    await fireEvent.input(getByLabelText('Revision manifest (JSON)'), {
      target: { value: '{"name":"billing"}' },
    });
    await fireEvent.click(getByRole('button', { name: 'Install revision' }));

    expect(await findByText(/different workflow than the one open here/)).not.toBeNull();
  });

  test('shows the operation fault and installs nothing when the manifest is rejected', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcError('weft.workflows.revisions.install', {
      code: -32602,
      message: 'Manifest contractHash does not match its contract.',
      data: { httpStatus: 400, weftCode: 'InvalidParams' },
    });

    const { getByRole, getByLabelText, findByText, queryByText } = renderForm();
    await fireEvent.input(getByLabelText('Revision manifest (JSON)'), {
      target: { value: '{"name":"order-processing"}' },
    });
    await fireEvent.click(getByRole('button', { name: 'Install revision' }));

    expect(await findByText('Manifest contractHash does not match its contract.')).not.toBeNull();
    expect(queryByText(/Installed revision/)).toBeNull();
  });

  test('shows a Conflict fault when the revision is already installed with different content', async () => {
    scripted = new ScriptedFetch();
    scripted.routeJsonRpcError('weft.workflows.revisions.install', {
      code: -32009,
      message: 'Revision order-processing-rev-3 is already installed with different content.',
      data: { httpStatus: 409, weftCode: 'Conflict' },
    });

    const { getByRole, getByLabelText, findByText } = renderForm();
    await fireEvent.input(getByLabelText('Revision manifest (JSON)'), {
      target: { value: '{"name":"order-processing"}' },
    });
    await fireEvent.click(getByRole('button', { name: 'Install revision' }));

    expect(await findByText('Conflict')).not.toBeNull();
  });

  test('text that is not JSON never reaches the server', async () => {
    scripted = new ScriptedFetch();

    const { getByRole, getByLabelText, findByText } = renderForm();
    await fireEvent.input(getByLabelText('Revision manifest (JSON)'), {
      target: { value: '{not json' },
    });
    await fireEvent.click(getByRole('button', { name: 'Install revision' }));

    expect(await findByText('The text is not valid JSON, so nothing was sent.')).not.toBeNull();
    await waitFor(() => expect(installRequests(scripted as ScriptedFetch)).toHaveLength(0));
  });

  test('keeps Install disabled while the text is empty', () => {
    scripted = new ScriptedFetch();

    const { getByRole } = renderForm();

    expect(getByRole('button', { name: 'Install revision' }).hasAttribute('disabled')).toBe(true);
  });
});
