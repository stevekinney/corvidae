/**
 * COR-1893: a trigger kind a running plugin contributes is a choice under the builder's trigger
 * ("Starts"), its configuration is drawn from the schema the Bureau reports
 * (`bureau.plugins.kinds`), and an edit writes the trigger the file holds: the kind and its fields.
 * A trigger kind no running plugin contributes is kept as the file has it and edited in the JSON tab.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import {
  emptyWorld,
  installWorkflowWorld,
  readyFile,
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

const INBOX_MESSAGE = {
  plugin: 'inbox',
  id: 'inbox:message',
  description: 'A message arrives in a mailbox.',
  version: '2.0.0',
  configuration: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      mailbox: { type: 'string', description: 'The mailbox to watch.' },
    },
    required: ['mailbox'],
  },
};

function open(
  options: {
    kinds?: unknown[];
    trigger?: Record<string, unknown>;
    /** Answers `bureau.plugins.kinds` in place of the list in `kinds`. */
    answer?: () => unknown;
  } = {},
) {
  stub = installWorkflowWorld(
    emptyWorld({
      files: [
        readyFile('digest', {
          trigger: options.trigger ?? { kind: 'schedule', spec: '1h' },
          text: JSON.stringify(
            {
              name: 'digest',
              trigger: options.trigger ?? { kind: 'schedule', spec: '1h' },
              agent: 'writer',
              steps: [{ kind: 'sleep', duration: '1m' }],
            },
            null,
            2,
          ),
        }),
      ],
    }),
  );
  stub.on(
    'bureau.plugins.kinds',
    options.answer ??
      (() => ({
        triggerKinds: options.kinds ?? [INBOX_MESSAGE],
        hookActionKinds: [],
      })),
  );
  router.navigate('/workflows/digest/edit', { replace: true });
  return render(Harness, { props: { client: stub.client, scopes: AUTHORIZATION_SCOPES } } as never);
}

const field = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);

async function builderReady(container: HTMLElement): Promise<void> {
  const tab = await waitFor(() => {
    const found = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === WORKFLOW_COPY.builder.builderTab,
    );
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  await fireEvent.click(tab);
  await waitFor(() => expect(field(container, 'workflow-builder-trigger-kind')).toBeTruthy());
}

describe('a contributed trigger kind in the builder', () => {
  test('is offered under Starts beside the built-in triggers, and its schema fields render when chosen', async () => {
    const { container, getByLabelText } = open();
    await builderReady(container);
    const select = field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement;

    await waitFor(() =>
      expect([...select.options].map((option) => option.value)).toEqual([
        'schedule',
        'signal',
        'inbox:message',
      ]),
    );
    expect([...select.options].map((option) => option.textContent?.trim())).toContain(
      WORKFLOW_COPY.builder.contributedTrigger('inbox:message'),
    );

    await fireEvent.change(select, { target: { value: 'inbox:message' } });
    await waitFor(() => expect(getByLabelText(/mailbox/i)).toBeTruthy());
    expect(container.querySelector('[data-testid="contributed-trigger"]')?.textContent).toContain(
      'A message arrives in a mailbox.',
    );
  });

  test('writes the trigger the file holds, the kind and its fields, and saves it', async () => {
    const { container, getByLabelText, getByRole } = open();
    await builderReady(container);
    const select = field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    await fireEvent.change(select, { target: { value: 'inbox:message' } });
    const mailbox = await waitFor(() => {
      const found = getByLabelText(/mailbox/i);
      expect(found).toBeTruthy();
      return found;
    });
    await fireEvent.input(mailbox, { target: { value: 'support' } });

    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    const definition = stub?.callsTo('bureau.workflows.update')[0]?.params['definition'] as Record<
      string,
      unknown
    >;
    expect(definition['trigger']).toEqual({ kind: 'inbox:message', mailbox: 'support' });
  });

  test('shows a file’s contributed trigger with its fields filled in', async () => {
    const { container, getByLabelText } = open({
      trigger: { kind: 'inbox:message', mailbox: 'billing' },
    });
    await builderReady(container);
    await waitFor(() =>
      expect((getByLabelText(/mailbox/i) as HTMLInputElement).value).toBe('billing'),
    );
    expect((field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement).value).toBe(
      'inbox:message',
    );
  });

  test('leaves a trigger no running plugin contributes as the file has it, and says so', async () => {
    const { container } = open({
      kinds: [],
      trigger: { kind: 'inbox:message', mailbox: 'billing' },
    });
    await builderReady(container);
    await waitFor(() =>
      expect(container.textContent).toContain(
        WORKFLOW_COPY.builder.unavailableTrigger('inbox:message'),
      ),
    );
    expect((field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement).disabled).toBe(
      true,
    );
  });

  test('offers only the built-in triggers when the host cannot say what plugins add', async () => {
    const { container } = open();
    stub?.on('bureau.plugins.kinds', () => {
      throw new Error('down');
    });
    await builderReady(container);
    const select = field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['schedule', 'signal']);
  });

  test('saves an untouched choice with the value it shows', async () => {
    const { container, getByRole } = open({
      kinds: [
        {
          ...INBOX_MESSAGE,
          configuration: {
            type: 'object',
            properties: { priority: { enum: ['normal', 'urgent'] } },
            required: ['priority'],
          },
        },
      ],
    });
    await builderReady(container);
    const select = field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    await fireEvent.change(select, { target: { value: 'inbox:message' } });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="contributed-trigger"]')).toBeTruthy(),
    );

    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/workflows/digest'));
    const definition = stub?.callsTo('bureau.workflows.update')[0]?.params['definition'] as Record<
      string,
      unknown
    >;
    expect(definition['trigger']).toEqual({ kind: 'inbox:message', priority: 'normal' });
  });

  test('keeps the stored kind and says it is checking while the plugin kinds load', async () => {
    let release: (answer: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const { container, getByLabelText } = open({
      trigger: { kind: 'inbox:message', mailbox: 'billing' },
      answer: () => pending,
    });
    await builderReady(container);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="contributed-trigger-loading"]')).toBeTruthy(),
    );
    expect(container.textContent).not.toContain(
      WORKFLOW_COPY.builder.unavailableTrigger('inbox:message'),
    );
    expect((field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement).value).toBe(
      'inbox:message',
    );

    release({ triggerKinds: [INBOX_MESSAGE], hookActionKinds: [] });
    await waitFor(() =>
      expect((getByLabelText(/mailbox/i) as HTMLInputElement).value).toBe('billing'),
    );
  });

  test('keeps the stored kind, says the read failed, and retries, instead of claiming the plugin is missing', async () => {
    const { container, getByLabelText, getByRole } = open({
      trigger: { kind: 'inbox:message', mailbox: 'billing' },
      answer: () => {
        throw new Error('down');
      },
    });
    await builderReady(container);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="contributed-trigger-error"]')).toBeTruthy(),
    );
    expect(container.textContent).toContain(
      WORKFLOW_COPY.builder.triggerKindsFailed('inbox:message'),
    );
    expect(container.textContent).not.toContain(
      WORKFLOW_COPY.builder.unavailableTrigger('inbox:message'),
    );
    expect((field(container, 'workflow-builder-trigger-kind') as HTMLSelectElement).value).toBe(
      'inbox:message',
    );

    stub?.on('bureau.plugins.kinds', () => ({
      triggerKinds: [INBOX_MESSAGE],
      hookActionKinds: [],
    }));
    await fireEvent.click(getByRole('button', { name: WORKFLOW_COPY.builder.retryTriggerKinds }));
    await waitFor(() =>
      expect((getByLabelText(/mailbox/i) as HTMLInputElement).value).toBe('billing'),
    );
  });
});
