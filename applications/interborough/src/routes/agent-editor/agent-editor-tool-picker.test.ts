/**
 * The editor's tools: the count and the chosen tools with their asks-first markers, the Add tools
 * picker that searches and groups by source, and a save that carries exactly what was added or
 * removed (an approval the file states stays with its tool, even for a tool that is taken away and
 * brought back before the save).
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY, CAPABILITIES_COPY } from '../../app/copy.ts';
import type { AgentDetail } from '../../lib/agent-definitions.ts';
import {
  catalogFixture,
  installBureauStub,
  readyAgent,
  type BureauStub,
  type CatalogToolFixture,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

const copy = AGENT_EDITOR_COPY;
const sources = CAPABILITIES_COPY.tool.sources;

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

const TOOLS: readonly CatalogToolFixture[] = [
  {
    name: 'bureau:workflows-create',
    description: 'Create a workflow.',
    shortDescription: null,
    source: 'bureau',
    tier: 'mutating',
    defaultApproval: 'ask',
  },
  { name: 'lookup-order', description: 'Look an order up.', shortDescription: null },
  {
    name: 'issue-refund',
    description: 'Refund an order.',
    shortDescription: null,
    tier: 'mutating',
    defaultApproval: 'ask',
  },
  {
    name: 'github__create_issue',
    description: 'Open an issue on GitHub.',
    shortDescription: null,
    tier: 'mutating',
    defaultApproval: 'ask',
  },
  { name: 'github__list_repos', description: 'List repositories.', shortDescription: null },
  {
    name: 'petstore__get_pet',
    description: 'Fetch a pet by its identifier.',
    shortDescription: null,
  },
];

function agentWith(
  tools: readonly string[],
  toolApproval: Record<string, 'never' | 'on-changes' | 'always' | 'blocked'> | null = null,
): AgentDetail {
  const detail = readyAgent();
  if (detail.definition === null) throw new Error('expected a definition');
  return { ...detail, definition: { ...detail.definition, tools: [...tools], toolApproval } };
}

function mountEditor(agent: AgentDetail | undefined, tools: readonly CatalogToolFixture[] = TOOLS) {
  const detail = agent ?? readyAgent();
  const installed = installBureauStub({
    'bureau.agents.catalog': () => catalogFixture({ tools }),
    'bureau.agents.definitions.get': () => detail,
    'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
    'bureau.agents.versions.list': () => ({ versions: [] }),
    'bureau.agents.definitions.create': (params) => ({ id: String(params['id']), hash: 'created' }),
    'bureau.agents.definitions.update': () => ({ id: detail.id, hash: 'hash-2' }),
  });
  stub = installed;
  const view = render(Harness, { props: agent === undefined ? {} : { id: detail.id } } as never);
  return { view, stub: installed };
}

/** The definition the first call to `method` wrote. */
function writtenDefinition(installed: BureauStub, method: string): Record<string, unknown> {
  const [call] = installed.callsTo(method);
  if (call === undefined) throw new Error(`${method} was not called`);
  return (call.params as { definition: Record<string, unknown> }).definition;
}

/** The names in the chosen list, in order. */
function chosenNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.weft-agent-tools__list [data-tool] .weft-agent-tools__name',
    ),
  ).map((name) => name.textContent ?? '');
}

/** The marker on a tool of the chosen list, or `null`. */
function standingIn(list: HTMLElement, tool: string): string | null {
  const row = list.querySelector(`[data-tool="${tool}"]`);
  if (row === null) throw new Error(`${tool} is not in the list`);
  return (
    row.querySelector('[data-testid="agent-tool-standing"]')?.getAttribute('data-standing') ?? null
  );
}

describe('the chosen tools', () => {
  test('shows how many of the installation’s tools the agent has, and lists them by name', async () => {
    const { view } = mountEditor(agentWith(['lookup-order', 'github__list_repos']));
    const count = await view.findByTestId('agent-tool-count');
    expect(count.textContent?.trim()).toBe('2 of 6 chosen');
    // The list follows the catalog's order, which is the order a save writes.
    expect(chosenNames()).toEqual(['lookup-order', 'github__list_repos']);
  });

  test('says so when the agent has none, and counts a tool the catalog dropped as not chosen', async () => {
    const { view } = mountEditor(agentWith(['gone-tool']));
    const count = await view.findByTestId('agent-tool-count');
    expect(count.textContent?.trim()).toBe('0 of 6 chosen');
    expect(view.getByTestId('agent-tools-none').textContent).toBe(copy.noToolsChosen);
    expect(view.queryByRole('list', { name: copy.chosenToolsLabel })).toBeNull();
  });

  test('marks a tool that asks first: by its tier’s default, or because the file says always', async () => {
    const { view } = mountEditor(
      agentWith(['lookup-order', 'issue-refund', 'github__list_repos'], {
        github__list_repos: 'always',
      }),
    );
    const list = await view.findByRole('list', { name: copy.chosenToolsLabel });
    // `lookup-order` reads, so it runs; `issue-refund` changes something, so its default asks.
    expect(standingIn(list, 'lookup-order')).toBeNull();
    expect(standingIn(list, 'issue-refund')).toBe('asks-first');
    expect(standingIn(list, 'github__list_repos')).toBe('asks-first');
    expect(within(list).getAllByText(copy.toolStanding['asks-first'])).toHaveLength(2);
  });

  test('does not mark a tool the file sets to never, and marks one it blocks as blocked', async () => {
    const { view } = mountEditor(
      agentWith(['issue-refund', 'github__create_issue'], {
        'issue-refund': 'never',
        github__create_issue: 'blocked',
      }),
    );
    const list = await view.findByRole('list', { name: copy.chosenToolsLabel });
    expect(standingIn(list, 'issue-refund')).toBeNull();
    expect(standingIn(list, 'github__create_issue')).toBe('blocked');
    expect(within(list).getByText(copy.toolStanding.blocked)).not.toBeNull();
  });

  test('takes a tool away with its Remove, and the count follows', async () => {
    const { view } = mountEditor(agentWith(['lookup-order', 'issue-refund']));
    await fireEvent.click(
      await view.findByRole('button', { name: copy.removeToolLabel('lookup-order') }),
    );
    expect(chosenNames()).toEqual(['issue-refund']);
    expect(view.getByTestId('agent-tool-count').textContent?.trim()).toBe('1 of 6 chosen');
  });
});

describe('the Add tools picker', () => {
  async function openPicker(view: ReturnType<typeof mountEditor>['view']) {
    await fireEvent.click(await view.findByRole('button', { name: copy.addToolsAction }));
    return view.findByRole('searchbox', { name: copy.toolPicker.searchLabel });
  }

  test('lists every tool under the source it comes from: Bureau, the host, then each saved source', async () => {
    const { view } = mountEditor(agentWith([]));
    await openPicker(view);
    const groups = Array.from(document.querySelectorAll<HTMLElement>('fieldset[data-group]'));
    expect(groups.map((group) => group.dataset['group'])).toEqual([
      'bureau',
      'host',
      'saved:github',
      'saved:petstore',
    ]);
    expect(groups.map((group) => group.querySelector('legend span')?.textContent)).toEqual([
      sources.bureau,
      sources.host,
      'github',
      'petstore',
    ]);
    expect(
      groups.map((group) =>
        Array.from(group.querySelectorAll('[data-tool]')).map((row) =>
          row.getAttribute('data-tool'),
        ),
      ),
    ).toEqual([
      ['bureau:workflows-create'],
      ['lookup-order', 'issue-refund'],
      ['github__create_issue', 'github__list_repos'],
      ['petstore__get_pet'],
    ]);
    expect(view.getByTestId('agent-tool-matches').textContent?.trim()).toBe('6 tools');
  });

  test('searches by name, by description and by source, and says when nothing matches', async () => {
    const { view } = mountEditor(agentWith([]));
    const search = await openPicker(view);
    const shown = () =>
      Array.from(document.querySelectorAll('fieldset [data-tool]')).map((row) =>
        row.getAttribute('data-tool'),
      );

    await fireEvent.input(search, { target: { value: 'REFUND' } });
    expect(shown()).toEqual(['issue-refund']);

    // A description: "pet" is in the description of petstore's tool, and in nothing's name but its own.
    await fireEvent.input(search, { target: { value: 'identifier' } });
    expect(shown()).toEqual(['petstore__get_pet']);

    // A source: every tool its server loaded, and no other.
    await fireEvent.input(search, { target: { value: 'github' } });
    expect(shown()).toEqual(['github__create_issue', 'github__list_repos']);
    expect(view.getByTestId('agent-tool-matches').textContent?.trim()).toBe('2 tools');

    await fireEvent.input(search, { target: { value: 'zzz' } });
    expect(shown()).toEqual([]);
    expect(
      view.getByRole('heading', { level: 3, name: copy.toolPicker.noMatchesTitle }),
    ).not.toBeNull();

    await fireEvent.input(search, { target: { value: '' } });
    expect(shown()).toHaveLength(6);
  });

  test('marks a tool that asks first, and shows how many of a source’s tools are chosen', async () => {
    const { view } = mountEditor(agentWith(['github__list_repos']));
    await openPicker(view);
    const github = document.querySelector<HTMLElement>('fieldset[data-group="saved:github"]');
    if (github === null) throw new Error('expected the github group');
    expect(github.querySelector('legend')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'github 1 of 2',
    );
    expect(standingIn(github, 'github__create_issue')).toBe('asks-first');
    expect(standingIn(github, 'github__list_repos')).toBeNull();
  });

  test('adds and clears tools straight into the list the page shows, with nothing to apply', async () => {
    const { view } = mountEditor(agentWith(['lookup-order']));
    await openPicker(view);
    expect((view.getByRole('checkbox', { name: 'lookup-order' }) as HTMLInputElement).checked).toBe(
      true,
    );
    await fireEvent.click(view.getByRole('checkbox', { name: 'petstore__get_pet' }));
    await fireEvent.click(view.getByRole('checkbox', { name: 'lookup-order' }));
    expect(chosenNames()).toEqual(['petstore__get_pet']);
    expect(view.getByTestId('agent-tool-count').textContent?.trim()).toBe('1 of 6 chosen');
  });
});

describe('saving the tools', () => {
  async function save(view: ReturnType<typeof mountEditor>['view']) {
    await fireEvent.click(view.getByRole('button', { name: copy.saveAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/researcher'));
  }

  test('sends the tools that were added and leaves out the ones that were removed', async () => {
    const { view, stub } = mountEditor(agentWith(['lookup-order', 'issue-refund']));
    await fireEvent.click(await view.findByRole('button', { name: copy.addToolsAction }));
    await fireEvent.click(await view.findByRole('checkbox', { name: 'petstore__get_pet' }));
    await fireEvent.click(view.getByRole('checkbox', { name: 'lookup-order' }));
    await fireEvent.click(view.getByRole('button', { name: copy.toolPicker.done }));
    await save(view);

    const definition = writtenDefinition(stub, 'bureau.agents.definitions.update');
    expect(definition['tools']).toEqual(['issue-refund', 'petstore__get_pet']);
  });

  test('keeps the approval of a tool that stays, drops the one of a tool taken away, and restores it when the tool comes back', async () => {
    const { view, stub } = mountEditor(
      agentWith(['lookup-order', 'issue-refund', 'github__create_issue'], {
        'issue-refund': 'always',
        github__create_issue: 'never',
      }),
    );
    // Taken away and brought back before the save: the file's choice is still the tool's.
    await fireEvent.click(
      await view.findByRole('button', { name: copy.removeToolLabel('github__create_issue') }),
    );
    await fireEvent.click(view.getByRole('button', { name: copy.addToolsAction }));
    await fireEvent.click(await view.findByRole('checkbox', { name: 'github__create_issue' }));
    await fireEvent.click(view.getByRole('button', { name: copy.toolPicker.done }));
    // Taken away for good: its approval cannot be written, because the Bureau refuses an approval for a tool not listed.
    await fireEvent.click(view.getByRole('button', { name: copy.removeToolLabel('issue-refund') }));
    await save(view);

    const definition = writtenDefinition(stub, 'bureau.agents.definitions.update');
    expect(definition['tools']).toEqual(['lookup-order', 'github__create_issue']);
    expect(definition['toolApproval']).toEqual({ github__create_issue: 'never' });
  });

  test('creates a new agent with the tools picked, and no approvals of its own', async () => {
    const { view, stub } = mountEditor(undefined);
    await fireEvent.input(await view.findByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Helper' },
    });
    await fireEvent.click(view.getByRole('button', { name: copy.addToolsAction }));
    await fireEvent.click(await view.findByRole('checkbox', { name: 'github__list_repos' }));
    await fireEvent.click(view.getByRole('button', { name: copy.toolPicker.done }));
    await fireEvent.click(view.getByRole('button', { name: copy.createAction }));
    await waitFor(() => expect(router.pathname).toBe('/agents/helper'));

    const definition = writtenDefinition(stub, 'bureau.agents.definitions.create');
    expect(definition['tools']).toEqual(['github__list_repos']);
    expect('toolApproval' in definition).toBe(false);
  });
});
