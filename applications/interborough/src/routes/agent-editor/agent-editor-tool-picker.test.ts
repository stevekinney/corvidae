/**
 * A new agent's tools: the Add tools picker that searches and groups by source and marks a tool that
 * asks first, the table of the chosen tools, and a create that carries exactly what was picked. A
 * saved agent's form has no picker: it reads its tools as a line that points to the Access tab
 * (`agent-editor-edit-form.test.ts`).
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY, CAPABILITIES_COPY } from '../../app/copy.ts';
import {
  catalogFixture,
  installBureauStub,
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

/** The New agent form, against a catalog of `tools`. */
function mountEditor(tools: readonly CatalogToolFixture[] = TOOLS) {
  const installed = installBureauStub({
    'bureau.agents.catalog': () => catalogFixture({ tools }),
    'bureau.agents.definitions.create': (params) => ({ id: String(params['id']), hash: 'created' }),
  });
  stub = installed;
  const view = render(Harness, { props: {} } as never);
  return { view, stub: installed };
}

/** The definition the first call to `method` wrote. */
function writtenDefinition(installed: BureauStub, method: string): Record<string, unknown> {
  const [call] = installed.callsTo(method);
  if (call === undefined) throw new Error(`${method} was not called`);
  return (call.params as { definition: Record<string, unknown> }).definition;
}

/** The names in the table of chosen tools, in order. */
function chosenNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="agent-tools-table"] [data-tool]'),
  ).map((row) => row.getAttribute('data-tool') ?? '');
}

/** Opens the picker, ticks each of `names`, and closes it with Done. */
async function pick(view: ReturnType<typeof mountEditor>['view'], names: readonly string[]) {
  await fireEvent.click(await view.findByRole('button', { name: copy.addToolsAction }));
  for (const name of names) {
    await fireEvent.click(await view.findByRole('checkbox', { name }));
  }
  await fireEvent.click(view.getByRole('button', { name: copy.toolPicker.done }));
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
  test('says so when none is chosen, and lists the chosen ones in the catalog’s order, which is the order a create writes', async () => {
    const { view } = mountEditor();
    await view.findByRole('textbox', { name: /^Name/ });
    expect(view.getByTestId('agent-tools-none').textContent).toBe(copy.noToolsChosen);
    expect(view.getByRole('group', { name: /^Tools/ }).textContent).toContain(
      copy.newAgent.toolCount(0, 6),
    );

    await pick(view, ['github__list_repos', 'lookup-order']);
    expect(chosenNames()).toEqual(['lookup-order', 'github__list_repos']);
    expect(view.getByRole('group', { name: /^Tools/ }).textContent).toContain(
      copy.newAgent.toolCount(2, 6),
    );
  });

  test('has no Remove: a tool is cleared in the picker, and the table follows', async () => {
    const { view } = mountEditor();
    await pick(view, ['lookup-order', 'issue-refund']);
    expect(view.queryByRole('button', { name: /^Remove / })).toBeNull();

    await fireEvent.click(await view.findByRole('button', { name: copy.addToolsAction }));
    await fireEvent.click(await view.findByRole('checkbox', { name: 'lookup-order' }));
    await fireEvent.click(view.getByRole('button', { name: copy.toolPicker.done }));
    expect(chosenNames()).toEqual(['issue-refund']);
  });
});

describe('the Add tools picker', () => {
  async function openPicker(view: ReturnType<typeof mountEditor>['view']) {
    await fireEvent.click(await view.findByRole('button', { name: copy.addToolsAction }));
    return view.findByRole('searchbox', { name: copy.toolPicker.searchLabel });
  }

  test('lists every tool under the source it comes from: Bureau, the host, then each saved source', async () => {
    const { view } = mountEditor();
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
    const { view } = mountEditor();
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
    const { view } = mountEditor();
    await openPicker(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'github__list_repos' }));
    const github = document.querySelector<HTMLElement>('fieldset[data-group="saved:github"]');
    if (github === null) throw new Error('expected the github group');
    expect(github.querySelector('legend')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'github 1 of 2',
    );
    expect(standingIn(github, 'github__create_issue')).toBe('asks-first');
    expect(standingIn(github, 'github__list_repos')).toBeNull();
  });

  test('adds and clears tools straight into the table the page shows, with nothing to apply', async () => {
    const { view } = mountEditor();
    await openPicker(view);
    await fireEvent.click(view.getByRole('checkbox', { name: 'lookup-order' }));
    expect((view.getByRole('checkbox', { name: 'lookup-order' }) as HTMLInputElement).checked).toBe(
      true,
    );
    await fireEvent.click(view.getByRole('checkbox', { name: 'petstore__get_pet' }));
    await fireEvent.click(view.getByRole('checkbox', { name: 'lookup-order' }));
    expect(chosenNames()).toEqual(['petstore__get_pet']);
    expect(view.getByRole('group', { name: /^Tools/ }).textContent).toContain(
      copy.newAgent.toolCount(1, 6),
    );
  });
});

describe('saving the tools', () => {
  test('creates a new agent with the tools picked, and no approvals of its own', async () => {
    const { view, stub } = mountEditor();
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
    expect('approvals' in definition).toBe(false);
  });
});
