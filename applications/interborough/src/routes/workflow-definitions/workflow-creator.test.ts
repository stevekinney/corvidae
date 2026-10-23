/**
 * `/workflows/new`: a new workflow's JSON in Cinder's editor, seeded with a template and saved
 * through `bureau.workflows.create`. The `name` in the text is the identifier and is not sent. Text
 * that is not JSON, a name that is not an identifier or is `new`, and a taken name show the error
 * and save nothing; a document the Bureau refuses shows its words. A save lands on the new page.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  workflowFaults,
  type WorkflowStub,
} from '../../lib/workflow-world.test-support.ts';
import Harness from './area-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open() {
  stub = installWorkflowWorld(emptyWorld({ files: [readyFile('digest')] }));
  router.navigate('/workflows/new', { replace: true });
  return render(Harness, { props: { client: stub.client, scopes: AUTHORIZATION_SCOPES } } as never);
}

const textarea = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea') as HTMLTextAreaElement;

async function typeInto(container: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(textarea(container), { target: { value } });
}

const withName = (name: unknown) =>
  JSON.stringify({
    name,
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [{ kind: 'sleep', duration: '1m' }],
  });

describe('the new-workflow editor', () => {
  test('opens on a template of a name, a description, a schedule trigger, and one agent step, with no probe of its own', async () => {
    const { container, findByRole } = open();
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.creator.heading });
    await waitFor(() => expect(textarea(container)).toBeTruthy());

    const template = JSON.parse(textarea(container).value) as Record<string, unknown>;
    expect(template).toMatchObject({
      name: WORKFLOW_COPY.creator.templateName,
      description: WORKFLOW_COPY.creator.templateDescription,
      trigger: { kind: 'schedule' },
      steps: [{ kind: 'activity', handler: 'agent' }],
    });
    // The frame has nothing to ask the engine or the Bureau: this is where the first workflow is made.
    expect(stub?.callsTo('bureau.workflows.list')).toEqual([]);
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('creates the file without its name, and lands on the new workflow’s page', async () => {
    const { container, getByRole } = open();
    await waitFor(() => expect(textarea(container)).toBeTruthy());
    await typeInto(container, withName('fresh-flow'));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/workflows/fresh-flow'));
    const create = stub?.callsTo('bureau.workflows.create')[0];
    expect(create?.params['id']).toBe('fresh-flow');
    expect(create?.params['definition']).toEqual({
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [{ kind: 'sleep', duration: '1m' }],
    });
    expect(stub?.file('fresh-flow')?.state).toBe('ready');
  });

  test('saves the template as it stands', async () => {
    const { container, getByRole } = open();
    await waitFor(() => expect(textarea(container)).toBeTruthy());
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() =>
      expect(router.pathname).toBe(`/workflows/${WORKFLOW_COPY.creator.templateName}`),
    );
    expect(stub?.file(WORKFLOW_COPY.creator.templateName)?.description).toBe(
      WORKFLOW_COPY.creator.templateDescription,
    );
  });

  test('refuses text that is not JSON, and a JSON value that is not an object, and sends nothing', async () => {
    const { container, getByRole, findByText } = open();
    await waitFor(() => expect(textarea(container)).toBeTruthy());

    await typeInto(container, '{ not json');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.editor.notJson);

    await typeInto(container, '[]');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.editor.notObject);
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });

  test('refuses a missing name, a name that is not an identifier, and the reserved name, and sends nothing', async () => {
    const { container, getByRole, findByText } = open();
    await waitFor(() => expect(textarea(container)).toBeTruthy());

    await typeInto(
      container,
      JSON.stringify({ trigger: { kind: 'signal', name: 'go' }, steps: [] }),
    );
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.creator.noName);

    for (const name of ['Bad_Name', 7, 'x'.repeat(65), '9lives']) {
      await typeInto(container, withName(name));
      await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
      await findByText(WORKFLOW_COPY.creator.invalidName);
    }

    await typeInto(container, withName('new'));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.creator.reservedName);
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });

  test('says a name is taken when a file already has it, and stays on the page', async () => {
    const { container, getByRole, findByText } = open();
    await waitFor(() => expect(textarea(container)).toBeTruthy());
    await typeInto(container, withName('digest'));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    await findByText(WORKFLOW_COPY.creator.taken('digest'));
    expect(router.pathname).toBe('/workflows/new');
    expect(stub?.world.files.map((file) => file.id)).toEqual(['digest']);
  });

  test('shows the Bureau’s own words for a document it refuses, and stays on the page', async () => {
    const { container, getByRole, findByText, queryByText } = open();
    stub?.on('bureau.workflows.create', () => {
      throw workflowFaults.unprocessable('Invalid workflow file: steps: must not be empty');
    });
    await waitFor(() => expect(textarea(container)).toBeTruthy());
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    await findByText('Invalid workflow file: steps: must not be empty');
    expect(router.pathname).toBe('/workflows/new');
    expect(queryByText(WORKFLOW_COPY.creator.saveFailed)).not.toBeNull();
  });

  test('says the installation does not let you for a forbidden create', async () => {
    const { container, getByRole, findByText } = open();
    stub?.on('bureau.workflows.create', () => {
      throw new StubFault('Forbidden', 403, 'No.');
    });
    await waitFor(() => expect(textarea(container)).toBeTruthy());
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.forbidden);
  });

  test('lands on the new page for a file the Bureau wrote and the engine could not yet apply', async () => {
    const { container, getByRole } = open();
    stub?.on('bureau.workflows.create', () => {
      throw workflowFaults.applyFailed();
    });
    await waitFor(() => expect(textarea(container)).toBeTruthy());
    await typeInto(container, withName('half-done'));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/half-done'));
  });

  test('goes back to the list on cancel, and sends nothing', async () => {
    const { container, getByRole } = open();
    await waitFor(() => expect(textarea(container)).toBeTruthy());
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.cancelAction }));
    expect(router.pathname).toBe('/workflows');
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });
});
