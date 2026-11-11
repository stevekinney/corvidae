/**
 * `/workflows/new`: the builder over a new workflow's file, saved through
 * `bureau.workflows.create`. On first open nothing is chosen for the person: it starts when someone
 * runs it, with one empty agent step that names no agent and no ID. The `name` in the text is the
 * identifier and is not sent; a title makes it. Text that is not JSON, a name that is not an
 * identifier or is `new`, and a taken name show the error and save nothing; a document the Bureau
 * refuses shows its words. A save lands on the new page.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
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
  type World,
} from '../../lib/workflow-world.test-support.ts';
import Harness from './area-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;
let restoreViewport: (() => void) | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  restoreViewport?.();
  restoreViewport = undefined;
});

const BUILDER = WORKFLOW_COPY.builder;

/** The agents a host lists, as `bureau.agents.list` answers them. */
const listed = (...names: readonly string[]) =>
  names.map((name) => ({
    name,
    displayName: name,
    description: null,
    definitionRevision: 1,
    kind: 'code',
    a2a: false,
  }));

function open(agents: ReadonlyArray<Record<string, unknown>> = [], overrides: Partial<World> = {}) {
  stub = installWorkflowWorld(
    emptyWorld({ files: [readyFile('digest')], agents: [...agents], ...overrides }),
  );
  router.navigate('/workflows/new', { replace: true });
  return render(Harness, { props: { client: stub.client, scopes: AUTHORIZATION_SCOPES } } as never);
}

/** Makes the viewport a phone, which is what `phoneViewport` reads. */
function phone(): void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(width < 640px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  restoreViewport = () => {
    window.matchMedia = original;
  };
}

/** The JSON tab's editor; the Builder tab's panel is not drawn while the JSON tab is open. */
const textarea = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea') as HTMLTextAreaElement;

/** Opens the JSON tab, whose editor holds the file's text. */
async function openJson(container: HTMLElement): Promise<void> {
  const tab = await waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === BUILDER.jsonTab,
    );
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  await fireEvent.click(tab);
  await waitFor(() =>
    expect(container.querySelector('#workflow-builder-description')?.outerHTML ?? null).toBeNull(),
  );
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
  test('opens with nothing chosen: no ID, started when someone runs it, one empty agent step, and no probe of its own', async () => {
    const { container, findByRole } = open();
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.creator.heading });
    expect(container.textContent).toContain(WORKFLOW_COPY.creator.description);
    await openJson(container);

    const template = JSON.parse(textarea(container).value) as Record<string, unknown>;
    expect(template).toEqual({
      name: '',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'activity', handler: 'agent', input: { agent: '', message: '' } }],
    });
    // The frame has nothing to ask the engine or the Bureau: this is where the first workflow is made.
    expect(stub?.callsTo('bureau.workflows.list')).toEqual([]);
    expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('names no agent in its step, even when the host lists agents that can run', async () => {
    const { container, findByRole } = open(listed('notes', 'demo:assistant'));
    await findByRole('heading', { level: 1, name: WORKFLOW_COPY.creator.heading });
    await waitFor(() => expect(stub?.callsTo('bureau.agents.list').length).toBeGreaterThan(0));
    await openJson(container);

    const template = JSON.parse(textarea(container).value) as { steps: Array<{ input: unknown }> };
    expect(template.steps[0]?.input).toEqual({ agent: '', message: '' });
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

  test('refuses the untouched form, which has no ID, and creates nothing', async () => {
    const { container, getByRole, findByText } = open();
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await findByText(WORKFLOW_COPY.creator.invalidName);
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
    expect(router.pathname).toBe('/workflows/new');
    // The ID is the first problem, so it takes focus.
    await waitFor(() => expect(document.activeElement?.id).toBe('workflow-builder-name'));
    const lines = container.querySelector('[data-testid="workflow-builder-problems"]');
    expect(lines?.textContent?.trim()).toBe(
      `${BUILDER.problems.summaryLead(3)} ${BUILDER.problems.summary.id} ${BUILDER.problems.summary.agent(1)} ${BUILDER.problems.summary.message(1)}`,
    );
  });

  test('refuses text that is not JSON, and a JSON value that is not an object, says the line to fix once, and sends nothing', async () => {
    const { container, getByRole } = open();
    await openJson(container);
    const footer = () =>
      container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent ?? '';

    await typeInto(container, '{ not json');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(footer()).toContain(BUILDER.json.fixLine(1)));
    expect(container.textContent?.split(BUILDER.json.fixLine(1))).toHaveLength(2);

    await typeInto(container, '[]');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(footer()).toContain(BUILDER.json.fixLine(1)));
    expect(container.textContent).toContain(BUILDER.json.notWorkflow);
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
    await typeInto(container, withName('fresh-flow'));
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
    await typeInto(container, withName('fresh-flow'));
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
    await typeInto(container, withName('fresh-flow'));
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

describe('the builder', () => {
  const field = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
  const button = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) =>
        candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
    ) as HTMLButtonElement;
  const builderTab = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === BUILDER.builderTab,
    ) as HTMLElement;
  /** A choice under Starts, by its value: `manual`, `schedule`, `signal`, or a plugin's kind. */
  const start = (container: HTMLElement, value: string) =>
    container.querySelector<HTMLButtonElement>(
      `#workflow-builder-trigger-kind [data-cinder-segment-value="${value}"]`,
    ) as HTMLButtonElement;
  const summary = (container: HTMLElement) =>
    container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent ?? '';
  const created = () =>
    stub?.callsTo('bureau.workflows.create')[0]?.params as
      { id: string; definition: Record<string, unknown> } | undefined;

  async function ready(container: HTMLElement): Promise<void> {
    await waitFor(() => expect(field(container, 'workflow-builder-title')).toBeTruthy());
  }

  /** Waits until the agent select of a step offers `agent`, then chooses it. */
  async function chooseAgent(container: HTMLElement, position: number, agent: string) {
    const id = `workflow-builder-step-${String(position)}-agent`;
    await waitFor(() =>
      expect(container.querySelector(`#${id} option[value="${agent}"]`)).toBeTruthy(),
    );
    await fireEvent.change(field(container, id), { target: { value: agent } });
  }

  test('opens on the Builder tab with every field a placeholder, Starts on “When you run it”, and one empty agent step with only a delete button', async () => {
    const { container } = open(listed('demo:assistant'));
    await ready(container);
    expect(field(container, 'workflow-builder-title').value).toBe('');
    expect(field(container, 'workflow-builder-title').placeholder).toBe(BUILDER.titlePlaceholder);
    expect(field(container, 'workflow-builder-name').value).toBe('');
    expect(field(container, 'workflow-builder-name').placeholder).toBe(BUILDER.idPlaceholder);
    expect(field(container, 'workflow-builder-name').required).toBe(true);
    expect(container.textContent).toContain(BUILDER.idDescription);
    expect(field(container, 'workflow-builder-description').placeholder).toBe(
      BUILDER.descriptionPlaceholder,
    );

    expect(
      [
        ...container.querySelectorAll('#workflow-builder-trigger-kind [data-cinder-segment-value]'),
      ].map((segment) => segment.textContent?.trim()),
    ).toEqual([BUILDER.triggers.manual, BUILDER.triggers.schedule, BUILDER.triggers.signal]);
    expect(start(container, 'manual').getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain(BUILDER.manualHint);

    const cards = container.querySelectorAll('[data-step-kind]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute('data-step-kind')).toBe('agent');
    expect(field(container, 'workflow-builder-step-1-title').placeholder).toBe(
      BUILDER.stepKinds.agent,
    );
    expect(field(container, 'workflow-builder-step-1-agent').value).toBe('');
    expect(field(container, 'workflow-builder-step-1-message').placeholder).toBe(
      BUILDER.messagePlaceholder,
    );
    expect(button(container, BUILDER.remove(1))).toBeTruthy();
    expect(button(container, BUILDER.moveEarlier(1))).toBeUndefined();
    expect(button(container, BUILDER.moveLater(1))).toBeUndefined();

    expect(container.textContent).toContain(BUILDER.inputEmpty);
    expect(container.textContent).toContain(BUILDER.outputEmpty);
    expect(summary(container)).toContain('Fill in step 1 to see what this workflow does.');
  });

  test('offers the four kinds of step, each with a plus, under the steps', async () => {
    const { container } = open();
    await ready(container);
    const group = container.querySelector(`[role="group"][aria-label="${BUILDER.addLabel}"]`);
    expect(
      [...(group?.querySelectorAll('button') ?? [])].map((candidate) =>
        candidate.textContent?.trim(),
      ),
    ).toEqual([BUILDER.add.agent, BUILDER.add.person, BUILDER.add.signal, BUILDER.add.wait]);
    expect(group?.querySelectorAll('button svg')).toHaveLength(4);
  });

  test('makes the ID from the title, collapses it to a line with Change, and opens it again', async () => {
    const { container } = open();
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-title'), {
      target: { value: 'Morning Briefing' },
    });

    const line = await waitFor(() => {
      const found = container.querySelector('[data-testid="workflow-builder-id-line"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(line.textContent).toContain('morning-briefing');
    expect(line.textContent).toContain(BUILDER.idFixedOnCreate);
    expect(field(container, 'workflow-builder-name')).toBeNull();

    await fireEvent.click(button(container, BUILDER.idChange));
    await waitFor(() =>
      expect(field(container, 'workflow-builder-name').value).toBe('morning-briefing'),
    );
    expect(container.textContent).toContain(BUILDER.idFile('morning-briefing'));
    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'briefing' },
    });
    await fireEvent.click(button(container, BUILDER.useDerivedId));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="workflow-builder-id-line"]')).toBeTruthy(),
    );

    await openJson(container);
    expect(JSON.parse(textarea(container).value)).toMatchObject({
      name: 'morning-briefing',
      title: 'Morning Briefing',
    });
  });

  test('builds a workflow from cards, saves it, and sends the file the cards describe', async () => {
    const { container } = open(listed('demo:assistant'));
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-title'), {
      target: { value: 'Built here' },
    });
    await fireEvent.input(field(container, 'workflow-builder-description'), {
      target: { value: 'Built in the builder.' },
    });
    await fireEvent.click(start(container, 'signal'));
    await waitFor(() => expect(field(container, 'workflow-builder-trigger-field')).toBeTruthy());
    await fireEvent.input(field(container, 'workflow-builder-trigger-field'), {
      target: { value: 'go' },
    });
    await chooseAgent(container, 1, 'demo:assistant');
    await fireEvent.input(field(container, 'workflow-builder-step-1-title'), {
      target: { value: 'Write it up' },
    });
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: 'Write it.' },
    });
    await fireEvent.click(button(container, BUILDER.add.wait));
    await fireEvent.click(button(container, BUILDER.add.signal));
    await fireEvent.click(button(container, BUILDER.add.person));
    await fireEvent.input(field(container, 'workflow-builder-step-3-signal'), {
      target: { value: 'approved' },
    });
    await fireEvent.click(button(container, BUILDER.moveEarlier(3)));
    await fireEvent.click(button(container, WORKFLOW_COPY.creator.saveAction));

    await waitFor(() => expect(router.pathname).toBe('/workflows/built-here'));
    expect(created()).toEqual({
      id: 'built-here',
      definition: {
        title: 'Built here',
        description: 'Built in the builder.',
        trigger: { kind: 'signal', name: 'go' },
        steps: [
          {
            title: 'Write it up',
            kind: 'activity',
            handler: 'agent',
            input: { agent: 'demo:assistant', message: 'Write it.' },
          },
          { kind: 'await-signal', signal: 'approved' },
          { kind: 'sleep', duration: '1m' },
          {
            kind: 'await-signal',
            signal: expect.stringMatching(/^review-[0-9a-f]{8}$/),
            review: true,
          },
        ],
      },
    });
  });

  test('a wait for a person shows only its name and what happens while it waits', async () => {
    const { container } = open();
    await ready(container);
    await fireEvent.click(button(container, BUILDER.add.person));
    const card = await waitFor(() => {
      const found = container.querySelector('[data-step-kind="person"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain(BUILDER.personDescription);
    expect(card.querySelectorAll('input, textarea, select')).toHaveLength(1);
    expect(card.querySelector('#workflow-builder-step-2-title')).toBeTruthy();
    expect(summary(container)).toContain('Fill in step 1');
  });

  test('a wait is For a number of a Unit, and a wait in milliseconds keeps a field of its own', async () => {
    const { container } = open();
    await ready(container);
    await fireEvent.click(button(container, BUILDER.remove(1)));
    await fireEvent.click(button(container, BUILDER.add.wait));
    await waitFor(() => expect(field(container, 'workflow-builder-step-1-duration')).toBeTruthy());
    expect(field(container, 'workflow-builder-step-1-duration').value).toBe('1');
    expect(field(container, 'workflow-builder-step-1-unit').value).toBe('minutes');
    await fireEvent.input(field(container, 'workflow-builder-step-1-duration'), {
      target: { value: '15' },
    });
    await waitFor(() => expect(summary(container)).toContain('wait 15 minutes'));
    expect(container.textContent).toContain(BUILDER.stepsDescription);

    await openJson(container);
    expect(JSON.parse(textarea(container).value)).toMatchObject({
      steps: [{ kind: 'sleep', duration: '15m' }],
    });
    await typeInto(
      container,
      JSON.stringify({
        name: 'ms',
        trigger: { kind: 'manual' },
        steps: [{ kind: 'sleep', duration: 5000 }],
      }),
    );
    await fireEvent.click(builderTab(container));
    await ready(container);
    expect(field(container, 'workflow-builder-step-1-unit')).toBeNull();
    expect(container.textContent).toContain(BUILDER.durationDescription);
    expect(summary(container)).toContain('wait 5000 ms');
  });

  test('a wait keeps its Unit while For is empty, whether For is cleared and retyped or a Unit is chosen first', async () => {
    const { container } = open();
    await ready(container);
    await fireEvent.click(button(container, BUILDER.remove(1)));
    await fireEvent.click(button(container, BUILDER.add.wait));
    await waitFor(() => expect(field(container, 'workflow-builder-step-1-unit')).toBeTruthy());
    await fireEvent.change(field(container, 'workflow-builder-step-1-unit'), {
      target: { value: 'hours' },
    });
    await fireEvent.input(field(container, 'workflow-builder-step-1-duration'), {
      target: { value: '2' },
    });
    await waitFor(() => expect(summary(container)).toContain('wait 2 hours'));

    // Cleared to type a new number: Unit stays hours, and 3 is saved as 3 hours.
    await fireEvent.input(field(container, 'workflow-builder-step-1-duration'), {
      target: { value: '' },
    });
    await waitFor(() =>
      expect(field(container, 'workflow-builder-step-1-duration').value).toBe(''),
    );
    expect(field(container, 'workflow-builder-step-1-unit').value).toBe('hours');
    await fireEvent.input(field(container, 'workflow-builder-step-1-duration'), {
      target: { value: '3' },
    });
    await waitFor(() => expect(summary(container)).toContain('wait 3 hours'));

    // A Unit chosen while For is empty is kept, and the number typed next is of that Unit.
    await fireEvent.input(field(container, 'workflow-builder-step-1-duration'), {
      target: { value: '' },
    });
    await waitFor(() =>
      expect(field(container, 'workflow-builder-step-1-duration').value).toBe(''),
    );
    await fireEvent.change(field(container, 'workflow-builder-step-1-unit'), {
      target: { value: 'days' },
    });
    await waitFor(() =>
      expect(field(container, 'workflow-builder-step-1-unit').value).toBe('days'),
    );
    await fireEvent.input(field(container, 'workflow-builder-step-1-duration'), {
      target: { value: '4' },
    });
    await waitFor(() => expect(summary(container)).toContain('wait 4 days'));

    await openJson(container);
    expect(JSON.parse(textarea(container).value)).toMatchObject({
      steps: [{ kind: 'sleep', duration: '4d' }],
    });
  });

  test('keeps a multi-line message and description through edits, and saves them as written', async () => {
    const { container } = open(listed('demo:assistant'));
    await ready(container);
    await chooseAgent(container, 1, 'demo:assistant');
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
    await fireEvent.input(field(container, 'workflow-builder-title'), {
      target: { value: 'Multi line' },
    });
    expect(field(container, 'workflow-builder-step-1-message').value).toBe(message);
    expect(field(container, 'workflow-builder-description').value).toBe(description);
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: `${message}\nAppended.` },
    });
    await fireEvent.click(button(container, WORKFLOW_COPY.creator.saveAction));

    await waitFor(() => expect(stub?.callsTo('bureau.workflows.create')).toHaveLength(1));
    const definition = created()?.definition as {
      description: string;
      steps: { input: { message: string } }[];
    };
    expect(definition.description).toBe(description);
    expect(definition.steps[0]?.input.message).toBe(`${message}\nAppended.`);
  });

  test('does not save when a form submits from Enter in a field, only from Create or ⌘Enter', async () => {
    const { container } = open(listed('demo:assistant'));
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'from-enter' },
    });
    await chooseAgent(container, 1, 'demo:assistant');
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: 'Say hello.' },
    });
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
    expect(container.textContent).toContain(BUILDER.otherStepNote);
    expect(container.textContent).toContain(BUILDER.otherTrigger);
    expect(container.querySelector('#workflow-builder-step-1-message')).toBeNull();
    expect(
      container.querySelector('#workflow-builder-trigger-kind')?.getAttribute('aria-disabled'),
    ).toBe('true');

    await openJson(container);
    await typeInto(container, JSON.stringify({ name: 'odd', steps: 'later' }));
    await fireEvent.click(builderTab(container));
    await findByTestId('workflow-builder-steps-unreadable');
    expect(button(container, BUILDER.add.agent)).toBeUndefined();
    expect(button(container, BUILDER.add.wait)).toBeUndefined();
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
    expect(start(container, 'schedule').getAttribute('aria-checked')).toBe('true');
    expect(field(container, 'workflow-builder-trigger-field').value).toBe('5m');
    expect(field(container, 'workflow-builder-step-1-duration').value).toBe('30');
    expect(field(container, 'workflow-builder-step-1-unit').value).toBe('seconds');
    expect(container.querySelector('#workflow-builder-step-1-agent')).toBeNull();
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
        agent: 'writer',
        trigger: {
          kind: 'schedule',
          spec: '0 6 * * *',
          timezone: 'America/Chicago',
          overlap: 'skip',
        },
        steps: [{ kind: 'sleep', duration: '1m' }],
      }),
    );
    await fireEvent.click(builderTab(container));
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-trigger-field'), {
      target: { value: '0 7 * * *' },
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/keeps-keys'));
    expect(created()?.definition).toEqual({
      paused: true,
      agent: 'writer',
      trigger: {
        kind: 'schedule',
        spec: '0 7 * * *',
        timezone: 'America/Chicago',
        overlap: 'skip',
      },
      steps: [{ kind: 'sleep', duration: '1m' }],
    });
  });

  test('removes a step, says the list needs one, and adds an agent step that names no agent', async () => {
    const { container, findByText } = open(listed('notes'));
    await ready(container);
    await fireEvent.click(button(container, BUILDER.remove(1)));

    await findByText(BUILDER.noSteps);
    expect(summary(container)).toContain(BUILDER.readBack.noSteps);
    await fireEvent.click(button(container, BUILDER.add.agent));
    await waitFor(() =>
      expect(container.querySelectorAll('[data-step-kind="agent"]')).toHaveLength(1),
    );
    expect(field(container, 'workflow-builder-step-1-agent').value).toBe('');
  });

  test('says a model agent won’t run while no provider is connected, and still saves', async () => {
    const { container } = open(listed('assistant', 'tool-runner'), {
      agentModels: { assistant: null, 'tool-runner': 'anthropic/claude-sonnet' },
      attention: [{ kind: 'no-provider', area: 'providers', at: null, provider: null }],
    });
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'refund' },
    });
    await chooseAgent(container, 1, 'assistant');
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: 'Look up order 4471.' },
    });
    expect(container.textContent).not.toContain(BUILDER.needsProvider);

    await chooseAgent(container, 1, 'tool-runner');
    await waitFor(() => expect(container.textContent).toContain(BUILDER.needsProvider));
    expect(summary(container)).toContain(
      'Run it when you press Start run, then ask Tool runner to look up order 4471.',
    );
    await fireEvent.click(button(container, WORKFLOW_COPY.creator.saveAction));
    await waitFor(() => expect(router.pathname).toBe('/workflows/refund'));
  });

  test('is read-only below 640 pixels, and links back to Workflows', async () => {
    phone();
    const { container } = open();
    await ready(container);
    const notice = container.querySelector('[data-testid="workflow-builder-phone"]');
    expect(notice?.textContent).toContain(BUILDER.phone.message);
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/workflows');
    expect(container.querySelector('.weft-workflow-builder__body')?.hasAttribute('inert')).toBe(
      true,
    );
    expect(container.querySelector('.weft-workflow-builder__actions')?.hasAttribute('inert')).toBe(
      true,
    );
    await openJson(container);
    expect(container.querySelector('.weft-workflow-builder__json')?.hasAttribute('inert')).toBe(
      true,
    );
    expect(container.textContent).toContain(BUILDER.phone.message);
  });

  test('turns the Builder tab off with the reason while the JSON is not valid, and says nothing is dropped', async () => {
    const { container } = open();
    await ready(container);
    await openJson(container);
    // The line the parser stops at is the one after the comma it wanted.
    const broken = JSON.stringify(
      { name: 'odd', trigger: { kind: 'manual' }, steps: [] },
      null,
      2,
    ).replace('"name": "odd",', '"name": "odd"');
    await typeInto(container, broken);

    const tab = builderTab(container);
    await waitFor(() => expect(tab.hasAttribute('disabled')).toBe(true));
    // The marked line is the one the comma is missing at the end of, not the one the parser stops at.
    const reason = BUILDER.json.fixLine(2);
    expect(summary(container)).toContain(reason);
    expect(
      document.getElementById(tab.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain(reason);
    await fireEvent.click(tab);
    expect(textarea(container).value).toBe(broken);
    expect(container.querySelector('#workflow-builder-title')).toBeNull();
  });

  test('opens on the JSON tab for text it cannot read, and lets the Builder back once the JSON is valid', async () => {
    const { container } = open();
    await ready(container);
    await openJson(container);
    await typeInto(container, '{ not json');
    await waitFor(() => expect(builderTab(container).hasAttribute('disabled')).toBe(true));

    await typeInto(container, withName('fixed-it'));
    await waitFor(() => expect(builderTab(container).hasAttribute('disabled')).toBe(false));
    await fireEvent.click(builderTab(container));
    await waitFor(() => expect(field(container, 'workflow-builder-name').value).toBe('fixed-it'));
    expect(summary(container)).not.toContain(BUILDER.json.fixLine(1));
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
    const { container, unmount } = open(listed('demo:assistant'));
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'keyboard-flow' },
    });
    await chooseAgent(container, 1, 'demo:assistant');
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: 'Say hello.' },
    });
    const press = (): boolean =>
      shortcuts.handleKey(
        { key: 'Enter', metaKey: true, ctrlKey: false, altKey: false, editable: true },
        { routePattern: '/workflows/new', regions: [] },
        Date.now(),
      );

    expect(press()).toBe(true);
    await waitFor(() => expect(router.pathname).toBe('/workflows/keyboard-flow'));
    expect(stub?.callsTo('bureau.workflows.create')).toHaveLength(1);

    unmount();
    expect(press()).toBe(false);
  });

  test('puts Cancel and Create in the footer beside the read-back, and marks Create as a control that changes something', async () => {
    const { container, getByRole } = open();
    await ready(container);
    const create = getByRole('button', { name: WORKFLOW_COPY.creator.saveAction });
    expect(create.hasAttribute('data-changes')).toBe(true);
    const footer = container.querySelector('.weft-workflow-builder__footer');
    expect(footer?.contains(create)).toBe(true);
    expect(
      footer?.contains(getByRole('button', { name: WORKFLOW_COPY.creator.cancelAction })),
    ).toBe(true);
  });

  /** Fills the first step and the ID, so the form has nothing left to fix. */
  async function fillValid(container: HTMLElement, id: string): Promise<void> {
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-name'), { target: { value: id } });
    await chooseAgent(container, 1, 'demo:assistant');
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: 'Say hello.' },
    });
  }

  test('says nothing is wrong until Create is pressed, then says each problem at its field, outlines its step, sums two up, and focuses the first', async () => {
    const { container, getByRole } = open(listed('demo:assistant'));
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-title'), {
      target: { value: 'Morning Briefing' },
    });
    await chooseAgent(container, 1, 'demo:assistant');
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: 'Summarize yesterday.' },
    });
    await fireEvent.click(button(container, BUILDER.add.signal));
    await fireEvent.click(button(container, BUILDER.add.agent));
    await chooseAgent(container, 3, 'demo:assistant');
    expect(container.querySelector('[data-problem]')).toBeNull();
    expect(container.textContent).not.toContain(BUILDER.problems.signal);
    expect(container.querySelector('[data-testid="workflow-builder-problems"]')).toBeNull();

    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(document.activeElement?.id).toBe('workflow-builder-step-2-signal'));
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
    expect(
      [...container.querySelectorAll('[data-step-kind]')].map((card) =>
        card.hasAttribute('data-problem'),
      ),
    ).toEqual([false, true, true]);
    expect(container.textContent).toContain(BUILDER.problems.signal);
    expect(container.textContent).toContain(BUILDER.problems.message);
    expect(
      container.querySelector('[data-testid="workflow-builder-problems"]')?.textContent?.trim(),
    ).toBe(
      `${BUILDER.problems.summaryLead(2)} ${BUILDER.problems.summary.signal(2)} ${BUILDER.problems.summary.message(3)}`,
    );
    // The ID the title made never fails for its capitals.
    expect(
      container.querySelector('[data-testid="workflow-builder-id-line"]')?.textContent,
    ).toContain('morning-briefing');
  });

  test('says one problem at its field and takes focus there, without the summary line', async () => {
    const { container, getByRole } = open(listed('demo:assistant'));
    await fillValid(container, 'one-problem');
    await fireEvent.input(field(container, 'workflow-builder-step-1-message'), {
      target: { value: '' },
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    await waitFor(() => expect(document.activeElement?.id).toBe('workflow-builder-step-1-message'));
    expect(container.textContent).toContain(BUILDER.problems.message);
    expect(container.querySelector('[data-testid="workflow-builder-problems"]')).toBeNull();
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });

  test('with every step deleted, says to add one once, reads the footer that way, and Create focuses Add a step', async () => {
    const { container, getByRole } = open();
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'no-steps' },
    });
    await fireEvent.click(button(container, BUILDER.remove(1)));
    await waitFor(() => expect(container.textContent).toContain(BUILDER.noSteps));
    expect(summary(container)).toContain(BUILDER.readBack.noSteps);
    expect(button(container, BUILDER.add.agent)).toBeTruthy();

    const create = getByRole('button', { name: WORKFLOW_COPY.creator.saveAction });
    expect(create.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(create);
    await waitFor(() => expect(document.activeElement?.id).toBe('workflow-builder-add-agent'));
    expect(container.textContent?.split(BUILDER.noSteps)).toHaveLength(2);
    expect(container.querySelector('[data-testid="workflow-builder-problems"]')).toBeNull();
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });

  test('takes the person from the JSON tab to the first step field that is empty', async () => {
    const { container, getByRole } = open();
    await ready(container);
    await openJson(container);
    await typeInto(
      container,
      JSON.stringify({
        name: 'from-json',
        trigger: { kind: 'manual' },
        steps: [{ kind: 'activity', handler: 'agent', input: { agent: '', message: 'Hi.' } }],
      }),
    );
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    await waitFor(() => expect(field(container, 'workflow-builder-step-1-agent')).toBeTruthy());
    await waitFor(() => expect(document.activeElement?.id).toBe('workflow-builder-step-1-agent'));
    expect(container.textContent).toContain(BUILDER.problems.agent);
    expect(stub?.callsTo('bureau.workflows.create')).toEqual([]);
  });

  test('opens the ID with a link to the workflow that has it when the ID is taken, keeps Create pressable, and focuses the ID', async () => {
    const { container, getByRole } = open(listed('demo:assistant'));
    await fillValid(container, 'digest');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    const note = await waitFor(() => {
      const found = container.querySelector('[data-testid="workflow-builder-id-taken"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(note.textContent?.trim()).toBe(WORKFLOW_COPY.creator.taken('digest'));
    const link = note.querySelector('a');
    expect(link?.textContent).toBe(WORKFLOW_COPY.creator.takenLink);
    expect(link?.getAttribute('href')).toBe('/workflows/digest');
    await waitFor(() => expect(document.activeElement?.id).toBe('workflow-builder-name'));
    expect(field(container, 'workflow-builder-name').value).toBe('digest');
    expect(stub?.callsTo('bureau.workflows.create')).toHaveLength(1);

    // The taken ID is a problem already known, so pressing Create again asks the Bureau nothing.
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    expect(stub?.callsTo('bureau.workflows.create')).toHaveLength(1);
    expect(router.pathname).toBe('/workflows/new');

    await fireEvent.input(field(container, 'workflow-builder-name'), {
      target: { value: 'digest-two' },
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-builder-id-taken"]')?.outerHTML ?? null,
      ).toBeNull(),
    );
  });

  test('says a create that could not write above the footer, keeps everything typed, and has no Try again', async () => {
    const { container, getByRole, findByText } = open(listed('demo:assistant'));
    const reason =
      '~/.interborough/workflows/morning-briefing.json couldn’t be written: permission denied.';
    stub?.on('bureau.workflows.create', () => {
      throw workflowFaults.unprocessable(reason);
    });
    await fillValid(container, 'morning-briefing');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    await findByText(reason);
    const alert = getByRole('alert');
    expect(alert.textContent).toContain(WORKFLOW_COPY.creator.saveFailed);
    expect(alert.textContent).toContain(WORKFLOW_COPY.creator.nothingSaved);
    expect(container.querySelector('footer')?.previousElementSibling?.contains(alert)).toBe(true);
    expect(button(container, 'Try again')).toBeUndefined();
    expect(field(container, 'workflow-builder-name').value).toBe('morning-briefing');
    expect(field(container, 'workflow-builder-step-1-message').value).toBe('Say hello.');
    expect(router.pathname).toBe('/workflows/new');
  });

  test('reads Creating and holds the whole form read-only while the file is written', async () => {
    const { container, getByRole } = open(listed('demo:assistant'));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub?.on('bureau.workflows.create', async () => {
      await held;
      throw workflowFaults.unprocessable('Refused.');
    });
    await fillValid(container, 'slow-flow');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));

    const creating = await waitFor(() =>
      getByRole('button', { name: WORKFLOW_COPY.creator.creatingAction }),
    );
    expect(creating.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('.weft-workflow-builder__body')?.hasAttribute('inert')).toBe(
      true,
    );

    release();
    await waitFor(() =>
      expect(
        getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).hasAttribute('disabled'),
      ).toBe(false),
    );
    expect(container.querySelector('.weft-workflow-builder__body')?.hasAttribute('inert')).toBe(
      false,
    );
  });

  test('asks before Cancel discards what was typed, and stays with it on Keep editing', async () => {
    const { container, getByRole, findByRole } = open();
    await ready(container);
    await fireEvent.input(field(container, 'workflow-builder-title'), {
      target: { value: 'Draft' },
    });
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.cancelAction }));

    const dialog = await findByRole('dialog', { name: BUILDER.discard.title });
    expect(dialog.textContent).toContain(BUILDER.discard.description);
    expect(router.pathname).toBe('/workflows/new');
    await fireEvent.click(within(dialog).getByRole('button', { name: BUILDER.discard.keep }));
    expect(router.pathname).toBe('/workflows/new');
    expect(field(container, 'workflow-builder-title').value).toBe('Draft');

    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.cancelAction }));
    const again = await findByRole('dialog', { name: BUILDER.discard.title });
    await fireEvent.click(within(again).getByRole('button', { name: BUILDER.discard.confirm }));
    await waitFor(() => expect(router.pathname).toBe('/workflows'));
  });

  test('leaves an untouched form at once, with no dialog', async () => {
    const { container, getByRole, queryByRole } = open();
    await ready(container);
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.cancelAction }));
    expect(router.pathname).toBe('/workflows');
    expect(queryByRole('dialog', { name: BUILDER.discard.title })).toBeNull();
  });
});
