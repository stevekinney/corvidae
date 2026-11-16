/**
 * COR-2171: a workflow file with a plugin trigger shows what its listener is doing under the header
 * of its page (each state, a failed one with its code and when it is tried again), a failed one
 * offers Retry now, which calls `bureau.workflows.triggers.retry` and shows the state it answers,
 * and a kind that receives shows the address its deliveries go to with a copy control. A run a
 * trigger started names the trigger's plugin in Started by.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { STUB_TRIGGERS_URL } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  emptyWorld,
  type FileFixture,
  installWorkflowWorld,
  readyFile,
  type WorkflowStub,
} from '../../lib/workflow-world.test-support.ts';
import RunOrigin from '../workflows/runs/run-origin.svelte';
import { triggerOrigin } from '../workflows/runs/run-rows.ts';
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

const copy = WORKFLOW_COPY.page.listener;
const SINCE = '2020-01-01T00:00:00.000Z';

type Listener = NonNullable<FileFixture['listener']>;

const listening: Listener = {
  state: 'listening',
  since: SINCE,
  code: null,
  lastFiredAt: null,
  retryAt: null,
};

/** The plugin trigger kinds the running plugins contribute: `inbox:message` listens, `inbox:hook` receives. */
const KINDS = {
  triggers: [
    {
      plugin: 'inbox',
      id: 'inbox:message',
      description: 'A message arrives.',
      version: '1.0.0',
      receives: false,
      configuration: null,
    },
    {
      plugin: 'inbox',
      id: 'inbox:hook',
      description: 'A delivery arrives.',
      version: '1.0.0',
      receives: true,
      configuration: null,
    },
  ],
  reactions: [],
};

function open(listener: Listener | null, kind = 'inbox:message') {
  const trigger = { kind };
  stub = installWorkflowWorld(
    emptyWorld({
      files: [
        readyFile('digest', {
          trigger,
          listener,
          schedule: null,
          text: JSON.stringify(
            { name: 'digest', trigger, agent: 'writer', steps: [{ kind: 'sleep', duration: '1m' }] },
            null,
            2,
          ),
        }),
      ],
    }),
  );
  stub.on('bureau.plugins.contributions', () => KINDS);
  router.navigate('/workflows/digest', { replace: true });
  return render(Harness, { props: { client: stub.client, scopes: AUTHORIZATION_SCOPES } } as never);
}

/** The trigger section, once the page has drawn it. */
async function section(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-testid="workflow-trigger-listener"]');
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
}

describe('the trigger status on a workflow’s page', () => {
  const STATES: ReadonlyArray<readonly [Listener, string]> = [
    [listening, copy.states.listening],
    [{ ...listening, state: 'ready' }, copy.states.ready],
    [{ ...listening, state: 'standby' }, copy.states.standby],
    [{ ...listening, state: 'waiting-for-secret' }, copy.states['waiting-for-secret']],
    [{ ...listening, state: 'stopped' }, copy.states.stopped],
    [{ ...listening, state: 'failed', code: 'configuration-refused' }, copy.states.failed],
  ];

  for (const [listener, label] of STATES) {
    test(`shows ${listener.state} with its sentence`, async () => {
      const { container } = open(listener);
      const found = await section(container);
      expect(found.querySelector('[data-state]')?.getAttribute('data-state')).toBe(listener.state);
      expect(found.textContent).toContain(label);
      if (listener.state === 'standby') expect(found.textContent).toContain(copy.standby);
      if (listener.state === 'stopped') expect(found.textContent).toContain(copy.stopped);
    });
  }

  test('shows a failed listener with its code and when it is tried again, and offers Retry now', async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const { container, getByRole } = open({
      ...listening,
      state: 'failed',
      code: 'start-failed',
      retryAt,
    });
    const found = await section(container);
    expect(found.textContent).toContain(copy.states.failed);
    expect(found.querySelector('[data-testid="workflow-trigger-code"]')?.textContent).toBe(
      'start-failed',
    );
    expect(found.textContent).toContain('It is tried again in');
    expect(getByRole('button', { name: copy.retry })).toBeTruthy();
  });

  test('offers no Retry now for a listener that is not failed', async () => {
    const { container, queryByRole } = open(listening);
    await section(container);
    expect(queryByRole('button', { name: copy.retry })).toBeNull();
  });

  test('Retry now calls bureau.workflows.triggers.retry and shows the state it answers', async () => {
    const { container, getByRole } = open({
      ...listening,
      state: 'failed',
      code: 'start-failed',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await section(container);
    const retried: unknown[] = [];
    stub!.on('bureau.workflows.triggers.retry', (params) => {
      retried.push(params);
      return { id: 'digest', listener: { ...listening, state: 'standby' } };
    });
    await fireEvent.click(getByRole('button', { name: copy.retry }));
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-testid="workflow-trigger-listener"] [data-state]')
          ?.getAttribute('data-state'),
      ).toBe('standby'),
    );
    expect(retried).toEqual([{ id: 'digest' }]);
  });

  test('a kind that receives shows the address its deliveries go to, with a copy control', async () => {
    const { container } = open({ ...listening, state: 'ready' }, 'inbox:hook');
    const found = await section(container);
    await waitFor(() =>
      expect(found.querySelector('[data-testid="workflow-trigger-address"]')?.textContent).toBe(
        `${STUB_TRIGGERS_URL}digest`,
      ),
    );
    expect(found.querySelector(`button[aria-label="${copy.copyAddress}"]`)).toBeTruthy();
  });

  test('a kind that only listens shows no address', async () => {
    const { container } = open(listening, 'inbox:message');
    const found = await section(container);
    // The kinds have loaded, and the section still has no address.
    await waitFor(() => expect(stub!.callsTo('bureau.plugins.contributions').length).toBe(1));
    expect(found.querySelector('[data-testid="workflow-trigger-address"]')).toBeNull();
  });

  test('a file with no listener shows no trigger status', async () => {
    const { container, findByText } = open(null, 'schedule');
    await findByText('digest');
    expect(container.querySelector('[data-testid="workflow-trigger-listener"]')).toBeNull();
  });
});

describe('the Started by of a run a trigger started (COR-2171)', () => {
  test('names the trigger’s plugin and links to the file whose trigger it is', () => {
    const { container } = render(RunOrigin, {
      props: { origin: triggerOrigin('linear', 'sync') },
    });
    const link = container.querySelector<HTMLAnchorElement>('a');
    expect(link?.textContent).toBe('linear');
    expect(link?.getAttribute('href')).toContain('/workflows/sync');
  });
});
