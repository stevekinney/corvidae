import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { RETRY_LABEL } from '../../app/copy/views.ts';
import { readyAgent, StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import { HOOKS_COPY } from '../hooks/hook-copy.ts';
import {
  chatListRequest,
  DEFAULT_CHAT_FILTERS,
  sortOf,
  startedByOf,
  stateOf,
} from './agent-chat-filters.ts';
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
  served.calls
    .filter((call) => call.method === 'bureau.contexts.list' && 'agentName' in call.params)
    .at(-1)?.params;

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

describe('what the filter row reports', () => {
  test('reads each select as the filter it stands for, and the clearing row as no filter', () => {
    expect(startedByOf('schedule')).toBe('schedule');
    expect(startedByOf('goal')).toBe('goal');
    expect(startedByOf('')).toBe('any');
    expect(startedByOf('nonsense')).toBe('any');
    expect(sortOf('oldest')).toBe('oldest');
    expect(sortOf('newest')).toBe('newest');
    expect(sortOf('')).toBe('updated');
    expect(stateOf('running')).toBe('running');
    expect(stateOf('needs-you')).toBe('needs-you');
    expect(stateOf('nonsense')).toBe('all');
  });
});

describe('the Chats tab', () => {
  test('asks for the state a person picks and reads the first page again', async () => {
    landAt('/agents/researcher');
    const served = serve();
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('radio', { name: /^Waiting on you/ }));

    await waitFor(() =>
      expect(lastListed(served)).toMatchObject({ activity: 'awaiting-input', offset: 0 }),
    );
    // An archived chat is put away: the agent's chats leave it out (COR-2285 V5).
    expect(lastListed(served)).toMatchObject({ archived: 'exclude' });
  });

  test('asks for a title when the search is submitted', async () => {
    landAt('/agents/researcher');
    const served = serve();
    const { findByRole } = mount();

    const search = await findByRole('searchbox', { name: 'Search chats by title' });
    await fireEvent.input(search, { target: { value: 'refund' } });

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

    await fireEvent.click(await findByRole('radio', { name: /^Running/ }));

    await findByText('No chats match');
    expect(container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();
    // No inline status line stands in for the empty state (the filter bar's own live region is not one).
    const lines = [...container.querySelectorAll('[role="status"]')].filter(
      (line) => line.closest('[role="search"]') === null,
    );
    expect(lines).toHaveLength(0);
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

    const rows = [...container.querySelectorAll('[data-chat]')];
    expect(rows.map((row) => row.getAttribute('data-chat'))).toEqual(['a', 'b', 'c']);
    expect(rows[0]?.textContent).toContain('Waiting chat');
    expect(rows[1]?.textContent).toContain('Running chat');
    expect(rows[2]?.textContent).toContain('Quiet chat');
    // Each row leads with its status word, which is the Waiting on you of the chat list.
    expect(rows[0]?.textContent).toContain('Waiting on you');
    expect(rows[1]?.textContent).toContain('Running');
    expect(rows[2]?.textContent).toContain('Done');
  });

  test('says an agent with no chats has none, with New chat as the action', async () => {
    landAt('/agents/researcher');
    serve({ 'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }) });
    const { container, findByText } = mount();

    // The header says "No chats yet" from the agent's counts before the tab's own read lands, so
    // wait for the tab's empty state itself.
    await findByText('Chats with Researcher appear here, newest first.');

    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    const action = container.querySelector('[data-cinder-kind="first-use"] a');
    expect(action?.textContent).toContain('New chat');
  });
});

describe('the Instructions tab', () => {
  test('renders the file’s body as a document and lists its reference documents', async () => {
    landAt('/agents/researcher/instructions');
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
        referenceSizes: [
          { path: 'references/style.md', size: 4096 },
          { path: 'references/glossary.md', size: 1536 },
        ],
      },
    );
    const { container, findByTestId, findAllByRole } = mount();

    const body = await findByTestId('agent-instructions-body');

    expect(body.querySelector('strong')?.textContent).toBe('every');
    expect(body.querySelector('h1, h2')?.textContent).toBe('Be careful');
    // The instructions keep Cinder's Markdown rhythm, so paragraphs do not run together.
    expect(body.classList).toContain('cinder-markdown-content');
    const references = await findByTestId('agent-references');
    expect(
      [...references.querySelectorAll('li')].map((item) => item.querySelector('code')?.textContent),
    ).toEqual(['references/style.md', 'references/glossary.md']);
    // Each document says its size, a whole number of units without its decimal.
    const items = [...references.querySelectorAll('li')];
    expect(items[0]?.textContent).toContain('4 KB');
    expect(items[0]?.textContent).not.toContain('4.0');
    expect(items[1]?.textContent).toContain('1.5 KB');
    // The documents are changed in the editor, which the note's link opens.
    const note = await findByTestId('agent-references-note');
    expect(note.textContent).toContain(
      'Documents are added and removed in the editor, so each change becomes a version.',
    );
    expect(within(note).getByRole('link', { name: 'Edit agent' }).getAttribute('href')).toBe(
      '/agents/researcher/edit',
    );
    // The header holds the one Edit; the tab does not repeat it (sweep S51).
    const edits = await findAllByRole('link', { name: 'Edit' });
    expect(edits.map((edit) => edit.getAttribute('href'))).toEqual(['/agents/researcher/edit']);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('says an agent with no reference documents reads none', async () => {
    landAt('/agents/researcher/instructions');
    serve();
    const { container, findByTestId } = mount();

    const line = await findByTestId('agent-no-references');

    // One muted line, not an empty state, with the editor as its one link (row 39r).
    expect(line.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      'None added. Add one in the editor.',
    );
    expect(within(line).getAllByRole('link')).toHaveLength(1);
    expect(within(line).getByRole('link', { name: 'the editor' }).getAttribute('href')).toBe(
      '/agents/researcher/edit',
    );
    expect(container.querySelector('[data-cinder-kind="first-use"]')).toBeNull();
    expect(container.textContent).not.toContain('No reference documents');
  });

  test('says which version of the file it shows and who saved it', async () => {
    landAt('/agents/researcher/instructions');
    const definition = readyAgent({ id: 'researcher' });
    serve(
      {
        'bureau.agents.versions.list': () => ({
          versions: [
            {
              revision: 4,
              hash: 'identity-4',
              savedAt: '2026-10-29T15:00:00.000Z',
              savedBy: 'anonymous:local',
              definition: definition.definition,
              changedKeys: ['instructions'],
            },
          ],
        }),
      },
      definition,
    );
    const { findByTestId } = mount();

    const line = await findByTestId('agent-version');

    expect(line.textContent).toMatch(/^Version 4, saved Oct \d+ by you$/);
  });

  test('says an agent defined in code cannot be edited, and offers no Edit', async () => {
    landAt('/agents/assistant/instructions');
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
          card: [],
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
    landAt('/agents/researcher/hooks');
    const view = mount();

    await view.findByRole('link', {
      name: 'When a review is waiting, notify me',
    });
    expect(served.calls.find((call) => call.method === 'bureau.hooks.list')?.params).toEqual({
      scope: { kind: 'agent', id: 'researcher' },
    });
    const newHook = view.getByRole('link', { name: HOOKS_COPY.newAction });
    expect(newHook.getAttribute('href')).toContain('/hooks/new?agent=researcher');

    // A click meant for a new tab is the browser's to follow.
    await fireEvent.click(newHook, { metaKey: true });
    expect(router.pathname).toBe('/agents/researcher/hooks');
    await fireEvent.click(newHook);
    await waitFor(() => expect(router.pathname).toBe('/hooks/new'));
    expect(router.search.get('agent')).toBe('researcher');
  });

  test('says an agent with no hooks has none, with New hook as the action', async () => {
    serve({ 'bureau.hooks.list': () => ({ hooks: [] }) });
    landAt('/agents/researcher/hooks');
    const view = mount();

    await view.findByRole('heading', { name: HOOKS_COPY.agentTab.emptyTitle('Researcher') });
    expect(view.getByText(HOOKS_COPY.agentTab.emptyDescription)).not.toBeNull();
    // The empty state's New hook is secondary, like the one over the rows (sweep S51).
    const action = view.getByRole('link', { name: HOOKS_COPY.newAction });
    expect(action.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(action.getAttribute('href')).toContain('/hooks/new?agent=researcher');
  });

  test('says what the list is, with a secondary New hook, and words each row’s switch by its state', async () => {
    serve({ 'bureau.hooks.list': () => ({ hooks: [HOOK] }) });
    landAt('/agents/researcher/hooks');
    const view = mount();

    await view.findByRole('link', { name: 'When a review is waiting, notify me' });

    expect(view.getByText(HOOKS_COPY.agentTab.intro('Researcher'))).not.toBeNull();
    expect(
      view.getByRole('link', { name: HOOKS_COPY.newAction }).getAttribute('data-cinder-variant'),
    ).toBe('secondary');
    expect(view.getByText(HOOKS_COPY.row.on)).not.toBeNull();
    expect(view.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  test('says a home with hooks off has none, and offers to read again when a read fails', async () => {
    serve({
      'bureau.hooks.list': () => {
        throw new StubFault('UnsupportedCapability', 501, 'This Bureau has no hooks', {
          capability: 'hooks',
        });
      },
    });
    landAt('/agents/researcher/hooks');
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
    landAt('/agents/researcher/hooks');
    const view = mount();
    await view.findByText(HOOKS_COPY.agentTab.loadFailed);
    failing = false;
    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));
    await view.findByRole('link', {
      name: 'When a review is waiting, notify me',
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
        guardrails: ['acme:tripwire'],
        limits: { steps: 12, cost: { run: 1.5 }, tools: { calls: 30, seconds: 90 } },
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

  test('shows the model and its provider, the models to switch to and the step limit as a form, and leaves access to its own tab', async () => {
    landAt('/agents/researcher/settings');
    serve({ 'bureau.agents.versions.list': () => ({ versions: [] }) }, withSettings());
    const { findByTestId, findByLabelText, container } = mount();

    const model = await findByTestId('agent-settings-model');
    await waitFor(() => expect(model.textContent?.trim()).toBe('Sonnet, Anthropic'));
    const awaited468 = await findByTestId('agent-settings-models');
    expect(awaited468.textContent).toContain('Haiku');
    const steps = (await findByLabelText('Step limit')) as HTMLInputElement;
    await waitFor(() => expect(steps.value).toBe('12'));

    const settings = await findByTestId('agent-settings');
    for (const text of ['acme:tripwire', '$1.50', '90 seconds']) {
      expect(settings.textContent).not.toContain(text);
    }
    expect(container.querySelector('[data-testid="agent-versions"]')).not.toBeNull();
  });

  test('marks the effort a chat starts at, and none when the file sets none', async () => {
    landAt('/agents/researcher/settings');
    const agent = withSettings();
    serve(
      { 'bureau.agents.versions.list': () => ({ versions: [] }) },
      {
        ...agent,
        definition: { ...agent.definition, effort: 'high' },
      },
    );
    const { findByLabelText } = mount();
    const effort = (await findByLabelText('Effort')) as HTMLSelectElement;
    await waitFor(() => expect(effort.value).toBe('high'));
    expect(effort.selectedOptions[0]?.textContent?.trim()).toBe('High');
  });

  test('marks no effort for an agent whose file sets none', async () => {
    landAt('/agents/researcher/settings');
    serve({ 'bureau.agents.versions.list': () => ({ versions: [] }) }, withSettings());
    const { findByLabelText } = mount();
    const effort = (await findByLabelText('Effort')) as HTMLSelectElement;
    expect(effort.value).toBe('');
    expect(effort.selectedOptions[0]?.textContent?.trim()).toBe('None');
    expect([...effort.options].map((option) => option.textContent?.trim())).toEqual([
      'None',
      'Low',
      'Medium',
      'High',
    ]);
  });

  test('restores an older version over the hash of the file as read, once confirmed, and lists the result', async () => {
    landAt('/agents/researcher/settings');
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
    expect(queryByRole('button', { name: 'Restore Version 2' })).toBeNull();
    const restoreButton = await findByRole('button', { name: 'Restore Version 1' });
    expect(restoreButton.hasAttribute('data-changes')).toBe(true);
    await fireEvent.click(restoreButton);

    // Nothing is written until the question is answered.
    const dialog = await findByRole('dialog', { name: 'Restore Version 1?' });
    expect(served.calls.some((call) => call.method === 'bureau.agents.versions.restore')).toBe(
      false,
    );
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Version 1' }));

    await findByText('Version 3');
    expect(
      served.calls.find((call) => call.method === 'bureau.agents.versions.restore')?.params,
    ).toEqual({ id: 'researcher', revision: 1, expectedHash: 'hash-1' });
  });

  test('says why a restore was refused', async () => {
    landAt('/agents/researcher/settings');
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

    await fireEvent.click(await findByRole('button', { name: 'Restore Version 1' }));
    const dialog = await findByRole('dialog', { name: 'Restore Version 1?' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Version 1' }));

    await findByText(/The model is gone/, { selector: '[role="alert"] p' });
  });

  test('names a first version and a later save that changed nothing apart', async () => {
    landAt('/agents/researcher/settings');
    serve(
      {
        'bureau.agents.versions.list': () => ({
          versions: [version(2, 'identity-2', []), version(1, 'identity-1', ALL_KEYS)],
        }),
      },
      withSettings(),
    );
    const { findByText, queryByText } = mount();

    await findByText('Saved with no change');
    await findByText('Created');
    expect(queryByText(/: changed/)).toBeNull();
  });

  test('says the agent changed and refetches the versions when a restore is stale', async () => {
    landAt('/agents/researcher/settings');
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

    await fireEvent.click(await findByRole('button', { name: 'Restore Version 1' }));
    const dialog = await findByRole('dialog', { name: 'Restore Version 1?' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Version 1' }));

    await findByText(/changed after the page loaded/);
    await waitFor(() => expect(listed).toBeGreaterThan(1));
  });

  test('deletes the agent over the hash of the file as read, once its identifier is typed, and returns to the list', async () => {
    landAt('/agents/researcher/settings');
    const served = serve(
      {
        'bureau.agents.versions.list': () => ({ versions: [] }),
        'bureau.agents.references': () => ({
          agentName: 'researcher',
          schedules: [],
          workflows: [],
          hooks: [],
        }),
        'bureau.agents.definitions.delete': () => ({ id: 'researcher', hash: 'hash-1' }),
      },
      withSettings(),
    );
    const { findByRole, findByLabelText } = mount();

    const remove = await findByRole('button', { name: 'Delete agent' });
    expect(remove.hasAttribute('data-changes')).toBe(true);
    await fireEvent.click(remove);
    const dialog = await findByRole('dialog', { name: 'Delete Researcher?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete agent' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await fireEvent.input(await findByLabelText('Type researcher to confirm'), {
      target: { value: 'researcher' },
    });
    await fireEvent.click(confirm);

    await waitFor(() => expect(router.pathname).toBe('/agents'));
    expect(
      served.calls.find((call) => call.method === 'bureau.agents.definitions.delete')?.params,
    ).toEqual({ id: 'researcher', expectedHash: 'hash-1' });
  });
});
