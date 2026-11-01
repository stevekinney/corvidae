import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { RETRY_LABEL } from '../../app/copy.ts';
import { readyAgent, StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import { HOOKS_COPY } from '../hooks/hook-copy.ts';
import { chatListRequest, DEFAULT_CHAT_FILTERS } from './agent-chat-filters.ts';
import AgentDetail from './agent-detail.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: AgentDetail } } as never);

const FILE_AGENT = {
  ...AGENT,
  name: 'researcher',
  displayName: 'Researcher',
  kind: 'file',
  description: 'Finds sources.',
};

type Answers = Parameters<typeof bureau>[0];

function serve(extra: Answers = {}, definition = readyAgent({ id: 'researcher' })) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
    'bureau.agents.definitions.get': () => definition,
    'bureau.contexts.list': () => ({
      contexts: [{ ...CONTEXT, agentName: 'researcher' }],
      nextOffset: null,
    }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    ...extra,
  });
  restore = served.restore;
  return served;
}

const lastListed = (served: ReturnType<typeof serve>) =>
  served.calls.filter((call) => call.method === 'bureau.contexts.list').at(-1)?.params;

describe('the request the Chats tab makes', () => {
  test('sends no filter for the defaults and names the order', () => {
    expect(chatListRequest(DEFAULT_CHAT_FILTERS)).toEqual({
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });
  });

  test('sends each filter that is set so the Bureau applies it before it cuts a page', () => {
    expect(
      chatListRequest({
        state: 'needs-you',
        startedBy: 'schedule',
        title: 'refund',
        sort: 'oldest',
      }),
    ).toEqual({
      origin: 'schedule',
      activity: 'awaiting-input',
      titleContains: 'refund',
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });
    expect(chatListRequest({ ...DEFAULT_CHAT_FILTERS, state: 'running' }).activity).toBe('running');
    expect(chatListRequest({ ...DEFAULT_CHAT_FILTERS, sort: 'newest' })).toMatchObject({
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });
});

describe('the Chats tab', () => {
  test('asks for the state a person picks and reads the first page again', async () => {
    landAt('/agents/researcher');
    const served = serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('radio', { name: 'Needs you' }));

    await waitFor(() =>
      expect(lastListed(served)).toMatchObject({ activity: 'awaiting-input', offset: 0 }),
    );
  });

  test('asks for a title when the search is submitted', async () => {
    landAt('/agents/researcher');
    const served = serve();
    const { findByRole } = mount();

    const search = await findByRole('searchbox', { name: 'Search chats by title' });
    await fireEvent.input(search, { target: { value: 'refund' } });
    // Enter in the field submits the form around it.
    const form = search.closest('form');
    if (form === null) throw new Error('expected the search to be a form');
    await fireEvent.submit(form);

    await waitFor(() => expect(lastListed(served)).toMatchObject({ titleContains: 'refund' }));
  });

  test('says a filter matched nothing with the filtered kind and clears it', async () => {
    landAt('/agents/researcher');
    const served = serve({
      'bureau.contexts.list': (params) =>
        params['activity'] === undefined
          ? { contexts: [{ ...CONTEXT, agentName: 'researcher' }], nextOffset: null }
          : { contexts: [], nextOffset: null },
    });
    const { container, findByRole, findByText } = mount();
    await findByText('Plan the week');

    await fireEvent.click(await findByRole('radio', { name: 'Running' }));

    await findByText('No chats match');
    expect(container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();
    // No inline status line stands in for the empty state.
    expect(container.querySelector('[role="status"]')).toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Clear filters' }));
    await findByText('Plan the week');
    expect(lastListed(served)?.['activity']).toBeUndefined();
  });

  test('marks a chat that is running or waiting on a person, in the order the Bureau cut them', async () => {
    landAt('/agents/researcher');
    serve({
      'bureau.contexts.list': () => ({
        contexts: [
          {
            ...CONTEXT,
            id: 'a',
            title: 'Waiting chat',
            agentName: 'researcher',
            activity: 'awaiting-input',
          },
          {
            ...CONTEXT,
            id: 'b',
            title: 'Running chat',
            agentName: 'researcher',
            activity: 'running',
          },
          { ...CONTEXT, id: 'c', title: 'Quiet chat', agentName: 'researcher', activity: 'idle' },
        ],
        nextOffset: null,
      }),
    });
    const { container, findByText } = mount();

    await findByText('Waiting chat');

    const rows = [...container.querySelectorAll('.ib-agent-chat')];
    expect(rows.map((row) => row.querySelector('.ib-agent-chat__title')?.textContent)).toEqual([
      'Waiting chat',
      'Running chat',
      'Quiet chat',
    ]);
    expect(rows[0]?.textContent).toContain('Needs you');
    expect(rows[1]?.textContent).toContain('Running');
    expect(rows[2]?.textContent).not.toContain('Running');
  });

  test('says an agent with no chats has none, with New chat as the action', async () => {
    landAt('/agents/researcher');
    serve({ 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) });
    const { container, findByText } = mount();

    await findByText('No chats with this agent yet');

    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    const action = container.querySelector('[data-cinder-kind="first-use"] a');
    expect(action?.textContent).toContain('New chat');
  });
});

describe('the Instructions tab', () => {
  test('renders the file’s body as a document and lists its reference documents', async () => {
    landAt('/agents/researcher?tab=instructions');
    const definition = readyAgent({ id: 'researcher' });
    if (definition.definition === null) throw new Error('expected a definition');
    serve(
      {},
      {
        ...definition,
        definition: {
          ...definition.definition,
          instructions: '# Be careful\n\nCite **every** source.',
          references: ['references/style.md', 'references/glossary.md'],
        },
      },
    );
    const { container, findByTestId, findAllByRole } = mount();

    const body = await findByTestId('agent-instructions-body');

    expect(body.querySelector('strong')?.textContent).toBe('every');
    expect(body.querySelector('h1, h2')?.textContent).toBe('Be careful');
    const references = await findByTestId('agent-references');
    expect([...references.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'references/style.md',
      'references/glossary.md',
    ]);
    const edits = await findAllByRole('link', { name: 'Edit' });
    expect(edits.map((edit) => edit.getAttribute('href'))).toEqual([
      '/agents/researcher/edit',
      '/agents/researcher/edit',
    ]);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('says an agent with no reference documents reads none', async () => {
    landAt('/agents/researcher?tab=instructions');
    serve();
    const { container, findByText } = mount();

    await findByText('No reference documents');

    expect(container.querySelectorAll('[data-cinder-kind="first-use"]').length).toBeGreaterThan(0);
  });

  test('says an agent defined in code cannot be edited, and offers no Edit', async () => {
    landAt('/agents/assistant?tab=instructions');
    const served = bureau({
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.get': () => ({
        ...readyAgent({ id: 'assistant' }),
        source: 'code',
        hash: null,
        definition: null,
        codeDefinition: {
          name: 'assistant',
          description: null,
          model: null,
          models: [],
          tools: [],
          skills: [],
          skillDescriptors: [],
          instructions: 'Answer every message.',
        },
      }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    });
    restore = served.restore;
    const { findByTestId, queryByRole } = mount();

    await findByTestId('agent-built-in');

    const body = await findByTestId('agent-instructions-body');
    expect(body.textContent).toContain('Answer every message.');
    expect(queryByRole('link', { name: 'Edit' })).toBeNull();
  });
});

describe('the Hooks tab', () => {
  const HOOK = {
    id: 'hook-1',
    owner: 'anonymous:local',
    name: null,
    action: { type: 'notify', title: null },
    events: ['review.requested'],
    scope: { kind: 'agent', id: 'researcher' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    lastDelivery: null,
  };

  test('lists the hooks the Bureau holds for this agent, and New hook starts one limited to it', async () => {
    const served = serve({ 'bureau.hooks.list': () => ({ hooks: [HOOK] }) });
    landAt('/agents/researcher?tab=hooks');
    const view = mount();

    await view.findByRole('link', {
      name: 'When Review requested for the agent researcher, notify me',
    });
    expect(served.calls.find((call) => call.method === 'bureau.hooks.list')?.params).toEqual({
      scope: { kind: 'agent', id: 'researcher' },
    });
    const newHook = view.getByRole('link', { name: HOOKS_COPY.newAction });
    expect(newHook.getAttribute('href')).toContain('/hooks/new?agent=researcher');

    // A click meant for a new tab is the browser's to follow.
    await fireEvent.click(newHook, { metaKey: true });
    expect(router.pathname).toBe('/agents/researcher');
    await fireEvent.click(newHook);
    await waitFor(() => expect(router.pathname).toBe('/hooks/new'));
    expect(router.search.get('agent')).toBe('researcher');
  });

  test('says an agent with no hooks has none, with New hook as the action', async () => {
    serve({ 'bureau.hooks.list': () => ({ hooks: [] }) });
    landAt('/agents/researcher?tab=hooks');
    const view = mount();

    await view.findByRole('heading', { name: HOOKS_COPY.agentTab.emptyTitle });
    expect(view.getByRole('link', { name: HOOKS_COPY.newAction })).not.toBeNull();
  });

  test('says a home with hooks off has none, and offers to read again when a read fails', async () => {
    serve({
      'bureau.hooks.list': () => {
        throw new StubFault('UnsupportedCapability', 501, 'This Bureau has no hooks', {
          capability: 'hooks',
        });
      },
    });
    landAt('/agents/researcher?tab=hooks');
    const off = mount();
    await off.findByRole('heading', { level: 2, name: HOOKS_COPY.unavailable.title });
    cleanup();
    restore?.();

    let failing = true;
    serve({
      'bureau.hooks.list': () => {
        if (failing) throw new StubFault('EngineFailure', 500, 'It broke.');
        return { hooks: [HOOK] };
      },
    });
    landAt('/agents/researcher?tab=hooks');
    const view = mount();
    await view.findByText(HOOKS_COPY.agentTab.loadFailed);
    failing = false;
    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));
    await view.findByRole('link', {
      name: 'When Review requested for the agent researcher, notify me',
    });
  });
});

describe('the Settings tab', () => {
  const withSettings = () => {
    const definition = readyAgent({ id: 'researcher' });
    if (definition.definition === null) throw new Error('expected a definition');
    return {
      ...definition,
      definition: {
        ...definition.definition,
        models: ['anthropic/haiku'],
        stepLimit: 12,
        guardrails: ['acme:tripwire'],
        costBudget: { perRunUsd: 1.5 },
        toolBudget: { maxCalls: 30, maxDurationSeconds: 90 },
      },
    };
  };
  // Bureau lists every key on a first version, and `[]` on a later save that changed nothing.
  const ALL_KEYS = ['name', 'model', 'instructions'];
  const version = (revision: number, hash: string, changedKeys: string[]) => ({
    revision,
    hash,
    savedAt: '2026-10-19T09:00:00.000Z',
    savedBy: revision === 1 ? null : 'anonymous:local',
    owner: 'anonymous:local',
    definition: withSettings().definition,
    referenceDigests: null,
    changedKeys,
  });

  test('shows the model, the models to switch to and the step limit, and leaves access to its own tab', async () => {
    landAt('/agents/researcher?tab=settings');
    serve({ 'bureau.agents.versions.list': () => ({ versions: [] }) }, withSettings());
    const { findByTestId, container } = mount();

    const settings = await findByTestId('agent-settings');
    await waitFor(() => expect(settings.textContent).toContain('anthropic/haiku'));

    expect(settings.textContent).toContain('12');
    for (const text of ['acme:tripwire', '$1.50', '90 seconds']) {
      expect(settings.textContent).not.toContain(text);
    }
    expect(container.querySelector('[data-testid="agent-versions"]')).not.toBeNull();
  });

  test('says the default effort a chat starts at, and Not set when the file sets none', async () => {
    landAt('/agents/researcher?tab=settings');
    const agent = withSettings();
    serve(
      { 'bureau.agents.versions.list': () => ({ versions: [] }) },
      {
        ...agent,
        definition: { ...agent.definition, defaultEffort: 'high' },
      },
    );
    const { findByTestId } = mount();
    const shown = await findByTestId('agent-default-effort');
    expect(shown.textContent).toBe('High');
    expect(shown.closest('div')?.textContent).toContain('Default effort');
  });

  test('says Not set for an agent whose file sets no default effort', async () => {
    landAt('/agents/researcher?tab=settings');
    serve({ 'bureau.agents.versions.list': () => ({ versions: [] }) }, withSettings());
    const { findByTestId } = mount();
    const shown = await findByTestId('agent-default-effort');
    expect(shown.textContent).toBe('Not set');
  });

  test('restores an older version over the hash of the file as read, and lists the result', async () => {
    landAt('/agents/researcher?tab=settings');
    let versions = [version(2, 'identity-2', ['instructions']), version(1, 'identity-1', ALL_KEYS)];
    const served = serve(
      {
        'bureau.agents.versions.list': () => ({ versions }),
        'bureau.agents.versions.restore': () => {
          versions = [version(3, 'identity-3', ['instructions']), ...versions];
          return { id: 'researcher', hash: 'hash-3', revision: 3 };
        },
      },
      withSettings(),
    );
    const { findByRole, findByText, queryByRole } = mount();

    // The newest version is the one the file holds, so only the older one offers Restore.
    await findByText('Version 2');
    expect(queryByRole('button', { name: 'Restore version 2' })).toBeNull();
    const restoreButton = await findByRole('button', { name: 'Restore version 1' });
    expect(restoreButton.hasAttribute('data-changes')).toBe(true);
    await fireEvent.click(restoreButton);

    await findByText('Version 3');
    expect(
      served.calls.find((call) => call.method === 'bureau.agents.versions.restore')?.params,
    ).toEqual({ id: 'researcher', revision: 1, expectedHash: 'hash-1' });
  });

  test('says why a restore was refused', async () => {
    landAt('/agents/researcher?tab=settings');
    serve(
      {
        'bureau.agents.versions.list': () => ({
          versions: [version(2, 'identity-2', []), version(1, 'identity-1', ALL_KEYS)],
        }),
        'bureau.agents.versions.restore': () => {
          throw new StubFault('Unprocessable', 422, 'The model is gone.');
        },
      },
      withSettings(),
    );
    const { findByRole, findByText } = mount();

    await fireEvent.click(await findByRole('button', { name: 'Restore version 1' }));

    await findByText(/./, { selector: '[role="alert"] p' });
  });

  test('names a first version and a later save that changed nothing apart', async () => {
    landAt('/agents/researcher?tab=settings');
    serve(
      {
        'bureau.agents.versions.list': () => ({
          versions: [version(2, 'identity-2', []), version(1, 'identity-1', ALL_KEYS)],
        }),
      },
      withSettings(),
    );
    const { findByText, queryByText } = mount();

    await findByText('Saved with no change to the settings');
    await findByText('First version');
    expect(queryByText(/Changed/)).toBeNull();
  });

  test('says the agent changed and refetches the versions when a restore is stale', async () => {
    landAt('/agents/researcher?tab=settings');
    let listed = 0;
    serve(
      {
        'bureau.agents.versions.list': () => {
          listed += 1;
          return { versions: [version(2, 'identity-2', []), version(1, 'identity-1', ALL_KEYS)] };
        },
        'bureau.agents.versions.restore': () => {
          throw new StubFault('StaleRevision', 409, 'stale', { currentRevision: 'hash-9' });
        },
      },
      withSettings(),
    );
    const { findByRole, findByText } = mount();

    await fireEvent.click(await findByRole('button', { name: 'Restore version 1' }));

    await findByText(/changed after the page loaded/);
    await waitFor(() => expect(listed).toBeGreaterThan(1));
  });

  test('deletes the agent over the hash of the file as read and returns to the list', async () => {
    landAt('/agents/researcher?tab=settings');
    const served = serve(
      {
        'bureau.agents.versions.list': () => ({ versions: [] }),
        'bureau.agents.definitions.delete': () => ({ id: 'researcher', hash: 'hash-1' }),
      },
      withSettings(),
    );
    const { findByRole } = mount();

    const remove = await findByRole('button', { name: 'Delete agent' });
    expect(remove.hasAttribute('data-changes')).toBe(true);
    await fireEvent.click(remove);
    await fireEvent.click(await findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(router.pathname).toBe('/agents'));
    expect(
      served.calls.find((call) => call.method === 'bureau.agents.definitions.delete')?.params,
    ).toEqual({ id: 'researcher', expectedHash: 'hash-1' });
  });
});
