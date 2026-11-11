/**
 * The Edit agent form (board PageAgentEditor, frames "Edit agent", "Edit agent, loading" and "Save,
 * in flight") against a stand-in for the Bureau: the line under the heading, the file line, the
 * fields a saved agent's form owns, the read-only lines that point to the Settings and Access tabs,
 * the reference documents, the delete block, the saved status in the sticky bar, a save in flight,
 * and the loading state. A saved agent's model, tools, guardrails and limits are carried through a
 * save unchanged, because the form shows no control for them.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { breadcrumbTrail } from '../../app/breadcrumbs.svelte.ts';
import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import type { AgentDetail } from '../../lib/agent-definitions.ts';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  STUB_AGENT_DIRECTORY,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

const copy = AGENT_EDITOR_COPY;
const editCopy = AGENT_EDITOR_COPY.edit;

let stub: BureauStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/', { replace: true });
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

/** The saved version the sticky bar names, as `bureau.agents.versions.list` answers it. */
function versionFixture(revision: number): Record<string, unknown> {
  return {
    revision,
    hash: 'hash-1',
    savedAt: new Date().toISOString(),
    savedBy: null,
    definition: readyAgent().definition,
    changedKeys: [],
  };
}

/** The Bureau for one test: the agent that exists, its saved versions, and a catalog. */
function bureau(
  options: {
    readonly agent?: AgentDetail;
    readonly versions?: readonly unknown[];
  } = {},
): BureauStub {
  const agent = options.agent ?? readyAgent();
  stub = installBureauStub({
    'bureau.agents.catalog': () => catalogFixture(),
    'bureau.agents.definitions.get': () => agent,
    'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
    'bureau.agents.versions.list': () => ({ versions: options.versions ?? [] }),
    'bureau.agents.definitions.update': () => ({ id: agent.id, hash: 'hash-2' }),
    'bureau.agents.definitions.delete': () => ({ id: agent.id, hash: 'deleted' }),
  });
  return stub;
}

/** The sample agent with `changes` applied to its definition. */
function agentWith(
  changes: Partial<NonNullable<AgentDetail['definition']>>,
  detail: Partial<AgentDetail> = {},
): AgentDetail {
  const base = readyAgent();
  if (base.definition === null) throw new Error('expected a definition');
  return { ...base, ...detail, definition: { ...base.definition, ...changes } };
}

function mountEditor(id = 'researcher') {
  return render(Harness, { props: { id } } as never);
}

async function type(element: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(element, { target: { value } });
}

/** The definition the first update wrote. */
function updatedDefinition(installed: BureauStub): Record<string, unknown> {
  const [call] = installed.callsTo('bureau.agents.definitions.update');
  if (call === undefined) throw new Error('nothing was updated');
  return (call.params as { definition: Record<string, unknown> }).definition;
}

describe('the heading and the file line (rows 41q, 41r)', () => {
  test('says what a change makes, and that running chats keep their version', async () => {
    bureau();
    const { findByRole, getByTestId } = mountEditor();

    expect(await findByRole('heading', { level: 1, name: 'Edit Researcher' })).not.toBeNull();
    expect(getByTestId('agent-edit-subtitle').textContent?.trim()).toBe(editCopy.subtitle);
  });

  test('names the agent in the top bar’s trail: Agents, Researcher, Edit', async () => {
    bureau();
    const { findByRole } = mountEditor();
    await findByRole('heading', { level: 1, name: 'Edit Researcher' });

    await waitFor(() =>
      expect(breadcrumbTrail('/agents/researcher/edit').map((item) => item.label)).toEqual([
        'Agents',
        'Researcher',
        'Edit',
      ]),
    );
  });

  test('gives the file’s path relative to the home, the full path on hover, and a copy button', async () => {
    bureau();
    const { findByTestId, findByRole, getByRole } = mountEditor();
    const path = await findByTestId('agent-file-path');

    expect(path.textContent).toBe('agents/researcher.md');
    expect(getByRole('button', { name: copy.newAgent.copyFilePath })).not.toBeNull();
    await fireEvent.focusIn(path);
    const tooltip = await findByRole('tooltip');
    expect(tooltip.textContent).toContain(`${STUB_AGENT_DIRECTORY}/researcher.md`);
  });
});

describe('what a saved agent’s form owns (rows 41s, 41u, 41v, 41w)', () => {
  test('is the name, the identifier as one line, the description and the instructions with their count', async () => {
    bureau();
    const { findByRole, getByRole, getByTestId, queryByRole } = mountEditor();

    const name = await findByRole('textbox', { name: /^Name/ });
    expect(name).toHaveValue('Researcher');
    expect(name).toBeRequired();
    // The identifier is a line of text with its label, not a field, and it does not change here.
    expect(getByTestId('agent-identifier').textContent).toContain(editCopy.idLabel);
    expect(getByTestId('agent-identifier').textContent).toContain('researcher');
    expect(queryByRole('textbox', { name: /^Identifier/ })).toBeNull();
    expect(getByRole('textbox', { name: /^Description/ })).toHaveValue('Finds and cites sources');
    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
      'You are a careful researcher.',
    );
    expect(document.body.textContent).toContain(
      `${copy.newAgent.instructionsFormat}, ${copy.newAgent.wordCount(5)}`,
    );
  });

  test('shows the model as read-only text that sends a person to the Settings tab', async () => {
    bureau();
    const { findByTestId, getByRole, queryByRole } = mountEditor();

    const model = await findByTestId('agent-saved-model-value');
    expect(model.textContent?.trim()).toBe(editCopy.model.value('Claude Sonnet 5', 'Anthropic'));
    expect(queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(queryByRole('combobox')).toBeNull();
    const note = (await findByTestId('agent-saved-model')).textContent ?? '';
    expect(note).toContain(`${editCopy.model.changeLead}${editCopy.model.settingsTab}`);
    expect(note).toContain(editCopy.model.changeTail);
    const link = getByRole('link', { name: editCopy.model.settingsTab });
    expect(link.getAttribute('href')).toBe('/agents/researcher/settings');
    await fireEvent.click(link);
    expect(router.pathname).toBe('/agents/researcher/settings');
  });

  test('leaves the tools to the Access tab: a count and a link, no table and no Asks select', async () => {
    bureau();
    const { findByTestId, getAllByRole, queryByRole, queryByTestId } = mountEditor();

    const line = await findByTestId('agent-tools-summary');
    expect(line.textContent).toContain(editCopy.tools.count(1));
    expect(line.textContent).toContain(`${editCopy.tools.changeLead}${editCopy.tools.accessTab}`);
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/agents/researcher/access');
    expect(queryByTestId('agent-tools-table')).toBeNull();
    expect(queryByRole('button', { name: copy.addToolsAction })).toBeNull();
    // The Access tab's links are the only links the form's lines hold, besides the Settings tab's.
    expect(getAllByRole('link').map((link) => link.getAttribute('href'))).toContain(
      '/agents/researcher/access',
    );
  });

  test('says the guardrails and the spend limit in one line, and where they are changed', async () => {
    bureau({
      agent: agentWith({
        guardrails: ['acme:pii', { id: 'acme:refund-cap', configuration: { cap: 50 } }],
        limits: { steps: 12, cost: { run: 1.5 }, tools: null },
      }),
    });
    const { findByTestId, queryByRole } = mountEditor();

    const line = await findByTestId('agent-guardrails-summary');
    expect(line.textContent).toContain(
      editCopy.guardrails.summary(['acme:pii', 'acme:refund-cap'], '$1.5 per run'),
    );
    expect(line.textContent).toContain(editCopy.guardrails.changeTail);
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/agents/researcher/access');
    // None of the limit fields is on the form.
    expect(queryByRole('textbox', { name: /^Steps per run/ })).toBeNull();
    expect(queryByRole('textbox', { name: /^Guardrails/ })).toBeNull();
    expect(queryByRole('textbox', { name: /^Spend per run/ })).toBeNull();
  });

  test('says no guardrails and no spend limit when the file sets none', async () => {
    bureau();
    const { findByTestId } = mountEditor();
    expect((await findByTestId('agent-guardrails-summary')).textContent).toContain(
      editCopy.guardrails.summary([], null),
    );
  });

  test('says a model that is not offered now, and what a save does with it', async () => {
    bureau({ agent: agentWith({ model: 'anthropic/gone' }) });
    const { findByTestId } = mountEditor();

    const notice = await findByTestId('agent-model-notice');
    expect(notice.textContent).toContain(
      editCopy.model.replacementNotice('anthropic/gone', copy.model.reasons['not-in-catalog']),
    );
  });
});

describe('a save of a saved agent', () => {
  test('carries the model, tools, approvals, guardrails, limits and effort through unchanged', async () => {
    const detail = agentWith({
      model: 'anthropic/sonnet',
      effort: 'high',
      tools: ['lookup-order'],
      approvals: { 'lookup-order': 'always' },
      guardrails: ['acme:pii', { id: 'acme:refund-cap', configuration: { cap: 50 } }],
      limits: {
        steps: 12,
        cost: { run: 1.5, chat: 4, warn: [0.5] },
        tools: { calls: 30, seconds: 90 },
      },
    });
    const calls = bureau({ agent: detail });
    const { findByRole, getByRole } = mountEditor();
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    expect(updatedDefinition(calls)).toMatchObject({
      model: 'anthropic/sonnet',
      effort: 'high',
      tools: ['lookup-order'],
      approvals: { 'lookup-order': 'always' },
      guardrails: ['acme:pii', { id: 'acme:refund-cap', configuration: { cap: 50 } }],
      limits: {
        steps: 12,
        cost: { run: 1.5, chat: 4, warn: [0.5] },
        tools: { calls: 30, seconds: 90 },
      },
      instructions: 'Changed.',
    });
  });

  test('is sent even when the file’s effort is not one its model lists: the Bureau judges it, and says why', async () => {
    const calls = bureau({
      agent: agentWith({ model: 'anthropic/claude-haiku-5', effort: 'high' }),
    });
    calls.on('bureau.agents.definitions.update', () => {
      throw faults.unprocessable('claude-haiku-5 does not support high effort.');
    });
    const { findByRole, getByRole } = mountEditor();
    await findByRole('textbox', { name: /^Instructions/ });
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.update')).toHaveLength(1));
    expect(await findByRole('alert')).not.toBeNull();
  });

  test('says an emptied name at the field, focuses it, and sends nothing', async () => {
    const calls = bureau();
    const { findByRole, getByRole, findByText } = mountEditor();
    const name = await findByRole('textbox', { name: /^Name/ });
    await type(name, '  ');

    await fireEvent.click(getByRole('button', { name: copy.saveAction }));
    expect(await findByText(editCopy.nameRequired)).not.toBeNull();
    expect(name).toBeInvalid();
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
  });
});

describe('the reference documents (row 41t)', () => {
  const documents = ['references/refund-policy.md', 'references/shipping-zones.pdf'];
  const withDocuments = (): AgentDetail =>
    agentWith(
      { references: documents },
      {
        referenceSizes: [
          { path: documents[0] ?? '', size: 4096 },
          { path: documents[1] ?? '', size: 215_040 },
        ],
      },
    );

  test('lists each document with its size and a remove button', async () => {
    bureau({ agent: withDocuments() });
    const { findByTestId, getByRole } = mountEditor();

    const list = await findByTestId('agent-references');
    const rows = Array.from(list.querySelectorAll('li')).map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('references/refund-policy.md');
    expect(rows[0]).toContain('4 KB');
    expect(rows[1]).toContain('210 KB');
    expect(
      getByRole('button', { name: editCopy.references.removeLabel(documents[1] ?? '') }),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(editCopy.references.note);
  });

  test('says there are none as one muted line, not an empty state', async () => {
    bureau();
    const { findByTestId, container } = mountEditor();

    expect((await findByTestId('agent-no-references')).textContent?.trim()).toBe(
      editCopy.references.none,
    );
    expect(container.querySelector('[data-cinder-kind="first-use"]')).toBeNull();
  });

  test('leaves the documents to the file when none is removed', async () => {
    const calls = bureau({ agent: withDocuments() });
    const { findByRole, getByRole } = mountEditor();
    await type(await findByRole('textbox', { name: /^Instructions/ }), 'Changed.');
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    expect('references' in updatedDefinition(calls)).toBe(false);
  });

  test('takes a removed document off the list with the next save, and nothing is written before it', async () => {
    const calls = bureau({ agent: withDocuments() });
    const { findByRole, getByRole, queryByText } = mountEditor();
    await fireEvent.click(
      await findByRole('button', { name: editCopy.references.removeLabel(documents[0] ?? '') }),
    );

    expect(queryByText(documents[0] ?? '')).toBeNull();
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    expect(updatedDefinition(calls)['references']).toEqual([documents[1]]);
  });

  test('sends null once every document is removed, and says there are none', async () => {
    const calls = bureau({ agent: withDocuments() });
    const view = mountEditor();
    for (const path of documents) {
      await fireEvent.click(
        await view.findByRole('button', { name: editCopy.references.removeLabel(path) }),
      );
    }

    expect(view.getByTestId('agent-no-references').textContent?.trim()).toBe(
      editCopy.references.none,
    );
    await fireEvent.click(view.getByRole('button', { name: copy.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
    expect(updatedDefinition(calls)['references']).toBeNull();
  });

  test('counts a removed document as a change when leaving, by the section’s name', async () => {
    bureau({ agent: withDocuments() });
    const { findByRole, getByRole } = mountEditor();
    await fireEvent.click(
      await findByRole('button', { name: editCopy.references.removeLabel(documents[0] ?? '') }),
    );

    await fireEvent.click(getByRole('button', { name: copy.cancelAction }));
    const dialog = await findByRole('dialog', { name: copy.newAgent.leave.title });
    expect(dialog.textContent).toContain(editCopy.references.heading);
    await fireEvent.click(within(dialog).getByRole('button', { name: copy.newAgent.leave.keep }));
    expect(getByRole('form', { name: copy.formLabel })).not.toBeNull();
  });
});

describe('the delete block (row 41x)', () => {
  test('is a demoted block at the foot of the form, not in the sticky bar, and asks before it deletes', async () => {
    const calls = bureau();
    const { findByRole, container } = mountEditor();
    const button = await findByRole('button', { name: copy.deleteAction });

    const block = button.closest('section');
    expect(block?.textContent).toContain(editCopy.deleteBlock.title);
    expect(block?.textContent).toContain(editCopy.deleteBlock.description('Researcher'));
    // Cancel and Save are the bar's only buttons.
    expect(container.querySelector('.weft-agent-form__footer')?.contains(button)).toBe(false);
    await fireEvent.click(button);
    await findByRole('dialog', { name: copy.deleteDialog.title });
    expect(calls.callsTo('bureau.agents.definitions.delete')).toEqual([]);
  });
});

describe('the sticky bar (row 41y)', () => {
  test('says which version the agent is at, with a check, then Cancel and Save', async () => {
    bureau({ versions: [versionFixture(4), versionFixture(3)] });
    const { findByRole, getByTestId, getByRole } = mountEditor();
    await findByRole('textbox', { name: /^Name/ });

    await waitFor(() =>
      expect(getByTestId('agent-save-status').textContent?.trim()).toBe(editCopy.saved(4)),
    );
    expect(getByTestId('agent-save-status').querySelector('svg')).not.toBeNull();
    const form = getByRole('form', { name: copy.formLabel });
    const bar = form.querySelector('.weft-agent-form__footer') as HTMLElement;
    const labels = within(bar)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());
    expect(labels).toEqual([copy.cancelAction, copy.saveAction]);
  });
});

describe('a save in flight (row 43k)', () => {
  test('keeps the form read-only until the server answers, and names the version the save makes', async () => {
    const calls = bureau({ versions: [versionFixture(4)] });
    let answer: (value: unknown) => void = () => undefined;
    calls.on(
      'bureau.agents.definitions.update',
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ id: 'researcher', hash: 'hash-2' });
        }),
    );
    const { findByRole, getByRole, getByTestId } = mountEditor();
    const name = await findByRole('textbox', { name: /^Name/ });
    await waitFor(() =>
      expect(getByTestId('agent-save-status').textContent?.trim()).toBe(editCopy.saved(4)),
    );
    expect(getByTestId('agent-edit-subtitle').textContent?.trim()).toBe(editCopy.subtitle);

    await fireEvent.click(getByRole('button', { name: copy.saveAction }));
    await waitFor(() =>
      expect(getByTestId('agent-save-status').textContent?.trim()).toBe(copy.newAgent.saving),
    );
    expect(getByTestId('agent-edit-subtitle').textContent?.trim()).toBe(editCopy.subtitleSaving(5));
    expect(name).toHaveAttribute('readonly');
    expect(getByRole('textbox', { name: /^Description/ })).toHaveAttribute('readonly');
    expect(getByRole('textbox', { name: /^Instructions/ })).toHaveAttribute('readonly');
    expect(getByRole('button', { name: copy.cancelAction })).not.toBeDisabled();
    expect(router.pathname).toBe('/');

    answer(undefined);
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
  });
});

describe('the agent loading (rows 43h, 43i)', () => {
  test('keeps the heading, reads "Loading agent" in the sticky summary, and holds Save inert while Cancel stays live', async () => {
    const calls = bureau();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    calls.on('bureau.agents.definitions.get', async () => {
      await held;
      return readyAgent();
    });
    const { findByRole, findByTestId, getByRole, getByTestId, queryByRole } = mountEditor();

    try {
      const loading = await findByTestId('agent-loading');
      expect(getByRole('heading', { level: 1 }).textContent?.trim()).toBe('Edit researcher');
      expect(getByTestId('agent-save-status').textContent?.trim()).toBe(editCopy.loading);
      // The form is not there to submit, and the inert Save does nothing when pressed.
      expect(queryByRole('form')).toBeNull();
      const save = within(loading).getByRole('button', { name: copy.saveAction });
      expect(save).toHaveAttribute('aria-disabled', 'true');
      await fireEvent.click(save);
      expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
      expect(within(loading).getByRole('button', { name: copy.cancelAction })).not.toBeDisabled();
    } finally {
      // A failed assertion must not leave the agent held, or the test never ends.
      release();
    }
    expect(await findByRole('form', { name: copy.formLabel })).not.toBeNull();
    await waitFor(() =>
      expect(document.querySelector('[data-testid="agent-loading"]')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('leaves for the agent’s page on Cancel', async () => {
    const calls = bureau();
    const held = new Promise<void>(() => undefined);
    calls.on('bureau.agents.definitions.get', async () => {
      await held;
      return readyAgent();
    });
    const { findByTestId, getByRole } = mountEditor();
    await findByTestId('agent-loading');

    await fireEvent.click(getByRole('button', { name: copy.cancelAction }));
    expect(router.pathname).toBe('/agents/researcher');
  });
});
