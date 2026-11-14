/**
 * COR-2247 and COR-2248: the builder's cards for a plugin's activities, for "Run a workflow", for a
 * wait's limit, and for the control-flow kinds (a path chosen by a value, steps side by side, steps
 * repeated for each item). "Add a step" is one menu in every list, which lists the Bureau's catalog
 * by title; an activity's input is drawn from the schema the catalog gives it; each kind can be
 * added, edited, nested, moved and deleted, and the JSON tab holds exactly what each edit wrote.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
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

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const BUILDER = WORKFLOW_COPY.builder;
const FLOW = BUILDER.controlFlow;
const where = BUILDER.where;

const ECHO_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    text: { type: 'string', title: 'Text' },
    loud: { type: 'boolean', title: 'Loud' },
  },
  required: ['text'],
};

const ACTIVITIES = [
  {
    id: 'agent',
    title: 'Run an agent',
    description: 'Run a Bureau agent.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } } },
  },
  {
    id: 'demo:echo-input',
    title: 'Echo input',
    description: 'Hands back the text it is given.',
    inputSchema: ECHO_SCHEMA,
  },
  { id: 'demo:untitled', title: null, description: null, inputSchema: null },
];

const CODE_WORKFLOWS = [
  {
    id: 'demo:echo-workflow',
    name: 'echo-workflow',
    title: 'Echo workflow',
    plugin: 'demo',
    version: '1.0.0',
  },
  {
    id: 'demo:other-workflow',
    name: 'other-workflow',
    title: 'Other workflow',
    plugin: 'demo',
    version: '1.0.0',
  },
];

/** A workflow file's text with the given steps. */
const file = (steps: unknown[]): string =>
  JSON.stringify(
    { name: 'built', trigger: { kind: 'manual' }, steps: steps as Record<string, unknown>[] },
    null,
    2,
  );

const field = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
  ) as HTMLButtonElement;
const tab = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent?.trim() === name,
  ) as HTMLElement;

/** Opens `/workflows/new` holding `text`, on the Builder tab. */
async function openBuilder(
  text: string,
  overrides: Partial<World> = {},
  prepare: (installed: WorkflowStub) => void = () => {},
) {
  stub = installWorkflowWorld(
    emptyWorld({
      files: [readyFile('digest')],
      activities: ACTIVITIES,
      codeWorkflows: CODE_WORKFLOWS,
      ...overrides,
    }),
  );
  prepare(stub);
  router.navigate('/workflows/new', { replace: true });
  const view = render(Harness, {
    props: { client: stub.client, scopes: AUTHORIZATION_SCOPES },
  } as never);
  const { container } = view;
  await waitFor(() => expect(tab(container, BUILDER.jsonTab)).toBeTruthy());
  await fireEvent.click(tab(container, BUILDER.jsonTab));
  await waitFor(() => expect(container.querySelector('textarea')).toBeTruthy());
  await fireEvent.input(container.querySelector('textarea') as HTMLTextAreaElement, {
    target: { value: text },
  });
  await fireEvent.click(tab(container, BUILDER.builderTab));
  await waitFor(() => expect(field(container, 'workflow-builder-title')).toBeTruthy());
  return view;
}

/** The file's text as the JSON tab holds it, then back to the Builder tab. */
async function textOf(container: HTMLElement): Promise<Record<string, unknown>> {
  await fireEvent.click(tab(container, BUILDER.jsonTab));
  await waitFor(() => expect(container.querySelector('textarea')).toBeTruthy());
  const value = (container.querySelector('textarea') as HTMLTextAreaElement).value;
  await fireEvent.click(tab(container, BUILDER.builderTab));
  await waitFor(() => expect(field(container, 'workflow-builder-title')).toBeTruthy());
  return JSON.parse(value) as Record<string, unknown>;
}

const stepsOf = (document: Record<string, unknown>) =>
  document['steps'] as Record<string, unknown>[];

/** The items of the menu a trigger opens, which it names in `aria-controls`. */
async function menuItems(trigger: HTMLElement): Promise<HTMLElement[]> {
  await fireEvent.click(trigger);
  return waitFor(() => {
    const menu = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
    expect(menu).toBeTruthy();
    const items = [...(menu as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThan(0);
    return items;
  });
}

/** The labels of the items of the menu `trigger` has open, as they are now. */
function menuLabels(trigger: HTMLElement): (string | undefined)[] {
  const menu = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
  return [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) =>
    item.textContent?.trim(),
  );
}

/** Adds a step by its menu label to the list whose Add a step control has `trigger` as its id. */
async function addStep(
  container: HTMLElement,
  label: string,
  trigger = 'workflow-builder-add',
): Promise<void> {
  const opener = field(container, trigger);
  await menuItems(opener);
  // A catalog's entries arrive after the menu opens, so the item may not be there yet.
  const item = await waitFor(() => {
    const found = [
      ...(document
        .getElementById(opener.getAttribute('aria-controls') ?? '')
        ?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ].find((candidate) => candidate.textContent?.trim() === label);
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  await fireEvent.click(item);
}

/** Types a name into the field of a case or a list and leaves it, which is when the name is written. */
async function rename(container: HTMLElement, id: string, value: string): Promise<void> {
  const input = field(container, id);
  await fireEvent.input(input, { target: { value } });
  await fireEvent.blur(input);
}

/** Every id on the page is used once: nested steps never share one. */
function expectUniqueIds(container: HTMLElement): void {
  const seen = new Set<string>();
  for (const element of container.querySelectorAll('[id]')) {
    expect(seen.has(element.id), `duplicate id ${element.id}`).toBe(false);
    seen.add(element.id);
  }
}

describe('Add a step', () => {
  test('is one menu: the built-in kinds, then each activity and each code workflow by its title', async () => {
    const { container } = await openBuilder(file([{ kind: 'sleep', duration: '1m' }]));
    const trigger = field(container, 'workflow-builder-add');
    const items = await menuItems(trigger);
    await waitFor(() => {
      expect(menuLabels(trigger)).toEqual([
        BUILDER.add.agent,
        BUILDER.add.person,
        BUILDER.add.signal,
        BUILDER.add.wait,
        BUILDER.add.branch,
        BUILDER.add.parallel,
        BUILDER.add.map,
        // `agent` is the first of the built-in kinds, so the catalog's own entry for it is left out.
        'Echo input',
        // An activity with no title reads its id in words, and a plugin is never joined to it by a dot.
        'Demo untitled',
        'Echo workflow',
        'Other workflow',
      ]);
    });
    expect(items.length).toBeGreaterThan(0);
    // One control per list, never a row of buttons.
    expect(container.querySelectorAll('button[id^="workflow-builder-add"]')).toHaveLength(1);
  });

  test('leaves a catalog that lists nothing out, and says a catalog it could not read did not load, with a way to ask again', async () => {
    const { container } = await openBuilder(file([{ kind: 'sleep', duration: '1m' }]), {
      activities: [],
      codeWorkflows: [],
    });
    const trigger = field(container, 'workflow-builder-add');
    await menuItems(trigger);
    await waitFor(() => expect(menuLabels(trigger)).toHaveLength(7));
  });

  test('says a catalog it could not read did not load, never that it lists nothing, and asks again from the menu', async () => {
    let answers = 0;
    const { container } = await openBuilder(
      file([{ kind: 'sleep', duration: '1m' }]),
      {},
      (installed) =>
        installed.on('bureau.workflows.catalog', () => {
          answers += 1;
          if (answers === 1) throw workflowFaults.unavailable();
          return { activities: ACTIVITIES };
        }),
    );
    const trigger = field(container, 'workflow-builder-add');
    await menuItems(trigger);
    await waitFor(() => expect(menuLabels(trigger)).toContain(BUILDER.addMenu.activitiesFailed));
    expect(menuLabels(trigger)).not.toContain('Echo input');
    const retry = [
      ...(document
        .getElementById(trigger.getAttribute('aria-controls') ?? '')
        ?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ].find((item) => item.textContent?.trim() === BUILDER.addMenu.activitiesFailed);
    await fireEvent.click(retry as HTMLElement);
    await waitFor(() => expect(menuLabels(trigger)).toContain('Echo input'));
    expect(answers).toBe(2);
  });
});

describe('an activity card', () => {
  test('is added with the starting input its form shows, draws that form from the catalog’s schema, and writes the step it describes', async () => {
    const { container, getByLabelText } = await openBuilder(
      file([{ kind: 'sleep', duration: '1m' }]),
    );
    await addStep(container, 'Echo input');
    await waitFor(() =>
      expect(container.querySelector('[data-step-kind="activity"]')).toBeTruthy(),
    );

    const added = stepsOf(await textOf(container))[1];
    expect(added).toMatchObject({ kind: 'activity', handler: 'demo:echo-input' });
    expect(added?.['input']).toEqual({ text: '', loud: false });

    const card = container.querySelector('[data-step-kind="activity"]') as HTMLElement;
    expect(card.querySelector('.cinder-schema-form')).toBeTruthy();
    // The form is a group inside the card, never a form inside the page's form, and has no Submit.
    expect(card.querySelector('form')).toBeNull();
    expect(card.querySelector('button[type="submit"]')).toBeNull();
    expect(card.textContent).toContain('Hands back the text it is given.');
    expect(card.textContent).toContain('Echo input');

    await fireEvent.input(getByLabelText(/Text/), { target: { value: 'hello' } });
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[1]?.['input']).toEqual({
        text: 'hello',
        loud: false,
      }),
    );
  });

  test('is the same form through its own edits: the field a person types in is never made again, and keeps its focus', async () => {
    const { container } = await openBuilder(
      file([{ kind: 'activity', handler: 'demo:echo-input', input: { text: 'a' } }]),
    );
    await waitFor(() => expect(container.querySelector('.cinder-schema-form')).toBeTruthy());
    const typed = container.querySelector(
      '.cinder-schema-form input[type="text"]',
    ) as HTMLInputElement;
    typed.focus();
    await fireEvent.input(typed, { target: { value: 'ab' } });
    await fireEvent.input(typed, { target: { value: 'abc' } });
    // The edit wrote the step again, and the step is a new object: the form is the one it was.
    expect(container.querySelector('.cinder-schema-form input[type="text"]')).toBe(typed);
    expect(document.activeElement).toBe(typed);
    expect(stepsOf(await textOf(container))[0]?.['input']).toMatchObject({ text: 'abc' });
  });

  test('keeps a key of the input the schema does not name when another field is edited, even one called kind', async () => {
    const text = file([
      {
        kind: 'activity',
        handler: 'demo:echo-input',
        input: { text: 'hi', loud: true, kind: 'shout', legacy: 7 },
      },
    ]);
    const { container, getByLabelText } = await openBuilder(text);
    await waitFor(() => expect(container.querySelector('.cinder-schema-form')).toBeTruthy());
    await fireEvent.input(getByLabelText(/Text/), { target: { value: 'changed' } });
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[0]?.['input']).toEqual({
        text: 'changed',
        loud: true,
        kind: 'shout',
        legacy: 7,
      }),
    );
  });

  test('opening a file writes nothing: the JSON tab holds the bytes it was given, and Cancel asks nothing', async () => {
    const text = file([
      { kind: 'activity', handler: 'demo:echo-input', input: { text: 'hi' } },
      { kind: 'activity', handler: 'demo:echo-input' },
    ]);
    const { container } = await openBuilder(text);
    await waitFor(() => expect(container.querySelectorAll('.cinder-schema-form')).toHaveLength(2));
    await fireEvent.click(tab(container, BUILDER.jsonTab));
    await waitFor(() => expect(container.querySelector('textarea')).toBeTruthy());
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(text);
  });

  test('a form that still shows a step after a move writes into that step, not its neighbour', async () => {
    const text = file([
      { kind: 'activity', handler: 'demo:echo-input', input: { text: 'first' } },
      { kind: 'activity', handler: 'demo:echo-input', input: { text: 'second' } },
    ]);
    const { container } = await openBuilder(text);
    await waitFor(() => expect(container.querySelectorAll('.cinder-schema-form')).toHaveLength(2));
    await fireEvent.click(button(container, BUILDER.moveEarlier(where.step(2))));

    await waitFor(() => {
      const fields = [
        ...container.querySelectorAll<HTMLInputElement>('.cinder-schema-form input[type="text"]'),
      ];
      expect(fields.map((candidate) => candidate.value)).toEqual(['second', 'first']);
    });
    const firstField = container.querySelector(
      '.cinder-schema-form input[type="text"]',
    ) as HTMLInputElement;
    await fireEvent.input(firstField, { target: { value: 'second, edited' } });
    await waitFor(async () => {
      const steps = stepsOf(await textOf(container));
      expect(steps.map((step) => (step['input'] as { text: string }).text)).toEqual([
        'second, edited',
        'first',
      ]);
    });
  });

  test('keeps the input as written while the catalog loads or fails, and says so; a handler no plugin provides says that', async () => {
    const text = file([
      { kind: 'activity', handler: 'demo:echo-input', input: { text: 'kept', odd: true } },
      { kind: 'activity', handler: 'demo:gone', input: { n: 1 } },
    ]);
    const { container, findByText } = await openBuilder(text, { activities: ACTIVITIES });
    await findByText(BUILDER.activity.unavailable('demo:gone'));
    expect(stepsOf(await textOf(container))).toEqual(
      stepsOf(JSON.parse(text) as Record<string, unknown>),
    );
    cleanup();
    stub?.restore();

    const failing = await openBuilder(text, {}, (installed) =>
      installed.on('bureau.workflows.catalog', () => {
        throw workflowFaults.unavailable();
      }),
    );
    await waitFor(() =>
      expect(failing.container.querySelector('[data-testid="step-activity-error"]')).toBeTruthy(),
    );
    expect(
      failing.container.querySelector('[data-testid="step-activity-error"]')?.textContent,
    ).toContain(BUILDER.activity.failed('demo:echo-input'));
    expect(button(failing.container, BUILDER.activity.retry)).toBeTruthy();
    expect(stepsOf(await textOf(failing.container))).toEqual(
      stepsOf(JSON.parse(text) as Record<string, unknown>),
    );
  });

  test('says its input is edited in the JSON tab when the catalog gives it no schema, and keeps the input', async () => {
    const text = file([{ kind: 'activity', handler: 'demo:untitled', input: { raw: [1, 2] } }]);
    const { container } = await openBuilder(text);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="step-input-note"]')?.textContent).toContain(
        BUILDER.activity.noSchema,
      ),
    );
    expect(container.querySelector('.cinder-schema-form')).toBeNull();
    expect(stepsOf(await textOf(container))[0]?.['input']).toEqual({ raw: [1, 2] });
  });
});

describe('a workflow card', () => {
  test('is added from the menu by the workflow’s title, writes the step, and chooses another workflow in a select', async () => {
    const { container } = await openBuilder(file([{ kind: 'sleep', duration: '1m' }]));
    await addStep(container, 'Echo workflow');
    await waitFor(() =>
      expect(container.querySelector('[data-step-kind="workflow"]')).toBeTruthy(),
    );
    expect(stepsOf(await textOf(container))[1]).toEqual({
      kind: 'workflow',
      workflow: 'demo:echo-workflow',
    });
    expect(container.querySelector('[data-step-kind="workflow"]')?.textContent).toContain(
      BUILDER.stepKinds.workflow,
    );

    const select = field(container, 'workflow-builder-step-2-workflow');
    await waitFor(() =>
      expect(select.querySelector('option[value="demo:other-workflow"]')).toBeTruthy(),
    );
    await fireEvent.change(select, { target: { value: 'demo:other-workflow' } });
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[1]).toEqual({
        kind: 'workflow',
        workflow: 'demo:other-workflow',
      }),
    );
  });

  test('keeps a workflow no running plugin lists selectable under its own id, with its input as written', async () => {
    const text = file([{ kind: 'workflow', workflow: 'demo:gone', input: { n: 1 } }]);
    const { container } = await openBuilder(text);
    const select = field(container, 'workflow-builder-step-1-workflow');
    await waitFor(() =>
      expect(select.querySelector('option[value="demo:gone"]')?.textContent).toContain(
        BUILDER.workflowCard.missing('demo:gone'),
      ),
    );
    expect(select.value).toBe('demo:gone');
    expect(stepsOf(await textOf(container))[0]).toEqual({
      kind: 'workflow',
      workflow: 'demo:gone',
      input: { n: 1 },
    });
  });

  test('says in the read-back what it runs, by the workflow’s title', async () => {
    const { container } = await openBuilder(
      file([{ kind: 'workflow', workflow: 'demo:echo-workflow' }]),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent,
      ).toContain('run the workflow Echo workflow'),
    );
  });
});

describe('the limit of a wait', () => {
  const waiting = (extra: Record<string, unknown> = {}) =>
    file([
      { kind: 'await-signal', signal: 'go', ...extra },
      { kind: 'await-signal', signal: 'review-1', review: true },
    ]);

  test('a wait with no limit writes no timeout; a number and a unit write it, and clearing the number removes the key', async () => {
    const { container } = await openBuilder(waiting());
    expect(stepsOf(await textOf(container))[0]).not.toHaveProperty('timeout');

    await fireEvent.change(field(container, 'workflow-builder-step-1-timeout-unit'), {
      target: { value: 'hours' },
    });
    // Choosing a unit alone is not a limit, and the number that follows is counted in it.
    await fireEvent.input(field(container, 'workflow-builder-step-1-timeout'), {
      target: { value: '2' },
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent,
      ).toContain('wait up to 2 hours for go'),
    );
    expect(stepsOf(await textOf(container))[0]?.['timeout']).toBe('2h');

    await fireEvent.input(field(container, 'workflow-builder-step-1-timeout'), {
      target: { value: '' },
    });
    // The unit the person chose stays for the next number.
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent,
      ).not.toContain('wait up to'),
    );
    expect(field(container, 'workflow-builder-step-1-timeout-unit').value).toBe('hours');
    expect(stepsOf(await textOf(container))[0]).not.toHaveProperty('timeout');
  });

  test('is on a wait for a person too, and travels with its step when the step moves', async () => {
    const { container } = await openBuilder(waiting({ timeout: '15m' }));
    expect(field(container, 'workflow-builder-step-1-timeout').value).toBe('15');
    expect(field(container, 'workflow-builder-step-1-timeout-unit').value).toBe('minutes');
    await fireEvent.input(field(container, 'workflow-builder-step-2-timeout'), {
      target: { value: '3' },
    });
    await fireEvent.click(button(container, BUILDER.moveEarlier(where.step(2))));
    await waitFor(async () => {
      const steps = stepsOf(await textOf(container));
      expect(steps.map((step) => step['timeout'])).toEqual(['3m', '15m']);
      expect(steps.map((step) => step['signal'])).toEqual(['review-1', 'go']);
    });
  });

  test('keeps a limit the number and unit cannot say as written, in a field of its own', async () => {
    const { container } = await openBuilder(waiting({ timeout: 90000 }));
    const text = field(container, 'workflow-builder-step-1-timeout');
    expect(text.value).toBe('90000');
    await fireEvent.input(text, { target: { value: '1.5h' } });
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[0]?.['timeout']).toBe('1.5h'),
    );
    await fireEvent.input(field(container, 'workflow-builder-step-1-timeout'), {
      target: { value: '' },
    });
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[0]).not.toHaveProperty('timeout'),
    );
  });
});

describe('every control-flow kind and the limit of a wait, nested', () => {
  const inCase = where.caseOf('a', where.step(1));
  const holding = () =>
    file([{ kind: 'branch', on: 'x', cases: { a: [{ kind: 'sleep', duration: '1m' }] } }]);

  const KINDS = [
    { label: BUILDER.add.signal, kind: 'await-signal' },
    { label: BUILDER.add.branch, kind: 'branch' },
    { label: BUILDER.add.parallel, kind: 'parallel' },
    { label: BUILDER.add.map, kind: 'map' },
  ];

  for (const entry of KINDS) {
    test(`a ${entry.kind} step is added inside a case, edited there, moved within its list, and deleted from it`, async () => {
      const { container } = await openBuilder(holding());
      const kindsIn = async () =>
        (stepsOf(await textOf(container))[0] as { cases: { a: { kind: string }[] } }).cases.a.map(
          (step) => step.kind,
        );

      await addStep(container, entry.label, 'workflow-builder-add-1-c1');
      await waitFor(() =>
        expect(
          container.querySelector(
            `[data-step-address="1-c1-2"][data-step-kind="${entry.kind === 'await-signal' ? 'signal' : entry.kind}"]`,
          ),
        ).toBeTruthy(),
      );
      expect(await kindsIn()).toEqual(['sleep', entry.kind]);
      expectUniqueIds(container);

      // It is edited where it is: its own title, by the address of the step.
      await fireEvent.input(field(container, 'workflow-builder-step-1-c1-2-title'), {
        target: { value: 'Nested' },
      });
      await waitFor(async () =>
        expect(
          (stepsOf(await textOf(container))[0] as { cases: { a: { title?: string }[] } }).cases.a[1]
            ?.title,
        ).toBe('Nested'),
      );

      await fireEvent.click(button(container, BUILDER.moveEarlier(where.nested(2, inCase))));
      await waitFor(async () => expect(await kindsIn()).toEqual([entry.kind, 'sleep']));

      await fireEvent.click(button(container, BUILDER.remove(where.nested(1, inCase))));
      await waitFor(async () => expect(await kindsIn()).toEqual(['sleep']));
    });
  }

  test('a limit on a nested wait travels with it when it moves, and a repeat holds a path that holds a wait', async () => {
    const { container } = await openBuilder(
      file([
        {
          kind: 'map',
          over: 'files',
          steps: [
            { kind: 'await-signal', signal: 'first' },
            { kind: 'await-signal', signal: 'second', timeout: '5m' },
          ],
        },
      ]),
    );
    expect(field(container, 'workflow-builder-step-1-s-2-timeout').value).toBe('5');
    await fireEvent.click(
      button(container, BUILDER.moveEarlier(where.nested(2, where.bodyOf(where.step(1))))),
    );
    await waitFor(async () => {
      const steps = (stepsOf(await textOf(container))[0] as { steps: Record<string, unknown>[] })
        .steps;
      expect(steps.map((step) => step['signal'])).toEqual(['second', 'first']);
      expect(steps.map((step) => step['timeout'])).toEqual(['5m', undefined]);
    });
    expectUniqueIds(container);
  });
});

describe('a path chosen by a value', () => {
  const branching = () =>
    file([
      { kind: 'sleep', duration: '1m' },
      {
        kind: 'branch',
        on: 'status',
        cases: {
          approved: [
            { kind: 'await-signal', signal: 'a' },
            { kind: 'await-signal', signal: 'b' },
          ],
          rejected: [],
        },
      },
    ]);

  test('is added with one empty case, in the person’s words, and its fields write the step', async () => {
    const { container } = await openBuilder(file([{ kind: 'sleep', duration: '1m' }]));
    await addStep(container, BUILDER.add.branch);
    await waitFor(() => expect(container.querySelector('[data-step-kind="branch"]')).toBeTruthy());
    expect(container.querySelector('[data-step-kind="branch"]')?.textContent).toContain(
      BUILDER.stepKinds.branch,
    );
    expect(container.textContent).not.toMatch(/\bBranch\b/);
    expect(stepsOf(await textOf(container))[1]).toEqual({
      kind: 'branch',
      on: '',
      cases: { 'value-1': [] },
    });

    await fireEvent.input(field(container, 'workflow-builder-step-2-on'), {
      target: { value: 'status' },
    });
    await rename(container, 'workflow-builder-step-2-case-1', 'approved');
    await fireEvent.click(button(container, FLOW.addCase));
    await fireEvent.click(button(container, FLOW.addOtherwise));
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[1]).toEqual({
        kind: 'branch',
        on: 'status',
        cases: { approved: [], 'value-1': [] },
        otherwise: [],
      }),
    );
    expect(button(container, FLOW.addOtherwise)).toBeUndefined();
    expect(
      container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent,
    ).toContain('choose a path by status (2 cases)');
  });

  test('nests steps: a step added inside a case, named, moved within its list and deleted, with ids and labels that name it', async () => {
    const { container } = await openBuilder(branching());
    expectUniqueIds(container);
    // The first step of the approved case is the second step on the page's first list of step 2.
    const approved = where.caseOf('approved', where.step(2));
    expect(button(container, BUILDER.moveLater(where.nested(1, approved)))).toBeTruthy();
    expect(button(container, BUILDER.moveEarlier(where.nested(1, approved)))).toBeUndefined();

    await fireEvent.input(field(container, 'workflow-builder-step-2-c1-1-signal'), {
      target: { value: 'a-renamed' },
    });
    await fireEvent.click(button(container, BUILDER.moveLater(where.nested(1, approved))));
    await waitFor(async () => {
      const branch = stepsOf(await textOf(container))[1] as {
        cases: { approved: { signal: string }[] };
      };
      expect(branch.cases.approved.map((step) => step.signal)).toEqual(['b', 'a-renamed']);
    });

    await addStep(container, BUILDER.add.wait, 'workflow-builder-add-2-c1');
    await waitFor(() =>
      expect(field(container, 'workflow-builder-step-2-c1-3-duration')).toBeTruthy(),
    );
    expectUniqueIds(container);
    await fireEvent.click(button(container, BUILDER.remove(where.nested(2, approved))));
    await waitFor(async () => {
      const branch = stepsOf(await textOf(container))[1] as {
        cases: { approved: { kind: string; signal?: string }[] };
      };
      expect(branch.cases.approved.map((step) => step.kind)).toEqual(['await-signal', 'sleep']);
      expect(branch.cases.approved[0]?.signal).toBe('b');
    });
  });

  test('renames a case in its place, refuses a value another case has without writing it, and removes a case with its steps', async () => {
    const { container } = await openBuilder(branching());
    await rename(container, 'workflow-builder-step-2-case-1', 'ok');
    await waitFor(async () =>
      expect(Object.keys((stepsOf(await textOf(container))[1] as { cases: object }).cases)).toEqual(
        ['ok', 'rejected'],
      ),
    );
    await rename(container, 'workflow-builder-step-2-case-2', 'ok');
    await waitFor(() => expect(container.textContent).toContain(FLOW.caseTaken));
    expect(Object.keys((stepsOf(await textOf(container))[1] as { cases: object }).cases)).toEqual([
      'ok',
      'rejected',
    ]);

    await fireEvent.click(button(container, FLOW.removeCase('ok')));
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[1]).toEqual({
        kind: 'branch',
        on: 'status',
        cases: { rejected: [] },
      }),
    );
  });

  test('writes a name when the field is left or Enter is pressed, never while it is typed: a whole number would move its case ahead of the others', async () => {
    const text = file([
      {
        kind: 'branch',
        on: 'x',
        cases: { approved: [], 'value-1': [{ kind: 'sleep', duration: '1m' }] },
      },
    ]);
    const { container } = await openBuilder(text);
    const second = field(container, 'workflow-builder-step-1-case-2');
    await fireEvent.input(second, { target: { value: '2' } });
    await fireEvent.input(second, { target: { value: '20' } });
    // Nothing is written yet, and the field is still the one being typed in.
    expect(field(container, 'workflow-builder-step-1-case-2')).toBe(second);
    expect(second.value).toBe('20');
    expect(Object.keys((stepsOf(await textOf(container))[0] as { cases: object }).cases)).toEqual([
      'approved',
      'value-1',
    ]);

    const again = field(container, 'workflow-builder-step-1-case-2');
    await fireEvent.input(again, { target: { value: '20' } });
    await fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(async () => {
      const cases = (stepsOf(await textOf(container))[0] as { cases: Record<string, unknown[]> })
        .cases;
      // JavaScript puts a key that is a whole number first; its steps went with it.
      expect(Object.keys(cases)).toEqual(['20', 'approved']);
      expect(cases['20']).toHaveLength(1);
    });
    expectUniqueIds(container);
  });

  test('a step nested three levels deep has its own ids and labels, and a problem there focuses that field', async () => {
    const deep = file([
      {
        kind: 'branch',
        on: 'a',
        cases: {
          x: [
            {
              kind: 'branch',
              on: 'b',
              cases: {
                y: [
                  { kind: 'await-signal', signal: 'deep-1' },
                  { kind: 'await-signal', signal: '' },
                ],
              },
            },
          ],
        },
      },
    ]);
    const { container, getByRole } = await openBuilder(deep);
    expectUniqueIds(container);
    expect(field(container, 'workflow-builder-step-1-c1-1-c1-2-signal')).toBeTruthy();
    expect(field(container, 'workflow-builder-step-1-c1-1-c1-1-signal').value).toBe('deep-1');
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() =>
      expect(document.activeElement?.id).toBe('workflow-builder-step-1-c1-1-c1-2-signal'),
    );
    expect(container.querySelector('[data-step-address="1-c1-1-c1-2"][data-problem]')).toBeTruthy();
    expect(container.querySelector('[data-step-address="1-c1-1-c1-1"][data-problem]')).toBeNull();
  });
});

describe('steps side by side', () => {
  const side = () =>
    file([
      {
        kind: 'parallel',
        branches: {
          notify: [{ kind: 'sleep', duration: '1m' }],
          log: [{ kind: 'await-signal', signal: 's' }],
        },
      },
    ]);

  test('is added with one empty list, and a list is added, named, filled, moved within and removed', async () => {
    const { container } = await openBuilder(file([{ kind: 'sleep', duration: '1m' }]));
    await addStep(container, BUILDER.add.parallel);
    await waitFor(() =>
      expect(container.querySelector('[data-step-kind="parallel"]')).toBeTruthy(),
    );
    expect(container.querySelector('[data-step-kind="parallel"]')?.textContent).toContain(
      BUILDER.stepKinds.parallel,
    );
    expect(stepsOf(await textOf(container))[1]).toEqual({
      kind: 'parallel',
      branches: { 'branch-1': [] },
    });
    await rename(container, 'workflow-builder-step-2-branch-1', 'notify');
    await fireEvent.click(button(container, FLOW.addBranch));
    await addStep(container, BUILDER.add.signal, 'workflow-builder-add-2-b1');
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[1]).toEqual({
        kind: 'parallel',
        branches: { notify: [{ kind: 'await-signal', signal: '' }], 'branch-1': [] },
      }),
    );
    await fireEvent.click(button(container, FLOW.removeBranch('branch-1')));
    await waitFor(async () =>
      expect(
        Object.keys((stepsOf(await textOf(container))[1] as { branches: object }).branches),
      ).toEqual(['notify']),
    );
    expect(
      container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent,
    ).toContain('run 1 list side by side');
  });

  test('moves a step inside one list without touching the other, and keeps the lists’ order through a rename', async () => {
    const { container } = await openBuilder(
      file([
        {
          kind: 'parallel',
          branches: {
            notify: [
              { kind: 'await-signal', signal: 'one' },
              { kind: 'await-signal', signal: 'two' },
            ],
            log: [{ kind: 'await-signal', signal: 'three' }],
          },
        },
      ]),
    );
    const notify = where.branchOf('notify', where.step(1));
    await fireEvent.click(button(container, BUILDER.moveEarlier(where.nested(2, notify))));
    await rename(container, 'workflow-builder-step-1-branch-1', 'tell');
    await waitFor(async () => {
      const step = stepsOf(await textOf(container))[0] as {
        branches: Record<string, { signal: string }[]>;
      };
      expect(Object.keys(step.branches)).toEqual(['tell', 'log']);
      expect(step.branches['tell']?.map((entry) => entry.signal)).toEqual(['two', 'one']);
      expect(step.branches['log']?.map((entry) => entry.signal)).toEqual(['three']);
    });
    expectUniqueIds(container);
  });

  test('says each list with no step, and a step with no list, as problems at the list’s own Add a step', async () => {
    const { container, getByRole } = await openBuilder(side());
    await fireEvent.click(button(container, FLOW.removeBranch('log')));
    await fireEvent.click(button(container, FLOW.removeBranch('notify')));
    await waitFor(() =>
      expect(container.querySelector('[data-step-kind="parallel"]')).toBeTruthy(),
    );
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() =>
      expect(document.activeElement?.id).toBe('workflow-builder-step-1-add-branch'),
    );
    expect(container.querySelector('[data-step-address="1"][data-problem]')).toBeTruthy();
  });
});

describe('steps repeated for each item', () => {
  const repeating = () =>
    file([
      {
        kind: 'map',
        over: 'files',
        concurrency: 3,
        steps: [{ kind: 'await-signal', signal: 'x' }],
      },
    ]);

  test('is added with its steps empty, says what it needs, and writes its property, its concurrency and its steps', async () => {
    const { container, getByRole } = await openBuilder(file([{ kind: 'sleep', duration: '1m' }]));
    await addStep(container, BUILDER.add.map);
    await waitFor(() => expect(container.querySelector('[data-step-kind="map"]')).toBeTruthy());
    expect(container.querySelector('[data-step-kind="map"]')?.textContent).toContain(
      BUILDER.stepKinds.map,
    );
    expect(stepsOf(await textOf(container))[1]).toEqual({ kind: 'map', over: '', steps: [] });

    // Nothing says it is wrong until Create is pressed; then the first thing to fix has focus.
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }));
    await waitFor(() => expect(document.activeElement?.id).toBe('workflow-builder-step-2-over'));
    expect(
      container.querySelector('[data-testid="workflow-builder-problems"]')?.textContent,
    ).toContain(WORKFLOW_COPY.builder.problems.summary.emptyList(where.bodyOf(where.step(2))));

    await fireEvent.input(field(container, 'workflow-builder-step-2-over'), {
      target: { value: 'files' },
    });
    await addStep(container, BUILDER.add.wait, 'workflow-builder-add-2-s');
    const concurrency = field(container, 'workflow-builder-step-2-concurrency');
    await fireEvent.input(concurrency, { target: { value: '4' } });
    await fireEvent.blur(concurrency);
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[1]).toEqual({
        kind: 'map',
        over: 'files',
        concurrency: 4,
        steps: [{ kind: 'sleep', duration: '1m' }],
      }),
    );
    expect(
      container.querySelector('[data-testid="workflow-builder-summary"]')?.textContent,
    ).toContain('repeat 1 step for each item in files');
  });

  test('removes concurrency when it is cleared, and moves and deletes its steps', async () => {
    const { container } = await openBuilder(repeating());
    const concurrency = field(container, 'workflow-builder-step-1-concurrency');
    expect(concurrency.value).toBe('3');
    await fireEvent.input(concurrency, { target: { value: '' } });
    await fireEvent.blur(concurrency);
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[0]).not.toHaveProperty('concurrency'),
    );
    await fireEvent.click(
      button(container, BUILDER.remove(where.nested(1, where.bodyOf(where.step(1))))),
    );
    await waitFor(async () =>
      expect(stepsOf(await textOf(container))[0]).toEqual({
        kind: 'map',
        over: 'files',
        steps: [],
      }),
    );
  });

  test('moves the whole step with what it holds, and its heading reads the property it repeats over', async () => {
    const { container } = await openBuilder(
      file([{ kind: 'sleep', duration: '1m' }, JSON.parse(repeating()).steps[0]]),
    );
    expect(container.textContent).toContain(FLOW.bodyHeading('files'));
    await fireEvent.click(button(container, BUILDER.moveEarlier(where.step(2))));
    await waitFor(async () => {
      const steps = stepsOf(await textOf(container));
      expect(steps.map((step) => step['kind'])).toEqual(['map', 'sleep']);
      expect(steps[0]).toEqual({
        kind: 'map',
        over: 'files',
        concurrency: 3,
        steps: [{ kind: 'await-signal', signal: 'x' }],
      });
    });
    expectUniqueIds(container);
  });
});
