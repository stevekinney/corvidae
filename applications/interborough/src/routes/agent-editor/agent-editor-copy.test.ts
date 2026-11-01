/**
 * Duplicate (`/agents/new?from=<agent>`): the form for a new agent, filled from an agent that
 * exists. A built-in agent is copied from its `codeDefinition`, a file agent whole, so approvals and
 * budgets come along. The copy is named and created like any new agent, and a taken identifier is
 * refused the way it always is.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import type { AgentDetail } from '../../lib/agent-definitions.ts';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { copyIdentifierOf, copySeedOf } from './agent-copy.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

const copy = AGENT_EDITOR_COPY;

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

/** A built-in agent, as `bureau.agents.definitions.get` shows one. */
function builtIn(codeDefinition: Partial<NonNullable<AgentDetail['codeDefinition']>> = {}) {
  return readyAgent({
    id: 'assistant',
    source: 'code',
    name: 'Assistant',
    hash: null,
    definition: null,
    codeDefinition: {
      name: 'Assistant',
      description: 'Helps with things',
      model: 'anthropic/claude-haiku-5',
      models: [],
      tools: ['lookup-order'],
      skills: ['summarize'],
      skillDescriptors: [],
      instructions: 'Help the person.',
      ...codeDefinition,
    },
  });
}

function bureau(
  source: AgentDetail | (() => never),
  catalog = catalogFixture(),
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {},
): BureauStub {
  stub = installBureauStub({
    'bureau.agents.catalog': () => catalog,
    'bureau.agents.definitions.get': typeof source === 'function' ? source : () => source,
    'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
    'bureau.agents.versions.list': () => ({ versions: [] }),
    'bureau.agents.definitions.create': (params) => ({ id: String(params['id']), hash: 'created' }),
    ...handlers,
  });
  return stub;
}

function copyOf(id: string) {
  router.navigate(`/agents/new?from=${encodeURIComponent(id)}`, { replace: true });
  return render(Harness, { props: {} } as never);
}

async function type(element: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(element, { target: { value } });
}

describe('the seed of a copy', () => {
  test('is a built-in agent’s own statement of itself, as a definition that opts out of A2A', () => {
    const seed = copySeedOf(builtIn({ models: ['anthropic/claude-haiku-5'] }));
    expect(seed).toEqual({
      name: 'Assistant copy',
      description: 'Helps with things',
      model: 'anthropic/claude-haiku-5',
      models: ['anthropic/claude-haiku-5'],
      tools: ['lookup-order'],
      skillDescriptors: [],
      a2a: false,
      stepLimit: null,
      retry: null,
      compaction: null,
      hooks: null,
      references: null,
      guardrails: null,
      costBudget: null,
      toolBudget: null,
      toolApproval: null,
      instructions: 'Help the person.',
    });
  });

  test('has no model for a scripted agent, no instructions for one that states none, and no model list', () => {
    const seed = copySeedOf(builtIn({ model: null, instructions: null }));
    expect(seed).toMatchObject({ model: '', instructions: '', models: null });
  });

  test('starts a scripted agent that allows some models on the first of them, so the model list holds it', () => {
    const seed = copySeedOf(builtIn({ model: null, models: ['anthropic/claude-haiku-5'] }));
    expect(seed).toMatchObject({
      model: 'anthropic/claude-haiku-5',
      models: ['anthropic/claude-haiku-5'],
    });
  });

  test('is a file agent whole, with its references but without its A2A opt-in', () => {
    const file = readyAgent();
    const seed = copySeedOf({
      ...file,
      definition:
        file.definition === null
          ? null
          : { ...file.definition, a2a: true, references: ['notes.md'] },
    });
    expect(seed).toMatchObject({
      name: 'Researcher copy',
      a2a: false,
      references: ['notes.md'],
    });
    expect(seed?.skillDescriptors).toEqual(file.definition?.skillDescriptors ?? []);
  });

  test('is nothing for an agent with no definition', () => {
    expect(copySeedOf(readyAgent({ state: 'invalid', definition: null }))).toBeNull();
    expect(copySeedOf({ ...builtIn(), codeDefinition: null })).toBeNull();
  });

  test('starts the identifier as <id>-copy, cut to fit, a plugin’s agent under its own name', () => {
    expect(copyIdentifierOf('assistant')).toBe('assistant-copy');
    expect(copyIdentifierOf('demo:assistant')).toBe('assistant-copy');
    const long = 'a'.repeat(64);
    expect(copyIdentifierOf(long)).toBe(`${'a'.repeat(59)}-copy`);
    expect(copyIdentifierOf(`${'a'.repeat(58)}-bbbb`)).toBe(`${'a'.repeat(58)}-copy`);
    expect(copyIdentifierOf('')).toBe('');
  });
});

describe('Duplicate, on the new agent page', () => {
  test('fills the form from a built-in agent, names the copy, and creates a file agent', async () => {
    const calls = bureau(builtIn());
    const { findByRole, getByRole, getByTestId } = copyOf('assistant');

    const name = await findByRole('textbox', { name: /^Name/ });
    expect((name as HTMLInputElement).value).toBe('Assistant copy');
    expect((getByRole('textbox', { name: /^Identifier/ }) as HTMLInputElement).value).toBe(
      'assistant-copy',
    );
    expect((getByRole('textbox', { name: /^Instructions/ }) as HTMLTextAreaElement).value).toBe(
      'Help the person.',
    );
    expect(getByTestId('agent-copied-from').textContent).toContain('Assistant');
    // Nothing exists yet: the source was read, and no write was made.
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([]);

    await fireEvent.click(getByRole('button', { name: copy.createAction }));

    await waitFor(() => expect(router.pathname).toBe('/agents/assistant-copy'));
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([
      {
        method: 'bureau.agents.definitions.create',
        params: {
          id: 'assistant-copy',
          definition: {
            name: 'Assistant copy',
            description: 'Helps with things',
            model: 'anthropic/claude-haiku-5',
            tools: ['lookup-order'],
            skillDescriptors: [],
            a2a: false,
            guardrails: null,
            stepLimit: null,
            costBudget: null,
            toolBudget: null,
            instructions: 'Help the person.',
          },
        },
      },
    ]);
  });

  test('lets the person rename the copy before it is created', async () => {
    const calls = bureau(builtIn());
    const { findByRole, getByRole } = copyOf('assistant');
    const identifier = (await findByRole('textbox', { name: /^Identifier/ })) as HTMLInputElement;
    await type(identifier, 'my-assistant');
    await fireEvent.click(getByRole('button', { name: copy.createAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/my-assistant'));
    expect(calls.callsTo('bureau.agents.definitions.create')[0]?.params['id']).toBe('my-assistant');
  });

  test('keeps a file agent’s tool approvals, budgets, limits and model list, and drops its A2A opt-in', async () => {
    const file = readyAgent();
    const definition = file.definition;
    if (definition === null) throw new Error('expected a definition');
    const calls = bureau({
      ...file,
      definition: {
        ...definition,
        models: ['anthropic/sonnet', 'anthropic/claude-haiku-5'],
        a2a: true,
        stepLimit: 12,
        retry: { attempts: 3, delayMilliseconds: 200, jitter: true },
        compaction: { enabled: true, thresholdPercent: 80 },
        hooks: ['acme:audit'],
        guardrails: ['acme:pii'],
        costBudget: { perRunUsd: 1.5, perChatUsd: 4, warnAt: [0.5, 0.9] },
        toolBudget: { maxCalls: 10, maxDurationSeconds: 30 },
        toolApproval: { 'lookup-order': 'always' },
      },
    });
    const { findByRole, getByRole } = copyOf('researcher');
    await findByRole('textbox', { name: /^Name/ });
    await fireEvent.click(getByRole('button', { name: copy.createAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher-copy'));
    const sent = calls.callsTo('bureau.agents.definitions.create')[0]?.params['definition'];
    expect(sent).toMatchObject({
      name: 'Researcher copy',
      model: 'anthropic/sonnet',
      models: ['anthropic/sonnet', 'anthropic/claude-haiku-5'],
      a2a: false,
      stepLimit: 12,
      retry: { attempts: 3, delayMilliseconds: 200, jitter: true },
      compaction: { enabled: true, thresholdPercent: 80 },
      hooks: ['acme:audit'],
      guardrails: ['acme:pii'],
      costBudget: { perRunUsd: 1.5, perChatUsd: 4, warnAt: [0.5, 0.9] },
      toolBudget: { maxCalls: 10, maxDurationSeconds: 30 },
      toolApproval: { 'lookup-order': 'always' },
    });
  });

  test('creates the copy with the original’s references, which sit in the directory it lands in', async () => {
    const file = readyAgent();
    const definition = file.definition;
    if (definition === null) throw new Error('expected a definition');
    const calls = bureau({
      ...file,
      definition: { ...definition, references: ['notes.md', 'style/guide.md'] },
    });
    const { findByRole, getByRole } = copyOf('researcher');
    await findByRole('textbox', { name: /^Name/ });
    await fireEvent.click(getByRole('button', { name: copy.createAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher-copy'));
    expect(
      calls.callsTo('bureau.agents.definitions.create')[0]?.params['definition'],
    ).toMatchObject({ references: ['notes.md', 'style/guide.md'] });
  });

  test('sends no references for a copy of an agent that has none', async () => {
    const calls = bureau(readyAgent());
    const { findByRole, getByRole } = copyOf('researcher');
    await findByRole('textbox', { name: /^Name/ });
    await fireEvent.click(getByRole('button', { name: copy.createAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher-copy'));
    expect(
      calls.callsTo('bureau.agents.definitions.create')[0]?.params['definition'],
    ).not.toHaveProperty('references');
  });

  test('shows the Bureau’s refusal when a plugin agent’s references are out of reach', async () => {
    const file = readyAgent({ id: 'demo:researcher' });
    const definition = file.definition;
    if (definition === null) throw new Error('expected a definition');
    const refusal =
      '"demo:researcher" names reference documents that sit beside the plugin’s files, so it cannot be duplicated.';
    const calls = bureau(
      { ...file, definition: { ...definition, references: ['notes.md'] } },
      catalogFixture(),
      {
        'bureau.agents.definitions.create': () => {
          throw faults.unprocessable(refusal);
        },
      },
    );
    const { findByRole, getByRole, findByText } = copyOf('demo:researcher');
    await findByRole('textbox', { name: /^Name/ });
    await fireEvent.click(getByRole('button', { name: copy.createAction }));
    await findByText(refusal);
    expect(router.pathname).toBe('/agents/new');
    expect(
      calls.callsTo('bureau.agents.definitions.create')[0]?.params['definition'],
    ).toMatchObject({ references: ['notes.md'] });
  });

  test('refuses an identifier that is taken, and writes nothing more', async () => {
    const calls = bureau(builtIn(), catalogFixture(), {
      'bureau.agents.definitions.create': () => {
        throw faults.taken('agent-file-exists');
      },
    });
    const { findByRole, getByRole, findByText } = copyOf('assistant');
    await findByRole('textbox', { name: /^Name/ });
    await fireEvent.click(getByRole('button', { name: copy.createAction }));
    await findByText(copy.identifierTaken['agent-file-exists']);
    expect(router.pathname).toBe('/agents/new');
    expect(calls.callsTo('bureau.agents.definitions.create')).toHaveLength(1);
    // The form is kept, and a new identifier is tried the way a new agent's is.
    const identifier = getByRole('textbox', { name: /^Identifier/ }) as HTMLInputElement;
    expect(identifier.value).toBe('assistant-copy');
  });

  test('starts a scripted agent’s copy on the first model offered, and says which tools it leaves out', async () => {
    const calls = bureau(
      builtIn({ model: null, tools: ['lookup-order', 'ghost-tool', 'other-ghost'] }),
    );
    const { findByRole, getByRole, getByTestId } = copyOf('assistant');
    await findByRole('textbox', { name: /^Name/ });
    expect(getByTestId('agent-copy-dropped').textContent).toBe(
      copy.copy.droppedTools(['ghost-tool', 'other-ghost']),
    );
    await fireEvent.click(getByRole('button', { name: copy.createAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/assistant-copy'));
    expect(
      calls.callsTo('bureau.agents.definitions.create')[0]?.params['definition'],
    ).toMatchObject({ model: 'anthropic/claude-sonnet-5', tools: ['lookup-order'] });
  });

  test('says so when the agent to copy cannot be read, and offers to try again', async () => {
    const calls = bureau(() => {
      throw faults.notFound('assistant');
    });
    const { findByText, getByRole } = copyOf('assistant');
    await findByText(copy.copy.sourceFailed.title);
    expect(() => getByRole('button', { name: copy.createAction })).toThrow();
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.callsTo('bureau.agents.definitions.get')).toHaveLength(2));
  });

  test('says so when the agent is a file with nothing to copy', async () => {
    bureau(readyAgent({ state: 'invalid', definition: null }));
    const { findByText } = copyOf('researcher');
    await findByText(copy.copy.sourceFailed.title);
  });

  test('goes back to the agent it was copied from on Cancel', async () => {
    bureau(builtIn());
    const { findByRole, getByRole } = copyOf('assistant');
    await findByRole('textbox', { name: /^Name/ });
    await fireEvent.click(getByRole('button', { name: copy.cancelAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/assistant'));
  });
});
