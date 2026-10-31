/**
 * `/workflows/:workflow/run`: the workflow is fixed by the address, the input is a form drawn from
 * its schema (or JSON when it declares none), and the run starts now or on a schedule. An invalid
 * input shows its field errors and starts nothing; the Bureau's refusal lands on the field it
 * names and keeps what was typed; plain Enter never starts; and a second ask while one is in
 * flight is dropped. The footer's summary and its pinned action are the page's only controls
 * that write.
 */
import { quietFor } from '@lostgradient/testing/wait-until';
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

function open(
  path: string,
  overrides: Partial<World> = {},
  scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES,
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
        codeDefinition('agentRun'),
        sourceDefinition('digest'),
        sourceDefinition('plain', { contract: { name: 'plain' } }),
      ],
      files: [
        readyFile('digest', { inputSchema: TOPIC_SCHEMA }),
        readyFile('plain'),
        readyFile('paused-one', { paused: true }),
        invalidFile('broken'),
      ],
      ...overrides,
    }),
  );
  router.navigate(path, { replace: true });
  return render(Harness, { props: { client: stub.client, scopes } } as never);
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
    expect(summary()).toBe(COPY.summaryNow('order-processing'));
    await fireEvent.click(getByRole('radio', { name: new RegExp(COPY.schedule) }));
    await waitFor(() => expect(summary()).toContain('in '));
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

describe('a page that cannot be set up', () => {
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

  test('is not offered for a file, whose schedule is the trigger in its file, and says so', async () => {
    const { container } = open('/workflows/digest/run');
    const root = await ready(container);
    const choices = [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(choices.map((radio) => radio.value)).toEqual(['now']);
    expect(root.textContent).toContain(COPY.scheduleInFile);
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
