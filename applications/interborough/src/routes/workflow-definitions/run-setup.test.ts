/**
 * `/workflows/:workflow/run`: the workflow is fixed by the address, the input is a form drawn from
 * its schema (or JSON when it declares none), and the run starts now or on a schedule. An invalid
 * input shows its field errors and starts nothing; the Bureau's refusal lands on the field it
 * names and keeps what was typed; plain Enter never starts; and a second ask while one is in
 * flight is dropped. The footer's summary and its pinned action are the page's only controls
 * that write.
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
  sourceDefinition,
  workflowFaults,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import Harness from './area-harness.test-harness.svelte';

const COPY = WORKFLOW_COPY.runSetup;

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

const TOPIC_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', title: 'Topic', minLength: 3 },
    count: { type: 'integer', title: 'Count' },
  },
  required: ['topic'],
};

/** A schema the form cannot draw, so its input is typed as JSON. */
const LIST_SCHEMA = { type: 'array', items: { type: 'integer' } };

/** The input of the sample world's Release notes: a required branch and an optional date. */
const RELEASE_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string', title: 'Branch', description: 'The branch to release from.' },
    since: { type: 'string', title: 'Since', format: 'date' },
  },
  required: ['branch'],
};

/** A schema with a secret in it, which the JSON editor must never print. */
const SECRET_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    nested: {
      type: 'object',
      title: 'Nested',
      properties: { token: { type: 'string', title: 'Token', writeOnly: true } },
    },
  },
};

function open(
  path: string,
  overrides: Partial<World> = {},
  scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES,
  onQueryClient?: (queryClient: QueryClient) => void,
) {
  stub = installWorkflowWorld(
    emptyWorld({
      definitions: [
        codeDefinition('order-processing', {
          contract: {
            name: 'order-processing',
            inputSchema: TOPIC_SCHEMA,
          },
        }),
        codeDefinition('list-input', {
          contract: { name: 'list-input', inputSchema: LIST_SCHEMA },
        }),
        codeDefinition('agentRun'),
        sourceDefinition('digest'),
        sourceDefinition('plain', { contract: { name: 'plain' } }),
      ],
      files: [
        readyFile('digest', { inputSchema: TOPIC_SCHEMA }),
        readyFile('plain'),
        readyFile('release-notes', {
          title: 'Release notes',
          description: 'Collects merged changes into a draft.',
          inputSchema: RELEASE_SCHEMA,
          trigger: { kind: 'schedule', spec: '0 11 * * 5' },
        }),
        readyFile('inbox-triage', { trigger: { kind: 'signal', name: 'message-received' } }),
        readyFile('secret-input', { inputSchema: SECRET_SCHEMA }),
        readyFile('paused-one', { paused: true }),
        invalidFile('broken'),
      ],
      ...overrides,
    }),
  );
  router.navigate(path, { replace: true });
  return render(Harness, { props: { client: stub.client, scopes, onQueryClient } } as never);
}

const page = (root: ParentNode) => root.querySelector<HTMLElement>('[data-page="run-setup"]');

async function ready(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const found = page(container);
    expect(found?.querySelector('[data-testid="run-setup-footer"]')).toBeTruthy();
    return found as HTMLElement;
  });
}

const field = (root: ParentNode, label: string): HTMLInputElement =>
  [...root.querySelectorAll<HTMLInputElement>('input')].find(
    (input) => input.labels?.[0]?.textContent?.trim().startsWith(label) === true,
  ) as HTMLInputElement;

const primary = (root: ParentNode): HTMLButtonElement =>
  [...root.querySelectorAll<HTMLButtonElement>('[data-testid="run-setup-footer"] button')].find(
    (button) => button.hasAttribute('data-changes'),
  ) as HTMLButtonElement;

/** Types into a field and leaves it, which is when a number field commits what was typed. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await fireEvent.input(input, { target: { value } });
  await fireEvent.blur(input);
}

describe('the page', () => {
  test('names the workflow, which the address fixes, with Input and When as two sections', async () => {
    const { container, getByRole } = open('/workflows/digest/run');
    const root = await ready(container);
    expect(getByRole('heading', { level: 1 }).textContent).toBe(COPY.title('digest'));
    const headings = [...root.querySelectorAll('h2')].map((heading) => heading.textContent?.trim());
    expect(headings).toEqual([COPY.inputHeading, COPY.whenHeading]);
    // The workflow is not chosen again: nothing on the page lists other workflows.
    expect(root.querySelector('select')).toBeNull();
    expect(root.querySelector('ol, [aria-label*="step" i]')).toBeNull();
  });

  test('draws the input from the schema, and not the form’s own submit button', async () => {
    const { container } = open('/workflows/digest/run');
    const root = await ready(container);
    expect(field(root, 'Topic')).toBeTruthy();
    expect(field(root, 'Count')).toBeTruthy();
    // The primary action is in the footer, and it writes.
    expect(primary(root).textContent?.trim()).toBe(COPY.startAction);
  });

  test('enters the input as JSON when the workflow declares no schema', async () => {
    const { container } = open('/workflows/plain/run');
    const root = await ready(container);
    expect(root.querySelector('textarea')).toBeTruthy();
    expect(root.querySelector('form')).toBeNull();
  });

  test('says an engine type, a paused file and an invalid file cannot run, and links back', async () => {
    for (const [path, title] of [
      ['/workflows/agentRun/run', COPY.blocked.engineTitle],
      ['/workflows/paused-one/run', COPY.blocked.pausedTitle],
      ['/workflows/broken/run', COPY.blocked.invalidTitle],
    ] as const) {
      const { container, findByRole, unmount } = open(path);
      expect((await findByRole('heading', { level: 2, name: title })) !== null).toBe(true);
      const link = [...container.querySelectorAll('a')].find(
        (anchor) => anchor.textContent?.trim() === COPY.blocked.openWorkflow,
      );
      expect(link?.getAttribute('href')).toBe(path.replace('/run', ''));
      expect(container.querySelector('[data-testid="run-setup-footer"]')).toBeNull();
      expect(container.querySelector('form')).toBeNull();
      unmount();
      stub?.restore();
    }
  });

  test('shows a workflow that does not exist as the frame’s not-found state', async () => {
    const { container } = open('/workflows/nothing/run');
    await waitFor(() =>
      expect(container.querySelector('[data-view="workflows"]')?.getAttribute('data-state')).toBe(
        'not-found',
      ),
    );
    expect(container.querySelector('[data-testid="run-setup-footer"]')).toBeNull();
  });

  test('goes back to the workflow with Cancel, and starts nothing', async () => {
    const { container, getByRole } = open('/workflows/digest/run');
    await ready(container);
    await fireEvent.click(getByRole('button', { name: COPY.cancel }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
  });
});

describe('starting now', () => {
  test('summarises the choice in one line, which follows it', async () => {
    const { container, getByRole } = open('/workflows/order-processing/run');
    const root = await ready(container);
    const summary = () => root.querySelector('[data-testid="run-setup-summary"]')?.textContent;
    expect(summary()).toBe(COPY.summaryNow());
    await fireEvent.click(getByRole('radio', { name: new RegExp(COPY.schedule) }));
    await waitFor(() =>
      expect(summary()).toMatch(
        /^Creates a schedule that runs order-processing, every day at 9:00 AM /,
      ),
    );
    expect(primary(root).textContent?.trim()).toBe(COPY.scheduleAction);
  });

  test('starts a file with the input the form holds, and opens the run', async () => {
    const { container } = open('/workflows/digest/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'weather');
    await type(field(root, 'Count'), '3');
    await fireEvent.click(primary(root));

    await waitFor(() =>
      expect(stub?.world.startedRuns).toEqual([
        { id: 'digest', input: { topic: 'weather', count: 3 } },
      ]),
    );
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest/runs/run-started-1'));
  });

  test('starts a code-defined type through the engine, with its input', async () => {
    const { container } = open('/workflows/order-processing/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'refund');
    await fireEvent.click(primary(root));

    await waitFor(() =>
      expect(stub?.world.engineStarts).toEqual([
        { type: 'order-processing', input: { topic: 'refund' } },
      ]),
    );
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
    await waitFor(() =>
      expect(router.pathname).toBe('/workflows/order-processing/runs/engine-run-1'),
    );
  });

  test('shows the field errors of an invalid input and creates no run', async () => {
    const { container, findByText } = open('/workflows/digest/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'ab');
    await fireEvent.click(primary(root));

    expect(await findByText(/at least 3|too short|minimum/i)).not.toBeNull();
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
    expect(stub?.world.startedRuns).toEqual([]);
    expect(router.pathname).toBe('/workflows/digest/run');
  });

  test('shows a required field that is empty as an error, and creates no run', async () => {
    const { container } = open('/workflows/digest/run');
    const root = await ready(container);
    await fireEvent.click(primary(root));
    await waitFor(() => expect(root.querySelector('[aria-invalid="true"]')).toBeTruthy());
    expect(stub?.world.startedRuns).toEqual([]);
  });

  test('puts the Bureau’s refusal on the field it names, and keeps the input', async () => {
    const { container, findByText } = open('/workflows/digest/run');
    stub?.on('bureau.workflows.start', () => {
      throw workflowFaults.invalidInput([{ path: ['topic'], message: 'That topic is taken.' }]);
    });
    const root = await ready(container);
    await type(field(root, 'Topic'), 'weather');
    await type(field(root, 'Count'), '4');
    await fireEvent.click(primary(root));

    expect(await findByText('That topic is taken.')).not.toBeNull();
    expect(field(root, 'Topic').getAttribute('aria-invalid')).toBe('true');
    expect(field(root, 'Topic').value).toBe('weather');
    expect(field(root, 'Count').value).toBe('4');
    expect(router.pathname).toBe('/workflows/digest/run');
    expect(stub?.world.startedRuns).toEqual([]);

    // Fixing the field starts the run with what is there now.
    stub?.on('bureau.workflows.start', (params) => {
      stub?.world.startedRuns.push({ id: String(params['id']), input: params['input'] ?? null });
      return { runId: 'run-late', workflow: 'digest', workflowVersion: 'version-1' };
    });
    await type(field(root, 'Topic'), 'weather report');
    await fireEvent.click(primary(root));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest/runs/run-late'));
    expect(stub?.world.startedRuns).toEqual([
      { id: 'digest', input: { topic: 'weather report', count: 4 } },
    ]);
  });

  test('says in a banner what the Bureau refused when no field is to blame, and keeps the input', async () => {
    const { container, findByText } = open('/workflows/digest/run');
    stub?.on('bureau.workflows.start', () => {
      throw workflowFaults.unprocessable('The workflow cannot start right now.');
    });
    const root = await ready(container);
    await type(field(root, 'Topic'), 'weather');
    await fireEvent.click(primary(root));

    expect(await findByText('The workflow cannot start right now.')).not.toBeNull();
    expect(await findByText(COPY.startFailed)).not.toBeNull();
    expect(field(root, 'Topic').value).toBe('weather');
    expect(router.pathname).toBe('/workflows/digest/run');
  });

  test('puts a refusal of the input as a whole on the form itself', async () => {
    const { container, findByText } = open('/workflows/digest/run');
    stub?.on('bureau.workflows.start', () => {
      throw workflowFaults.invalidInput([{ path: [], message: 'The input must be an object.' }]);
    });
    const root = await ready(container);
    await type(field(root, 'Topic'), 'weather');
    await fireEvent.click(primary(root));
    expect(await findByText('The input must be an object.')).not.toBeNull();
    expect(field(root, 'Topic').value).toBe('weather');
  });

  test('does not start on a plain Enter, which only checks the input', async () => {
    const { container } = open('/workflows/digest/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'weather');
    const form = root.querySelector('form') as HTMLFormElement;
    await fireEvent.submit(form);
    await fireEvent.keyDown(field(root, 'Topic'), { key: 'Enter' });
    expect(router.pathname).toBe('/workflows/digest/run');
    // A start can only be delayed by load, never advanced, so a quiet window proves none came.
    await quietFor(50);
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
    expect(stub?.world.startedRuns).toEqual([]);
  });

  test('drops a second ask while the first is in flight, so one run starts', async () => {
    const { container } = open('/workflows/digest/run');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub?.on('bureau.workflows.start', async (params) => {
      await held;
      stub?.world.startedRuns.push({ id: String(params['id']), input: params['input'] ?? null });
      return { runId: 'run-once', workflow: 'digest', workflowVersion: 'version-1' };
    });
    const root = await ready(container);
    await type(field(root, 'Topic'), 'weather');
    const button = primary(root);
    await fireEvent.click(button);
    await waitFor(() => expect(stub?.callsTo('bureau.workflows.start')).toHaveLength(1));
    await fireEvent.click(button);
    await fireEvent.click(button);
    release();
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest/runs/run-once'));
    expect(stub?.callsTo('bureau.workflows.start')).toHaveLength(1);
    expect(stub?.world.startedRuns).toHaveLength(1);
  });

  test('starts one run for two asks made while the form is still validating the first', async () => {
    const { container } = open('/workflows/digest/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'weather');
    const button = primary(root);
    // Both clicks land before the form's asynchronous validation of the first has finished.
    await Promise.all([fireEvent.click(button), fireEvent.click(button)]);
    await waitFor(() => expect(router.pathname).toMatch(/^\/workflows\/digest\/runs\//));
    expect(stub?.callsTo('bureau.workflows.start')).toHaveLength(1);
  });

  test('starts a workflow with no schema from its JSON, or from none', async () => {
    const { container } = open('/workflows/plain/run');
    const root = await ready(container);
    const editor = root.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: '{ "topic": "weather" }' } });
    await fireEvent.click(primary(root));
    await waitFor(() =>
      expect(stub?.world.startedRuns).toEqual([{ id: 'plain', input: { topic: 'weather' } }]),
    );
  });

  test('starts with no input when the JSON is empty', async () => {
    const { container } = open('/workflows/plain/run');
    const root = await ready(container);
    await fireEvent.click(primary(root));
    await waitFor(() => expect(stub?.world.startedRuns).toEqual([{ id: 'plain', input: null }]));
    expect(stub?.callsTo('bureau.workflows.start')[0]?.params).not.toHaveProperty('input');
  });

  test('refuses JSON that does not parse, and starts nothing', async () => {
    const { container, findByText } = open('/workflows/plain/run');
    const root = await ready(container);
    await fireEvent.input(root.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '{ nope' },
    });
    await fireEvent.click(primary(root));
    expect(await findByText(COPY.invalidJson)).not.toBeNull();
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
  });
});

describe('JSON input under a declared schema the form cannot draw', () => {
  async function typeJson(path: string, value: string) {
    const view = open(path);
    const root = await ready(view.container);
    await fireEvent.input(root.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value },
    });
    await fireEvent.click(primary(root));
    return { ...view, root };
  }

  test('refuses input the schema rejects, names where, and starts nothing', async () => {
    const view = await typeJson('/workflows/list-input/run', '[1, "two"]');
    expect(await view.findByText(/^1: /)).not.toBeNull();
    expect(stub?.callsTo('POST /workflows')).toEqual([]);
    expect(router.pathname).toBe('/workflows/list-input/run');
  });

  test('starts input the schema accepts', async () => {
    await typeJson('/workflows/list-input/run', '[1, 2]');
    await waitFor(() => expect(stub?.callsTo('POST /workflows')).toHaveLength(1));
  });
});

describe('a start that fails', () => {
  async function fail(fault: Error, path = '/workflows/digest/run') {
    const view = open(path);
    stub?.on('bureau.workflows.start', () => {
      throw fault;
    });
    const root = await ready(view.container);
    await type(field(root, 'Topic'), 'weather');
    await fireEvent.click(primary(root));
    expect(await view.findByText(COPY.startFailed)).not.toBeNull();
    // The input is where it was, and nothing moved on.
    expect(field(root, 'Topic').value).toBe('weather');
    expect(router.pathname).toBe(path);
    return view;
  }

  test('says a caller who may not write may not, in the page’s words', async () => {
    const view = await fail(new StubFault('Forbidden', 403, 'No.'));
    expect(await view.findByText(COPY.forbidden)).not.toBeNull();
  });

  test('says the workflow is gone or paused when the Bureau no longer finds it', async () => {
    const view = await fail(workflowFaults.notFound('workflow digest'));
    expect(await view.findByText(COPY.blocked.pausedDescription)).not.toBeNull();
  });

  test.each([
    ['a stale file', workflowFaults.stale('hash-2')],
    ['a taken identifier', workflowFaults.conflict('agent-file-exists')],
  ])('shows only the title for %s, which a start cannot cause', async (_name, fault) => {
    await fail(fault);
  });

  test('puts the engine’s failure to start a code-defined type in a banner, and keeps the input', async () => {
    const { container, findByText } = open('/workflows/order-processing/run');
    stub?.on('POST /workflows', () => {
      throw new Error('The engine is not accepting work.');
    });
    const root = await ready(container);
    await type(field(root, 'Topic'), 'refund');
    await fireEvent.click(primary(root));
    expect(await findByText(COPY.startFailed)).not.toBeNull();
    expect(field(root, 'Topic').value).toBe('refund');
    expect(router.pathname).toBe('/workflows/order-processing/run');
  });

  test('puts the Bureau’s refusal of JSON input under the editor, and keeps it', async () => {
    const { container, findByText } = open('/workflows/plain/run');
    stub?.on('bureau.workflows.start', () => {
      throw workflowFaults.invalidInput([{ path: ['topic'], message: 'Topic is required.' }]);
    });
    const root = await ready(container);
    const editor = root.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: '{ "count": 1 }' } });
    await fireEvent.click(primary(root));
    expect(await findByText('Topic is required.')).not.toBeNull();
    expect(editor.value).toBe('{ "count": 1 }');
    expect(router.pathname).toBe('/workflows/plain/run');
  });
});

describe('a start whose answer is lost', () => {
  test('says the run may have started, links to the runs, and keeps the input', async () => {
    const { container, findByText, findByRole } = open('/workflows/order-processing/run');
    stub?.on('POST /workflows', () => {
      throw new TypeError('Failed to fetch');
    });
    const root = await ready(container);
    await type(field(root, 'Topic'), 'refund');
    await fireEvent.click(primary(root));
    expect(await findByText(COPY.startMaybe)).not.toBeNull();
    expect(container.textContent).not.toContain(COPY.startFailed);
    expect(await findByRole('link', { name: COPY.checkRuns })).not.toBeNull();
    expect(field(root, 'Topic').value).toBe('refund');
  });
});

describe('a page that cannot be set up', () => {
  test('keeps the form, and what was typed, when a later read of the workflow fails', async () => {
    let queryClient: QueryClient | undefined;
    const view = open('/workflows/digest/run', {}, AUTHORIZATION_SCOPES, (created) => {
      queryClient = created;
    });
    const root = await ready(view.container);
    stub?.on('bureau.workflows.start', () => {
      throw new StubFault('Forbidden', 403, 'No.');
    });
    await type(field(root, 'Topic'), 'weather');
    await fireEvent.click(primary(root));
    expect(await view.findByText(COPY.startFailed)).not.toBeNull();
    // A background read of the workflow is refused, and the page must not swap the form for it.
    stub?.on('bureau.workflows.get', () => {
      throw workflowFaults.unprocessable('Refused.');
    });
    await queryClient?.refetchQueries({ queryKey: ['workflow-catalog'] });
    expect(
      queryClient
        ?.getQueryCache()
        .findAll({ queryKey: ['workflow-catalog'] })
        .some((query) => query.state.status === 'error'),
    ).toBe(true);
    expect(view.container.textContent).not.toContain(COPY.loadFailed.title);
    expect(field(root, 'Topic').value).toBe('weather');
  });

  test('says the workflow could not be loaded, and reads it again on retry', async () => {
    const { container, findByRole } = open('/workflows/digest/run');
    let reads = 0;
    const original = stub?.world.files[0];
    stub?.on('bureau.workflows.get', () => {
      reads += 1;
      // The frame's probe reads first and finds the file; the page's read is refused.
      if (reads === 1 || reads > 2) return original;
      throw workflowFaults.unprocessable('Refused.');
    });
    await waitFor(() =>
      expect(container.querySelector('[data-page="run-setup"] [role="alert"]')).toBeTruthy(),
    );
    expect(container.textContent).toContain(COPY.loadFailed.title);
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await ready(container);
    expect(container.textContent).not.toContain(COPY.loadFailed.title);
  });

  test('opens the workflow from the link in its place', async () => {
    const { findByRole } = open('/workflows/agentRun/run');
    await fireEvent.click(await findByRole('link', { name: COPY.blocked.openWorkflow }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/agentRun'));
  });

  test('disables a code-defined type’s action, with the scope it needs, for a principal that may not start', async () => {
    const { container } = open(
      '/workflows/order-processing/run',
      {},
      AUTHORIZATION_SCOPES.filter((scope) => scope !== 'workflows:write'),
    );
    const root = await ready(container);
    await waitFor(() => expect(primary(root).disabled).toBe(true));
    expect(primary(root).title).toBe('Requires workflows:write');
  });
});

describe('on a schedule', () => {
  async function chooseSchedule(root: HTMLElement): Promise<void> {
    await fireEvent.click(
      [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (radio) => radio.value === 'schedule',
      ) as HTMLElement,
    );
  }

  test('creates a schedule in the chosen zone, with the input, and opens it', async () => {
    const { container } = open('/workflows/order-processing/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'refund');
    await chooseSchedule(root);
    await fireEvent.click(primary(root));

    await waitFor(() => expect(stub?.callsTo('POST /schedules')).toHaveLength(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      type: 'order-processing',
      input: { topic: 'refund' },
      cronExpression: '0 9 * * *',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    expect(stub?.world.engineStarts).toEqual([]);
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\//));
  });

  test('creates no schedule for an input that is invalid', async () => {
    const { container } = open('/workflows/order-processing/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'ab');
    await chooseSchedule(root);
    await fireEvent.click(primary(root));
    await waitFor(() => expect(root.querySelector('[aria-invalid="true"]')).toBeTruthy());
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
  });

  test('refuses to create a schedule while a custom cron field on screen is out of range', async () => {
    const { container, findByText, getByLabelText } = open('/workflows/order-processing/run');
    const root = await ready(container);
    await type(field(root, 'Topic'), 'refund');
    await chooseSchedule(root);
    await fireEvent.change(getByLabelText('Repeats'), { target: { value: 'cron' } });
    await fireEvent.input(getByLabelText('Hour'), { target: { value: '99' } });
    await fireEvent.click(primary(root));
    expect(await findByText(COPY.scheduleInvalid)).not.toBeNull();
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
  });

  test('is offered for a file too, beside Now, which is the choice it opens on', async () => {
    const { container } = open('/workflows/digest/run');
    const root = await ready(container);
    const choices = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(choices.map((radio) => radio.value)).toEqual(['now', 'schedule']);
    expect(choices.find((radio) => radio.checked)?.value).toBe('now');
  });

  test('disables the action, with the scope it needs, for a principal that may not schedule', async () => {
    const { container } = open(
      '/workflows/order-processing/run',
      {},
      AUTHORIZATION_SCOPES.filter((scope) => scope !== 'schedules:write'),
    );
    const root = await ready(container);
    await chooseSchedule(root);
    await waitFor(() => expect(primary(root).disabled).toBe(true));
    expect(primary(root).title).toBe('Requires schedules:write');
  });
});

const summaryText = (root: ParentNode) =>
  root.querySelector('[data-testid="run-setup-summary"]')?.textContent?.trim();

/** A line's words with the white space around its link collapsed to one space. */
const words = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, ' ').trim();

/** Whether a control is off, natively or by `aria-disabled`. */
const isOff = (control: HTMLElement) =>
  (control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true';

describe('the design of the page', () => {
  test('names a titled workflow with its identifier beside it once, and says what it is for', async () => {
    const view = open('/workflows/release-notes/run');
    const root = await ready(view.container);
    expect(words(view.getByRole('heading', { level: 1 }))).toBe('Run Release notes release-notes');
    expect(root.querySelector('[data-testid="run-setup-identifier"]')?.textContent).toBe(
      'release-notes',
    );
    expect(root.textContent).toContain('Collects merged changes into a draft.');
  });

  test('names a file with no title by its identifier alone', async () => {
    const view = open('/workflows/digest/run');
    await ready(view.container);
    expect(words(view.getByRole('heading', { level: 1 }))).toBe('Run digest');
  });

  test('says where the form comes from, offers Edit as JSON, and marks the required Branch', async () => {
    const view = open('/workflows/release-notes/run');
    const root = await ready(view.container);
    expect(root.textContent).toContain(COPY.inputDescription);
    expect(view.getByRole('button', { name: COPY.editAsJson })).toBeTruthy();
    expect(field(root, 'Branch').required).toBe(true);
    expect(root.textContent).toContain('The branch to release from.');
    expect(summaryText(root)).toBe(COPY.summaryNow());
  });

  test('reads the input back in the footer as it is typed', async () => {
    const view = open('/workflows/release-notes/run');
    const root = await ready(view.container);
    await type(field(root, 'Branch'), 'main');
    await waitFor(() =>
      expect(summaryText(root)).toBe('Runs once, right away, on main from the last release.'),
    );
  });

  test('names the schedules that also start the workflow, with their names as links', async () => {
    const view = open('/workflows/release-notes/run', {
      schedules: [
        scheduleFixture('digest-schedule', 'release-notes', {
          description: 'Release notes digest',
          cronExpression: '0 11 * * 5',
          timeZone: 'America/Chicago',
        }),
        scheduleFixture('later-schedule', 'release-notes', {
          description: 'Weekly later',
          status: 'paused',
        }),
      ],
    });
    const root = await ready(view.container);
    const lines = await waitFor(() => {
      const found = [...root.querySelectorAll('[data-testid="run-setup-started-by"]')];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(words(lines[0])).toMatch(
      /^Also started by the Release notes digest schedule \(every \w+ at \d+:\d\d [AP]M\)\.$/,
    );
    expect(lines[0]?.querySelector('a')?.getAttribute('href')).toContain(
      '/schedules/digest-schedule',
    );
    expect(words(lines[1])).toBe('Also started by the Weekly later schedule (paused).');
    // The file's own schedule is one of these, so its trigger is not said twice.
    expect(root.querySelector('[data-testid="run-setup-trigger"]')).toBeNull();
    // Now's own line stays above them.
    expect(root.textContent).toContain(COPY.nowDescription);
  });

  test('says by its trigger kind what else starts a file: a signal by name', async () => {
    const view = open('/workflows/inbox-triage/run');
    const root = await ready(view.container);
    const note = await waitFor(() => {
      const found = root.querySelector('[data-testid="run-setup-trigger"]');
      expect(found).toBeTruthy();
      return found as Element;
    });
    expect(words(note)).toBe('Also starts on its own when message-received arrives.');
    expect(note.querySelector('code')?.textContent).toBe('message-received');
  });

  test('says a schedule trigger runs on its own schedule, once no schedule says it', async () => {
    const view = open('/workflows/release-notes/run');
    const root = await ready(view.container);
    const note = await waitFor(() => {
      const found = root.querySelector('[data-testid="run-setup-trigger"]');
      expect(found).toBeTruthy();
      return found as Element;
    });
    expect(words(note)).toMatch(
      /^Runs on its own schedule \(every \w+ at \d+:\d\d [AP]M\)\. Change it in the workflow\.$/,
    );
  });

  test('says nothing of a trigger for a type that code registered', async () => {
    const view = open('/workflows/order-processing/run');
    const root = await ready(view.container);
    await quietFor(50);
    expect(root.querySelector('[data-testid="run-setup-trigger"]')).toBeNull();
  });
});

describe('Edit as JSON', () => {
  async function editAsJson(path = '/workflows/release-notes/run') {
    const view = open(path);
    const root = await ready(view.container);
    await type(field(root, 'Branch'), 'main');
    await fireEvent.click(view.getByRole('button', { name: COPY.editAsJson }));
    const editor = await waitFor(() => {
      const found = root.querySelector('textarea');
      expect(found).toBeTruthy();
      return found as HTMLTextAreaElement;
    });
    return { ...view, root, editor };
  }

  const lead = (root: ParentNode) => words(root.querySelector('.ib-workflow-input__description'));

  test('replaces the drawn form with an editor that holds what the form held', async () => {
    const { root, editor } = await editAsJson();
    expect(JSON.parse(editor.value)).toMatchObject({ branch: 'main' });
    expect(root.querySelector('form')).toBeNull();
    expect(lead(root)).toBe(COPY.jsonEditing);
    expect(summaryText(root)).toBe(COPY.summaryJson);
  });

  test('takes what is typed in the JSON back to the form, and starts with it', async () => {
    const view = await editAsJson();
    await fireEvent.input(view.editor, { target: { value: '{ "branch": "dev" }' } });
    await fireEvent.click(view.getByRole('button', { name: COPY.backToForm }));
    await waitFor(() => expect(field(view.root, 'Branch').value).toBe('dev'));

    await fireEvent.click(view.getByRole('button', { name: COPY.editAsJson }));
    await fireEvent.click(primary(view.root));
    await waitFor(() =>
      expect(stub?.world.startedRuns).toEqual([{ id: 'release-notes', input: { branch: 'dev' } }]),
    );
  });

  test('turns the way back off while the JSON does not parse, with the line to fix in its label', async () => {
    const view = await editAsJson();
    await fireEvent.input(view.editor, {
      target: { value: '{\n  "branch": "main"\n  "since": "2026-10-23"\n}' },
    });
    const back = await view.findByRole('button', { name: COPY.backToFormBlocked(2) });
    expect(isOff(back)).toBe(true);
    expect(lead(view.root)).toBe(COPY.jsonEditingInvalid);
    expect(summaryText(view.root)).toBe(COPY.summaryJsonInvalid);
  });

  test('keeps Start run on while the JSON does not parse, and starts nothing', async () => {
    const view = await editAsJson();
    await fireEvent.input(view.editor, { target: { value: '{ "branch": ' } });
    expect(isOff(primary(view.root))).toBe(false);
    await fireEvent.click(primary(view.root));
    // A start can only be delayed by load, never advanced, so a quiet window proves none came.
    await quietFor(50);
    expect(stub?.world.startedRuns).toEqual([]);
    expect(stub?.callsTo('bureau.workflows.start')).toEqual([]);
  });

  test('never leaves the input empty, and holds the JSON to the schema', async () => {
    const view = await editAsJson();
    await fireEvent.input(view.editor, { target: { value: '' } });
    await fireEvent.click(primary(view.root));
    await waitFor(() => expect(view.root.textContent).toContain(COPY.jsonRequired));

    // Valid JSON that the schema refuses (no branch) marks the editor and starts nothing.
    await fireEvent.input(view.editor, { target: { value: '{ "since": "2026-10-23" }' } });
    await waitFor(() => expect(view.root.textContent).not.toContain(COPY.jsonRequired));
    await fireEvent.click(primary(view.root));
    await waitFor(() => expect(view.editor.getAttribute('aria-invalid')).toBe('true'));
    expect(stub?.world.startedRuns).toEqual([]);
  });

  test('is not offered for a schema that holds a concealed field, however deeply nested', async () => {
    const view = open('/workflows/secret-input/run');
    const root = await ready(view.container);
    expect(view.queryByRole('button', { name: COPY.editAsJson })).toBeNull();
    expect(root.querySelector('form')).toBeTruthy();
  });

  test('is not offered for a schema the form cannot draw, which is already JSON', async () => {
    const view = open('/workflows/list-input/run');
    const root = await ready(view.container);
    expect(view.queryByRole('button', { name: COPY.editAsJson })).toBeNull();
    expect(root.querySelector('textarea')).toBeTruthy();
  });
});

describe('On a schedule, for a file', () => {
  async function schedule(path = '/workflows/release-notes/run') {
    const view = open(path);
    const root = await ready(view.container);
    await type(field(root, 'Branch'), 'main');
    await fireEvent.click(
      [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (radio) => radio.value === 'schedule',
      ) as HTMLElement,
    );
    return { ...view, root };
  }

  test('says it is a schedule in the heading, the breadcrumb, the input lead and the button', async () => {
    const view = await schedule();
    await waitFor(() =>
      expect(words(view.getByRole('heading', { level: 1 }))).toBe(
        'Schedule Release notes release-notes',
      ),
    );
    expect(view.root.textContent).toContain(COPY.scheduleInputLead);
    expect(primary(view.root).textContent?.trim()).toBe(COPY.scheduleAction);
    await waitFor(() =>
      expect(breadcrumbTrail('/workflows/release-notes/run').map((crumb) => crumb.label)).toEqual(
        expect.arrayContaining(['Release notes', COPY.scheduleCrumb]),
      ),
    );
  });

  test('asks for the name last, starting as the workflow’s title', async () => {
    const view = await schedule();
    const name = field(view.root, 'Name');
    expect(name.value).toBe('Release notes');
    expect(name.required).toBe(true);
    expect(view.root.textContent).toContain(COPY.nameDescription);
    // The When block comes first, then the two policies, and the Name follows them.
    const order = [
      view.getByLabelText('Repeats'),
      view.getByLabelText('If a run is still going'),
      name,
    ];
    for (const [index, control] of order.entries()) {
      const next = order[index + 1];
      if (next === undefined) continue;
      // 4 is DOCUMENT_POSITION_FOLLOWING: the next control comes later in the document.
      expect(control.compareDocumentPosition(next) & 4).toBeTruthy();
    }
  });

  test('reads the input and the schedule back in plain words', async () => {
    const view = await schedule();
    await waitFor(() =>
      expect(summaryText(view.root)).toMatch(
        /^Creates a schedule that runs Release notes on main, from the last release, every day at 9:00 AM /,
      ),
    );
  });

  test('sends the name the person typed in its place', async () => {
    const view = await schedule();
    await fireEvent.input(field(view.root, 'Name'), { target: { value: 'My notes' } });
    await fireEvent.click(primary(view.root));
    await waitFor(() => expect(stub?.callsTo('POST /schedules')).toHaveLength(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({ description: 'My notes' });
  });

  test('creates the schedule with the input, the name and both policies, and opens it', async () => {
    const view = await schedule();
    await fireEvent.change(view.getByLabelText('If a run is still going'), {
      target: { value: 'allow' },
    });
    await fireEvent.change(view.getByLabelText(COPY.catchUpLabel), { target: { value: 'on' } });
    await fireEvent.click(primary(view.root));

    await waitFor(() => expect(stub?.callsTo('POST /schedules')).toHaveLength(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      type: 'release-notes',
      input: { branch: 'main' },
      description: 'Release notes',
      overlap: 'allow',
      backfill: true,
    });
    await waitFor(() => expect(router.pathname).toMatch(/^\/schedules\//));
  });

  test('skips an overlap and catches up on nothing by default', async () => {
    const view = await schedule();
    await fireEvent.click(primary(view.root));
    await waitFor(() => expect(stub?.callsTo('POST /schedules')).toHaveLength(1));
    expect(stub?.callsTo('POST /schedules')[0]?.params).toMatchObject({
      overlap: 'skip',
      backfill: false,
    });
  });

  test('refuses an empty name at the field, and creates nothing', async () => {
    const view = await schedule();
    await fireEvent.input(field(view.root, 'Name'), { target: { value: '   ' } });
    await fireEvent.click(primary(view.root));
    expect(await view.findByText(COPY.nameRequired)).not.toBeNull();
    await waitFor(() => expect(document.activeElement?.id).toBe('run-setup-name'));
    expect(stub?.callsTo('POST /schedules')).toEqual([]);
  });

  test('goes back to Now with the same input', async () => {
    const view = await schedule();
    await fireEvent.click(
      [...view.root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (radio) => radio.value === 'now',
      ) as HTMLElement,
    );
    await waitFor(() => expect(primary(view.root).textContent?.trim()).toBe(COPY.startAction));
    expect(field(view.root, 'Branch').value).toBe('main');
    expect(words(view.getByRole('heading', { level: 1 }))).toBe('Run Release notes release-notes');
  });
});
