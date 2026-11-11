/**
 * The New agent form (board PageAgentEditor, and PageAppStates rows 14u-14x) against a stand-in
 * for the Bureau: the line under the heading, the tools table and its Asks selects, a save the
 * server fails, a save in flight and one that is never answered, a catalog that does not load, and
 * the question before leaving a form with unsaved changes.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import type { AgentCatalog } from '../../lib/agent-definitions.ts';
import {
  catalogFixture,
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { until } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { SAVE_TIMEOUT_MS } from './agent-editor-save.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

const copy = AGENT_EDITOR_COPY;
const newCopy = AGENT_EDITOR_COPY.newAgent;

let stub: BureauStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/agents/new', { replace: true });
});

afterEach(() => {
  jest.useRealTimers();
  stub?.restore();
  stub = undefined;
});

/** The tools the sample world's New agent board draws (row 41k): one that reads, one dangerous, one that changes things. */
const TOOLS = [
  {
    name: 'lookup-order',
    title: 'Lookup order',
    description: 'Look an order up.',
    shortDescription: null,
    tier: 'read-only' as const,
    defaultApproval: 'allow' as const,
    source: 'bureau' as const,
  },
  {
    name: 'issue-refund',
    title: 'Issue refund',
    description: 'Refund an order.',
    shortDescription: null,
    tier: 'dangerous' as const,
    defaultApproval: 'ask' as const,
    source: 'bureau' as const,
  },
  {
    name: 'triage-refunds',
    title: 'Triage refunds',
    description: 'Sort refund requests.',
    shortDescription: null,
    tier: 'mutating' as const,
    defaultApproval: 'ask' as const,
    source: 'bureau' as const,
  },
];

/** The Bureau for one test: a catalog (or a function that answers each read), and creates that succeed. */
function bureau(catalog: AgentCatalog | (() => AgentCatalog) = catalogFixture()): BureauStub {
  stub = installBureauStub({
    'bureau.agents.catalog': () => (typeof catalog === 'function' ? catalog() : catalog),
    'bureau.agents.definitions.create': (params) => ({
      id: String(params['id']),
      hash: 'created',
    }),
  });
  return stub;
}

function mountEditor() {
  return render(Harness, { props: {} } as never);
}

async function type(element: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(element, { target: { value } });
}

/** The definition the first create wrote. */
function createdDefinition(installed: BureauStub): Record<string, unknown> {
  const [call] = installed.callsTo('bureau.agents.definitions.create');
  if (call === undefined) throw new Error('nothing was created');
  return (call.params as { definition: Record<string, unknown> }).definition;
}

describe('the New agent form', () => {
  test('says what an agent is under its heading, and offers to copy the file path (rows 41a, 41c)', async () => {
    bureau();
    const { findByRole, getByTestId, getByRole } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Order helper');

    expect(getByTestId('agent-new-subtitle').textContent?.trim()).toBe(newCopy.subtitle);
    expect(getByTestId('agent-file-path').textContent).toContain('order-helper.md');
    expect(getByRole('button', { name: newCopy.copyFilePath })).not.toBeNull();
    // A new agent has no Guardrails and limits section: the Access tab sets them once it is saved (S31).
    expect(document.body.textContent).not.toContain(copy.sections.limits);
  });

  test('describes a description, and counts the words of the instructions (rows 41f, 41i)', async () => {
    bureau();
    const { findByRole, getByRole } = mountEditor();
    const description = await findByRole('textbox', { name: /^Description/ });
    expect(description).toHaveAccessibleDescription(
      expect.stringContaining(copy.descriptionDescription),
    );

    await type(getByRole('textbox', { name: /^Instructions/ }), '## Role\nAnswer order questions.');
    expect(document.body.textContent).toContain(
      `${newCopy.instructionsFormat}, ${newCopy.wordCount(5)}`,
    );
  });

  test('lists the chosen tools in one table, with risk in words and an Asks select at each tool’s default (rows 41k, 41l, 41m)', async () => {
    const calls = bureau(catalogFixture({ tools: TOOLS }));
    const view = mountEditor();
    const { findByRole, getByRole, getByTestId } = view;
    await type(await findByRole('textbox', { name: /^Name/ }), 'Order helper');

    await fireEvent.click(getByRole('button', { name: copy.addToolsAction }));
    for (const tool of TOOLS) {
      await fireEvent.click(await findByRole('checkbox', { name: tool.name }));
    }
    await fireEvent.click(getByRole('button', { name: copy.toolPicker.done }));

    expect(getByRole('group', { name: /^Tools/ }).textContent).toContain(newCopy.toolCount(3, 3));
    const table = getByTestId('agent-tools-table');
    const row = (name: string): HTMLElement => {
      const found = table.querySelector<HTMLElement>(`[data-tool="${name}"]`);
      if (found === null) throw new Error(`${name} is not in the table`);
      return found;
    };
    expect(row('lookup-order').textContent).toContain('Lookup order');
    expect(row('lookup-order').textContent).toContain('lookup-order');
    expect(within(row('issue-refund')).getByTestId('agent-tool-risk').textContent?.trim()).toBe(
      'Dangerous',
    );
    expect(within(row('triage-refunds')).getByTestId('agent-tool-risk').textContent?.trim()).toBe(
      'Changes things',
    );
    const select = (name: string): HTMLSelectElement => {
      const found = row(name).querySelector<HTMLSelectElement>('select');
      if (found === null) throw new Error(`${name} has no Asks select`);
      return found;
    };
    expect(select('lookup-order').value).toBe('never');
    expect(select('issue-refund').value).toBe('always');
    expect(select('triage-refunds').value).toBe('on-changes');
    const labels = Array.from(select('issue-refund').options).map((option) => option.text.trim());
    expect(labels).toEqual(['Never', 'On changes', 'Always (default)', 'Blocked']);
    expect(getByTestId('agent-asks-note').textContent?.trim()).toBe(newCopy.asksNote);

    // A level other than the default is written; the default is what the file says by saying nothing.
    await fireEvent.change(select('issue-refund'), { target: { value: 'blocked' } });
    await fireEvent.change(select('lookup-order'), { target: { value: 'always' } });
    await fireEvent.change(select('lookup-order'), { target: { value: 'never' } });
    await fireEvent.click(getByRole('button', { name: copy.createAction }));

    await waitFor(() => expect(router.pathname).toBe('/agents/order-helper'));
    const definition = createdDefinition(calls);
    expect(definition['tools']).toEqual(['lookup-order', 'issue-refund', 'triage-refunds']);
    expect(definition['approvals']).toEqual({ 'issue-refund': 'blocked' });
  });

  test('says a failed save above the form, with the status, and keeps what was typed (row 42w)', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.create', () => {
      throw new StubFault('EngineFailure', 500, 'Something broke.');
    });
    const { findByRole, getByRole } = mountEditor();
    const name = await findByRole('textbox', { name: /^Name/ });
    await type(name, 'Release helper');
    await fireEvent.click(getByRole('button', { name: copy.createAction }));

    const alert = await findByRole('alert');
    expect(alert.textContent).toContain(copy.saveFailed);
    expect(alert.textContent).toContain(newCopy.serverError(500));
    expect(name).toHaveValue('Release helper');
    expect(router.pathname).toBe('/agents/new');
  });
});

describe('a save in flight (rows 43j, 14w)', () => {
  test('says Saving…, holds Save in its loading state, ignores a second press, and keeps Cancel', async () => {
    const calls = bureau();
    let answer: (value: unknown) => void = () => undefined;
    calls.on(
      'bureau.agents.definitions.create',
      (params) =>
        new Promise((resolve) => {
          answer = () => resolve({ id: String(params['id']), hash: 'created' });
        }),
    );
    const { findByRole, getByRole, getByTestId } = mountEditor();
    await type(await findByRole('textbox', { name: /^Name/ }), 'Release helper');
    const save = getByRole('button', { name: copy.createAction });
    await fireEvent.click(save);

    await waitFor(() =>
      expect(getByTestId('agent-save-status').textContent?.trim()).toBe(newCopy.saving),
    );
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(getByRole('button', { name: copy.cancelAction })).not.toBeDisabled();
    await fireEvent.click(save);
    expect(calls.callsTo('bureau.agents.definitions.create')).toHaveLength(1);
    // Nothing says it is saved until the server answers.
    expect(router.pathname).toBe('/agents/new');

    answer(undefined);
    await waitFor(() => expect(router.pathname).toBe('/agents/release-helper'));
  });
});

describe('a save with no answer (row 14x)', () => {
  test('stops waiting after 15 seconds, keeps what was typed, and offers Try again and Cancel', async () => {
    const calls = bureau();
    calls.on('bureau.agents.definitions.create', () => new Promise(() => undefined));
    // The page's own clock is the fake one, so the 15 seconds can be advanced.
    jest.useFakeTimers();
    const view = mountEditor();
    await until(() => expect(view.getByRole('textbox', { name: /^Name/ })).not.toBeNull());
    const name = view.getByRole('textbox', { name: /^Name/ });
    await type(name, 'Release helper');
    await fireEvent.click(view.getByRole('button', { name: copy.createAction }));
    await until(() =>
      expect(view.getByTestId('agent-save-status').textContent?.trim()).toBe(newCopy.saving),
    );
    expect(view.queryByTestId('agent-save-timed-out')).toBeNull();

    jest.advanceTimersByTime(SAVE_TIMEOUT_MS);
    await until(() =>
      expect(view.getByTestId('agent-save-timed-out').textContent).toContain(newCopy.timedOut),
    );
    const notice = view.getByTestId('agent-save-timed-out');
    expect(name).toHaveValue('Release helper');
    expect(router.pathname).toBe('/agents/new');
    expect(within(notice).getByRole('button', { name: copy.cancelAction })).not.toBeNull();

    // Try again sends the save once more.
    await fireEvent.click(within(notice).getByRole('button', { name: newCopy.tryAgain }));
    await until(() => expect(calls.callsTo('bureau.agents.definitions.create')).toHaveLength(2));
    expect(view.queryByTestId('agent-save-timed-out')).toBeNull();
  });
});

describe('a catalog that does not load (row 42v)', () => {
  test('keeps the form, says so at the Model field in red, and keeps what was typed once Try again reads it', async () => {
    let failing = true;
    bureau(() => {
      if (failing) throw new StubFault('EngineFailure', 500, 'The catalog is down.');
      return catalogFixture();
    });
    const { findByRole, findByTestId, getByRole, queryByTestId } = mountEditor();
    const name = await findByRole('textbox', { name: /^Name/ });
    const failed = await findByTestId('agent-models-failed');
    expect(failed.textContent).toContain(newCopy.modelsFailed.title);
    expect(failed.textContent).toContain(newCopy.modelsFailed.description);
    expect(getByRole('combobox', { name: 'Model' })).toHaveAttribute(
      'placeholder',
      newCopy.modelsFailed.placeholder,
    );

    await type(name, 'Order helper');
    failing = false;
    await fireEvent.click(within(failed).getByRole('button', { name: newCopy.modelsFailed.retry }));

    await waitFor(() => expect(queryByTestId('agent-models-failed')?.outerHTML ?? null).toBeNull());
    expect(getByRole('textbox', { name: /^Name/ })).toHaveValue('Order helper');
    expect(getByRole('combobox', { name: 'Model' })).toHaveValue('anthropic/claude-sonnet-5');
  });
});

describe('leaving with unsaved changes (rows 42o, 42p)', () => {
  test('leaves without asking while nothing has been typed', async () => {
    bureau();
    const { findByRole, getByRole, queryByRole } = mountEditor();
    await findByRole('textbox', { name: /^Name/ });

    await fireEvent.click(getByRole('button', { name: copy.cancelAction }));
    expect(router.pathname).toBe('/agents');
    expect(queryByRole('dialog', { name: newCopy.leave.title })).toBeNull();
  });

  test('asks first, names what changed, stays on Keep editing, and leaves on Discard and leave', async () => {
    bureau(catalogFixture({ tools: TOOLS }));
    const { findByRole, getByRole } = mountEditor();
    await findByRole('textbox', { name: /^Name/ });
    await type(getByRole('textbox', { name: /^Instructions/ }), 'Answer order questions.');
    await fireEvent.click(getByRole('button', { name: copy.addToolsAction }));
    await fireEvent.click(await findByRole('checkbox', { name: 'lookup-order' }));
    await fireEvent.click(getByRole('button', { name: copy.toolPicker.done }));

    await fireEvent.click(getByRole('button', { name: copy.cancelAction }));
    const dialog = await findByRole('dialog', { name: newCopy.leave.title });
    expect(dialog.textContent).toContain(
      newCopy.leave.description([copy.sections.instructions, copy.sections.tools]),
    );
    expect(router.pathname).toBe('/agents/new');
    await fireEvent.click(within(dialog).getByRole('button', { name: newCopy.leave.keep }));
    expect(router.pathname).toBe('/agents/new');

    // A link in the shell is asked about the same way.
    router.navigate('/chats');
    const again = await findByRole('dialog', { name: newCopy.leave.title });
    expect(router.pathname).toBe('/agents/new');
    await fireEvent.click(within(again).getByRole('button', { name: newCopy.leave.discard }));
    await waitFor(() => expect(router.pathname).toBe('/chats'));
  });
});
