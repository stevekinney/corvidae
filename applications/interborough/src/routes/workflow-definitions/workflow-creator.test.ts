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
import { shortcuts } from '../../lib/shortcuts.ts';
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

/** Opens the JSON tab, whose editor holds the file's text. */
async function openJson(container: HTMLElement): Promise<void> {
  const tab = await waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === WORKFLOW_COPY.builder.jsonTab,
    );
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  await fireEvent.click(tab);
  await waitFor(() => expect(textarea(container)).toBeTruthy());
}

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
    await openJson(container);

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
    await openJson(container);
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
    await openJson(container);
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
    await openJson(container);

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
    await openJson(container);

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
    await openJson(container);
    await typeInto(container, withName('digest'));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    await findByText(WORKFLOW_COPY.creator.taken('digest'));
    expect(router.pathname).toBe('/workflows/new');
    expect(stub?.world.files.map((file) => file.id)).toEqual(['digest']);
  });

  test('says only that the save failed for a fault that names nothing the person can act on', async () => {
    const { container, getByRole, findByRole } = open();
    await openJson(container);
    for (const fault of [
      workflowFaults.conflict('agent-file-exists'),
      workflowFaults.stale('hash', 'old'),
      workflowFaults.notFound('workflow'),
    ]) {
      stub?.on('bureau.workflows.create', () => {
        throw fault;
      });
      await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
      const alert = await findByRole('alert');
      expect(alert.textContent).toContain(WORKFLOW_COPY.creator.saveFailed);
      expect(alert.textContent).not.toContain(fault.message);
      expect(router.pathname).toBe('/workflows/new');
    }
  });

  test('shows the Bureau’s own words for a document it refuses, and stays on the page', async () => {
    const { container, getByRole, findByText, queryByText } = open();
    stub?.on('bureau.workflows.create', () => {
      throw workflowFaults.unprocessable('Invalid workflow file: steps: must not be empty');
    });
    await openJson(container);
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
    await openJson(container);
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.forbidden);
  });

  test('lands on the new page for a file the Bureau wrote and the engine could not yet apply', async () => {
    const { container, getByRole } = open();
    stub?.on('bureau.workflows.create', () => {
      throw workflowFaults.applyFailed();
    });
    await openJson(container);
    await typeInto(container, withName('half-done'));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/half-done'));
  });

  test('goes back to the list on cancel, and sends nothing', async () => {
    const { container, getByRole } = open();
    await openJson(container);
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.cancelAction }));
    expect(router.pathname).toBe('/workflows');
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });
});

describe('the step builder', () => {
  const labelled = (container: HTMLElement, label: string) =>
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"], input[id="${label}"]`);
  const field = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
  const button = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) =>
        candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
    ) as HTMLButtonElement;
  const builderTab = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === WORKFLOW_COPY.builder.builderTab,
    ) as HTMLElement;

  async function ready(container: HTMLElement): Promise<void> {
    await waitFor(() => expect(field(container, 'workflow-builder-name')).toBeTruthy());
  }

  test('opens on the Builder tab with the template as rows and a summary in plain words', async () => {
    const { container } = open();
    await ready(container);
    expect(field(container, 'workflow-builder-name').value).toBe(
      WORKFLOW_COPY.creator.templateName,
    );
    expect(field(container, 'workflow-builder-trigger-field').value).toBe(
      WORKFLOW_COPY.creator.templateSpec,
    );
    expect(container.querySelectorAll('[data-step-kind="agent"]')).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent,
    ).toContain(WORKFLOW_COPY.creator.templateMessage);
  });

  test('builds a workflow from rows, saves it, and sends the file the rows describe', async () => {
    const { container } = open();
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'built-here' },
    });
    await fireEvent.input(field(container, 'workflow-builder-description'), {
      target: { value: 'Built in the builder.' },
    });
    await fireEvent.change(field(container, 'workflow-builder-trigger-kind'), {
      target: { value: 'signal' },
    });
    await fireEvent.input(field(container, 'workflow-builder-trigger-field'), {
      target: { value: 'go' },
    });
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: 'Write it.' },
    });
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.addWait));
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.addSignal));
    await fireEvent.input(field(container, 'workflow-builder-step-3-signal'), {
      target: { value: 'approved' },
    });
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.moveEarlier(3)));
    await fireEvent.click(button(container, WORKFLOW_COPY.creator.saveAction));

    await waitFor(() => expect(router.pathname).toBe('/workflows/built-here'));
    expect(stub?.callsTo('bureau.workflows.create')[0]?.params).toEqual({
      id: 'built-here',
      definition: {
        description: 'Built in the builder.',
        trigger: { kind: 'signal', name: 'go' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: { agent: 'demo:assistant', message: 'Write it.' },
          },
          { kind: 'await-signal', signal: 'approved' },
          { kind: 'sleep', duration: '1m' },
        ],
      },
    });
  });

  test('keeps a multi-line message and description through edits, and saves them as written', async () => {
    const { container } = open();
    await ready(container);
    const message = 'First line.\n\nThird line, after a blank one.';
    const description = 'About it.\nMore about it.';
    expect(field(container, 'workflow-builder-step-1-message').tagName).toBe('TEXTAREA');
    expect(field(container, 'workflow-builder-description').tagName).toBe('TEXTAREA');
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: message },
    });
    await fireEvent.input(field(container, 'workflow-builder-description'), {
      target: { value: description },
    });
    // An edit elsewhere re-reads the text; the multi-line values must come back unchanged.
    await fireEvent.input(field(container, 'workflow-builder-trigger-field'), {
      target: { value: '2h' },
    });
    expect(field(container, 'workflow-builder-step-1-message').value).toBe(message);
    expect(field(container, 'workflow-builder-description').value).toBe(description);
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: `${message}\nAppended.` },
    });
    await fireEvent.click(button(container, WORKFLOW_COPY.creator.saveAction));

    await waitFor(() => expect(stub?.callsTo('bureau.workflows.create')).toHaveLength(1));
    const definition = stub?.callsTo('bureau.workflows.create')[0]?.params['definition'] as {
      description: string;
      steps: { input: { message: string } }[];
    };
    expect(definition.description).toBe(description);
    expect(definition.steps[0]?.input.message).toBe(`${message}\nAppended.`);
  });

  test('does not save when a form submits from Enter in a field, only from Save or ⌘Enter', async () => {
    const { container } = open();
    await ready(container);
    const form = container.querySelector('form') as HTMLFormElement;
    const submitted = new window.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitted);
    expect(submitted.defaultPrevented).toBe(true);
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
    expect(form.querySelector('button[type="submit"]')).toBeNull();
    expect(router.pathname).toBe('/workflows/new');

    await fireEvent.click(button(container, WORKFLOW_COPY.creator.saveAction));
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.create')).toHaveLength(1));
  });

  test('says a wait’s bare number is milliseconds in the field, and that a wait passes no result on', async () => {
    const { container } = open();
    await ready(container);
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.addWait));
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.addAgent));
    await fireEvent.input(field(container, 'workflow-builder-step-2-duration'), {
      target: { value: '5000' },
    });
    expect(container.textContent).toContain(WORKFLOW_COPY.builder.durationDescription);
    expect(container.textContent).toContain(WORKFLOW_COPY.builder.stepsDescription);
    const summary = container.querySelector('[data-testid="workflow-builder-summary"]');
    expect(summary?.textContent).toContain('Sleep for 5000 ms');
    expect(summary?.textContent).toContain(WORKFLOW_COPY.builder.afterWaitSummary);
  });

  test('leaves a file it cannot represent to the JSON tab: no add, no step fields, no trigger edit', async () => {
    const { container, findByTestId } = open();
    await ready(container);
    await openJson(container);
    await typeInto(
      container,
      JSON.stringify({
        name: 'odd',
        trigger: 'hourly',
        steps: [{ kind: 'activity', handler: 'agent', input: 'Write it.' }],
      }),
    );
    await fireEvent.click(builderTab(container));
    await ready(container);
    expect(container.textContent).toContain(WORKFLOW_COPY.builder.otherStepNote);
    expect(container.textContent).toContain(WORKFLOW_COPY.builder.otherTrigger);
    expect(container.querySelector('#workflow-builder-step-1-message')).toBeNull();
    expect(field(container, 'workflow-builder-trigger-kind').disabled).toBe(true);

    await openJson(container);
    await typeInto(container, JSON.stringify({ name: 'odd', steps: 'later' }));
    await fireEvent.click(builderTab(container));
    await findByTestId('workflow-builder-steps-unreadable');
    expect(button(container, WORKFLOW_COPY.builder.addAgent)).toBeUndefined();
    expect(button(container, WORKFLOW_COPY.builder.addWait)).toBeUndefined();
    await openJson(container);
    expect(JSON.parse(textarea(container).value)).toEqual({ name: 'odd', steps: 'later' });
  });

  test('shows a JSON edit in the builder, and a builder edit in the JSON', async () => {
    const { container } = open();
    await ready(container);

    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'from-builder' },
    });
    await openJson(container);
    expect((JSON.parse(textarea(container).value) as { name: string }).name).toBe('from-builder');

    await typeInto(
      container,
      JSON.stringify({
        name: 'from-json',
        trigger: { kind: 'schedule', spec: '5m' },
        steps: [{ kind: 'sleep', duration: '30s' }],
      }),
    );
    await fireEvent.click(builderTab(container));
    await ready(container);
    expect(field(container, 'workflow-builder-name').value).toBe('from-json');
    expect(field(container, 'workflow-builder-trigger-field').value).toBe('5m');
    expect(field(container, 'workflow-builder-step-1-duration').value).toBe('30s');
    expect(labelled(container, 'workflow-builder-step-1-agent')).toBeNull();
  });

  test('keeps the keys the builder has no control for through its edits', async () => {
    const { container, getByRole } = open();
    await ready(container);
    await openJson(container);
    await typeInto(
      container,
      JSON.stringify({
        name: 'keeps-keys',
        paused: true,
        inputSchema: { type: 'object' },
        trigger: { kind: 'schedule', spec: '1h', overlap: 'skip' },
        steps: [{ kind: 'sleep', duration: '1m' }],
      }),
    );
    await fireEvent.click(builderTab(container));
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-trigger-field'), {
      target: { value: '2h' },
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/keeps-keys'));
    expect(stub?.callsTo('bureau.workflows.create')[0]?.params['definition']).toEqual({
      paused: true,
      inputSchema: { type: 'object' },
      trigger: { kind: 'schedule', spec: '2h', overlap: 'skip' },
      steps: [{ kind: 'sleep', duration: '1m' }],
    });
  });

  test('removes a step, and an empty list is the first-use empty state with a way to add one', async () => {
    const { container, findByText } = open();
    await ready(container);
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.remove(1)));

    await findByText(WORKFLOW_COPY.builder.noSteps.title);
    expect(container.querySelector('[data-testid="workflow-builder-summary"]')).not.toBeNull();
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.addAgent));
    await waitFor(() =>
      expect(container.querySelectorAll('[data-step-kind="agent"]')).toHaveLength(1),
    );
  });

  test('says the builder needs valid JSON, and opens the JSON tab from there', async () => {
    const { container, findByText } = open();
    await ready(container);
    await openJson(container);
    await typeInto(container, '{ not json');
    await fireEvent.click(builderTab(container));

    await findByText(WORKFLOW_COPY.builder.unreadable.title);
    await fireEvent.click(button(container, WORKFLOW_COPY.builder.unreadable.action));
    await waitFor(() => expect(textarea(container).value).toBe('{ not json'));
  });

  test('shows a refusal on the Builder tab, and keeps the draft', async () => {
    const { container, getByRole, findByText } = open();
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'Bad_Name' },
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.creator.invalidName);
    expect(field(container, 'workflow-builder-name').value).toBe('Bad_Name');
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });

  test('registers ⌘Enter, which saves from a field, and removes it when the page goes', async () => {
    const { container, unmount } = open();
    await ready(container);
    const press = (): boolean =>
      shortcuts.handleKey(
        { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
        { routePattern: '/workflows/new', regions: [] },
        Date.now(),
      );

    expect(press()).toBe(true);
    await waitFor(() =>
      expect(router.pathname).toBe(`/workflows/${WORKFLOW_COPY.creator.templateName}`),
    );
    expect(stub?.callsTo('bureau.workflows.create')).toHaveLength(1);

    unmount();
    expect(press()).toBe(false);
  });

  test('marks Save as a control that changes something', async () => {
    const { container, getByRole } = open();
    await ready(container);
    expect(
      getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).hasAttribute('data-changes'),
    ).toBe(true);
  });
});
