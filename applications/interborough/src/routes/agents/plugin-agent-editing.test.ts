/**
 * A running plugin's agent defined in code, `/agents/demo:echo` (COR-2229): its Settings and Access
 * tabs are editable through the file agent's own components, each change is saved as a version of
 * the agent's overrides (`bureau.agents.overrides.update`) and listed with Restore, and the page
 * of an agent whose plugin is disabled stays read-only with the reason and Duplicate.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';

const restores: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const restore of restores.splice(0).reverse()) restore();
});

const mount = () =>
  render(QueryPage, { props: { page: AgentDetail, client: createQueryClient() } } as never);

const NONE = {
  instructions: null,
  tools: null,
  approvals: null,
  guardrails: null,
  interceptors: null,
  escalations: null,
  limits: null,
  model: null,
  models: null,
  effort: null,
};
type Overrides = Record<string, unknown>;
type Saved = {
  revision: number;
  hash: string;
  savedAt: string;
  savedBy: string;
  definition: null;
  overrides: Overrides;
  changedKeys: string[];
};

const LISTING = {
  ...AGENT,
  name: 'demo:echo',
  displayName: 'Echo',
  kind: 'code',
  description: 'Repeats the last message it was sent.',
};

const PLUGINS = {
  configurationRevision: 'r1',
  plugins: [
    {
      descriptor: {
        name: 'demo',
        title: 'Demo',
        version: '1.1.0',
        description: 'Sample tools and agents.',
        required: false,
        enabledByDefault: false,
      },
      source: 'package',
      location: '@lostgradient/plugin-demo',
      status: 'running',
      problems: [],
      contributions: [],
      enabled: true,
      configuration: {},
      configurationSchema: null,
      running: { enabled: true, configuration: {} },
      secrets: [],
      restartRequired: false,
    },
  ],
  unloaded: [],
};

/** The Bureau for `demo:echo`: a code agent that keeps its saved overrides as numbered versions. */
function serveEcho(
  initial: {
    overrides?: Overrides;
    versions?: Saved[];
    /** What the agent states itself that a copy would drop, as `definitions.get` says it. */
    dropped?: string[];
    /** How many reads of the overrides fail before one answers. */
    failReads?: number;
    /** The tools the agent states itself, by its own names; the host's catalog lists them as given in `catalogTools`. */
    ownTools?: string[];
    /** What the agent states as its own instructions; `null` for an agent that states none. */
    instructions?: string | null;
    /** The catalog's tool names: bare ones, or the plugin's (`demo:lookup-order`) as the real host lists them. */
    catalogTools?: string[];
    /** While `held` is a promise, an answer of `definitions.get` waits for it: the overrides can land first. */
    definitionGate?: { held: Promise<void> | null };
  } = {},
) {
  const ownTools = initial.ownTools ?? ['lookup-order'];
  const catalogTools = initial.catalogTools ?? ['lookup-order', 'issue-refund'];
  let failReads = initial.failReads ?? 0;
  let overrides: Overrides = { ...NONE, ...initial.overrides };
  const versions: Saved[] = [...(initial.versions ?? [])];
  const hashOf = (version: number | null) => (version === null ? 'hash-0' : `hash-${version}`);
  const newest = () => versions[0]?.revision ?? null;
  const save = (next: Overrides, changedKeys: string[]) => {
    const revision = (newest() ?? 0) + 1;
    overrides = { ...NONE, ...next };
    versions.unshift({
      revision,
      hash: hashOf(revision),
      savedAt: '2026-11-13T09:00:00.000Z',
      savedBy: 'anonymous:local',
      definition: null,
      overrides,
      changedKeys,
    });
    return revision;
  };
  const stub = installBureauStub(
    {
      'bureau.agents.list': () => ({ agents: [LISTING] }),
      'bureau.agents.definitions.get': async () => {
        await initial.definitionGate?.held;
        return {
          ...readyAgent({ id: 'demo:echo', name: 'echo' }),
          source: 'code',
          hash: null,
          definition: null,
          codeDefinition: {
            name: 'echo',
            description: 'Repeats the last message it was sent.',
            model: null,
            models: [],
            tools: (overrides['tools'] as string[] | null) ?? ownTools,
            skills: [],
            card: [],
            instructions:
              (overrides['instructions'] as string | null) ??
              (initial.instructions === undefined
                ? 'Repeat the last message.'
                : initial.instructions),
          },
          dropped: initial.dropped ?? [],
        };
      },
      'bureau.agents.overrides.get': () => {
        if (failReads > 0) {
          failReads -= 1;
          throw faults.notFound('demo:echo');
        }
        return {
          id: 'demo:echo',
          hash: hashOf(newest()),
          version: newest(),
          overrides,
          ownTools,
        };
      },
      'bureau.agents.overrides.update': (params) => {
        if (params['expectedHash'] !== hashOf(newest())) {
          throw faults.stale(hashOf(newest()), String(params['expectedHash']));
        }
        const sent = params['overrides'] as Overrides;
        const changed = Object.keys(sent).filter(
          (key) => JSON.stringify(sent[key]) !== JSON.stringify(overrides[key] ?? null),
        );
        const revision = save(sent, changed);
        return { id: 'demo:echo', hash: hashOf(revision), version: revision };
      },
      'bureau.agents.versions.list': () => ({ versions }),
      'bureau.agents.versions.restore': (params) => {
        if (params['expectedHash'] !== hashOf(newest())) {
          throw faults.stale(hashOf(newest()), String(params['expectedHash']));
        }
        const target = versions.find((version) => version.revision === params['revision']);
        if (target === undefined) throw faults.notFound('demo:echo');
        const revision = save(target.overrides, ['instructions']);
        return { id: 'demo:echo', hash: hashOf(revision), revision };
      },
      'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
      'bureau.agents.catalog': () =>
        catalogFixture({
          models: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }],
          tools: catalogTools.map((name) => ({
            name,
            description: name.endsWith('lookup-order') ? 'Looks an order up.' : 'Refunds an order.',
            shortDescription: null,
          })),
        }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
      'bureau.hooks.list': () => ({ hooks: [] }),
      'bureau.guardrails.list': () => ({ guardrails: [] }),
      'bureau.skills.list': () => ({ skills: [], sources: [] }),
    },
    { hostProviders: [{ name: 'anthropic', hasKey: true }] },
  );
  restores.push(stub.restore);
  // The host names the plugin: the page words it by its title.
  const inner = globalThis.fetch;
  restores.push(
    installFetchImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(url, 'http://localhost').pathname === '/host/plugins'
        ? Response.json(PLUGINS)
        : inner(input, init);
    }),
  );
  return Object.assign(stub, {
    /** Another person's save, behind the page's back: the overrides move to a new hash. */
    bump: () => save({ ...overrides, model: 'anthropic/haiku' }, ['model']),
  });
}

const updates = (stub: BureauStub) => stub.callsTo('bureau.agents.overrides.update');
const sentOverrides = (stub: BureauStub, index = 0) =>
  updates(stub)[index]?.params['overrides'] as Overrides;

const copy = AGENT_PAGE_COPY;

describe('the Settings tab of a running plugin’s code agent', () => {
  test('edits the instructions, and the save is Version 1 in the versions list (COR-2229 AC1)', async () => {
    landAt('/agents/demo%3Aecho/settings');
    const stub = serveEcho();
    const { findByRole, findByTestId, container, queryByRole } = mount();

    const field = (await findByRole('textbox', {
      name: copy.settings.instructionsLabel,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe('Repeat the last message.'));
    expect(field.disabled).toBe(false);
    // One Save, a note that names the version it makes, and no Delete: Restore is the way back.
    const saveNote = await findByTestId('agent-settings-save-note');
    expect(saveNote.textContent?.trim()).toBe('Saving makes Version 1.');
    expect(queryByRole('button', { name: copy.settings.deleteAction })).toBeNull();

    await fireEvent.input(field, { target: { value: 'Be terse.' } });
    await fireEvent.click(await findByRole('button', { name: copy.settings.save }));

    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    expect(updates(stub)[0]?.params['id']).toBe('demo:echo');
    expect(updates(stub)[0]?.params['expectedHash']).toBe('hash-0');
    // Only what was changed is overridden: the model, the tools and the rest stay the agent's own.
    expect(sentOverrides(stub)).toEqual({ instructions: 'Be terse.' });
    await waitFor(() => {
      const list = container.querySelector('[data-testid="agent-versions"] [data-revision="1"]');
      expect(list?.textContent).toContain('Version 1');
    });
  });

  test('says in one muted line, naming the plugin by its title, that changes are saved as versions', async () => {
    landAt('/agents/demo%3Aecho/settings');
    serveEcho();
    const { findByTestId, container } = mount();

    const note = await findByTestId('agent-plugin-note');
    await waitFor(() => expect(note.textContent?.trim()).toBe(copy.plugin.overridable('Demo')));
    // A plain line: never a callout, an alert, a banner or a card inside the tab.
    const body = container.querySelector('[data-testid="agent-settings"]')!;
    expect(
      body.querySelector('.cinder-callout, .cinder-alert, .cinder-banner, .cinder-card'),
    ).toBeNull();
  });

  test('keeps every other override when the Settings tab saves, and clears the instructions when emptied', async () => {
    landAt('/agents/demo%3Aecho/settings');
    const stub = serveEcho({
      overrides: {
        instructions: 'Old.',
        tools: ['lookup-order', 'issue-refund'],
        interceptors: ['demo:audit'],
        limits: { cost: { run: 2, chat: 5 }, tools: { calls: 3 } },
      },
      versions: [
        {
          revision: 1,
          hash: 'hash-1',
          savedAt: '2026-11-13T08:00:00.000Z',
          savedBy: 'anonymous:local',
          definition: null,
          overrides: { ...NONE, instructions: 'Old.' },
          changedKeys: ['instructions'],
        },
      ],
    });
    const { findByLabelText, findByRole } = mount();

    const field = (await findByRole('textbox', {
      name: copy.settings.instructionsLabel,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe('Old.'));
    await fireEvent.input(field, { target: { value: '' } });
    await fireEvent.input(await findByLabelText('Step limit'), { target: { value: '12' } });
    await fireEvent.click(await findByRole('button', { name: copy.settings.save }));

    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    // The tab's own keys change (the instructions are gone, a step limit is set); the Access tab's
    // tools and spend limit, the interceptors and the tool limit are sent back as they were read.
    expect(sentOverrides(stub)).toEqual({
      tools: ['lookup-order', 'issue-refund'],
      interceptors: ['demo:audit'],
      limits: { steps: 12, cost: { run: 2, chat: 5 }, tools: { calls: 3 } },
    });
  });

  test('after the instructions are emptied and the tab is opened again, a save of another field does not write the agent’s own instructions as an override', async () => {
    landAt('/agents/demo%3Aecho/settings');
    const stub = serveEcho({ overrides: { instructions: 'X' } });
    const { findByLabelText, findByRole, container } = mount();

    const field = (await findByRole('textbox', {
      name: copy.settings.instructionsLabel,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe('X'));
    await fireEvent.input(field, { target: { value: '' } });
    await fireEvent.click(await findByRole('button', { name: copy.settings.save }));
    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    expect(sentOverrides(stub, 0)).toEqual({});
    // The save has settled once its version is listed: nothing is left unsaved to leave behind.
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="agent-versions"] [data-revision="1"]'),
      ).not.toBeNull(),
    );

    // Another tab and back: Settings mounts again, filled with the agent's own instructions.
    router.navigate('/agents/demo%3Aecho/instructions');
    await waitFor(() => expect(router.pathname).toBe('/agents/demo%3Aecho/instructions'));
    router.navigate('/agents/demo%3Aecho/settings');
    const again = (await findByRole('textbox', {
      name: copy.settings.instructionsLabel,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(again.value).toBe('Repeat the last message.'));
    await fireEvent.input(await findByLabelText('Step limit'), { target: { value: '12' } });
    await fireEvent.click(await findByRole('button', { name: copy.settings.save }));

    await waitFor(() => expect(updates(stub)).toHaveLength(2));
    // Only the step limit the person changed: the instructions they never touched stay the agent's own.
    expect(sentOverrides(stub, 1)).toEqual({ limits: { steps: 12 } });
  });
});

describe('the Access tab of a running plugin’s code agent', () => {
  test('allows a tool as a version of the overrides, keeping the instructions already changed', async () => {
    landAt('/agents/demo%3Aecho/access');
    const stub = serveEcho({
      overrides: { instructions: 'Be terse.' },
      versions: [
        {
          revision: 1,
          hash: 'hash-1',
          savedAt: '2026-11-13T08:00:00.000Z',
          savedBy: 'anonymous:local',
          definition: null,
          overrides: { ...NONE, instructions: 'Be terse.' },
          changedKeys: ['instructions'],
        },
      ],
    });
    const { findByRole, findByTestId } = mount();

    const box = await findByRole('checkbox', { name: /Allow Issue refund/ });
    expect((box as HTMLInputElement).disabled).toBe(false);
    await fireEvent.click(box);

    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    expect(updates(stub)[0]?.params['expectedHash']).toBe('hash-1');
    expect(sentOverrides(stub)).toEqual({
      instructions: 'Be terse.',
      tools: ['lookup-order', 'issue-refund'],
    });
    const saved = await findByTestId('agent-access-saved');
    await waitFor(() => expect(saved.textContent).toContain('Version 2'));
  });
});

describe('what a plugin’s code agent states itself that an override would replace whole', () => {
  test('holds its tools, Asks and guardrails while they are not overridden, and says so', async () => {
    landAt('/agents/demo%3Aecho/access');
    const stub = serveEcho({ dropped: ['approvals', 'guardrails'] });
    const { findByRole, findByTestId, container } = mount();

    const note = await findByTestId('agent-plugin-note');
    await waitFor(() =>
      expect(note.textContent).toContain(
        'Its own tools, Asks and guardrails stay as they are here',
      ),
    );
    const asks = container.querySelector<HTMLSelectElement>('[data-tool="lookup-order"] select');
    await waitFor(() => expect(asks?.disabled ?? asks?.getAttribute('aria-disabled')).toBeTruthy());
    // An override of the tools rebuilds the run's toolbox with only the Asks the override states, so
    // ticking or unticking a tool would drop the agent's own policy: the boxes are held too.
    const issue = await findByRole('checkbox', { name: /Allow Issue refund/ });
    const lookup = await findByRole('checkbox', { name: /Allow Lookup order/ });
    expect((issue as HTMLInputElement).disabled).toBe(true);
    expect((lookup as HTMLInputElement).disabled).toBe(true);

    await fireEvent.click(issue);
    await fireEvent.click(lookup);
    expect(updates(stub)).toHaveLength(0);
  });

  test('holds only the guardrails when the agent states no Asks, and a save of the spend limit states no tools', async () => {
    landAt('/agents/demo%3Aecho/access');
    const stub = serveEcho({ dropped: ['guardrails'] });
    const { findByLabelText, findByRole, findByTestId } = mount();

    const box = await findByRole('checkbox', { name: /Allow Issue refund/ });
    expect((box as HTMLInputElement).disabled).toBe(false);
    const spend = await findByLabelText('Spend limit per chat');
    await fireEvent.input(spend, { target: { value: '4' } });
    await fireEvent.change(spend);
    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    // A save of the spend limit alone never states the tools, which would rebuild the toolbox.
    expect(Object.keys(sentOverrides(stub))).not.toContain('tools');
    await findByTestId('agent-access-saved');
  });
});

describe('a plugin’s tools, which its agent states by their own names and the catalog lists by the plugin’s', () => {
  const QUALIFIED = {
    ownTools: ['lookup-order', 'issue-refund'],
    catalogTools: ['demo:lookup-order', 'demo:issue-refund'],
  };

  test('shows each tool once, under the catalog’s name, allowed, and with no retired group', async () => {
    landAt('/agents/demo%3Aecho/access');
    serveEcho(QUALIFIED);
    const { findByRole, findByTestId, container } = mount();

    expect(
      ((await findByRole('checkbox', { name: /Allow Lookup order/ })) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      ((await findByRole('checkbox', { name: /Allow Issue refund/ })) as HTMLInputElement).checked,
    ).toBe(true);
    const count = await findByTestId('agent-access-count');
    expect(count.textContent).toContain('2 of 2 allowed');
    expect(container.querySelector('[data-group="retired"]')).toBeNull();
    expect(container.querySelectorAll('[data-tool]')).toHaveLength(2);
    expect(container.querySelector('[data-tool="demo:issue-refund"]')).not.toBeNull();
  });

  test('withdraws a tool by its own name, and a save of another key states no tools', async () => {
    landAt('/agents/demo%3Aecho/access');
    const stub = serveEcho(QUALIFIED);
    const { findByLabelText, findByRole, findByTestId } = mount();

    const box = (await findByRole('checkbox', { name: /Allow Issue refund/ })) as HTMLInputElement;
    await fireEvent.click(box);
    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    // The agent's own name is written, so the run keeps its own tool and no catalog twin replaces it.
    expect(sentOverrides(stub)).toEqual({ tools: ['lookup-order'] });
    await waitFor(() =>
      expect((box.closest('[data-tool]') as HTMLElement).dataset['saving']).toBe(undefined),
    );
    await findByTestId('agent-access-saved');
    expect(box.checked).toBe(false);

    await fireEvent.click(box);
    await waitFor(() => expect(updates(stub)).toHaveLength(2));
    expect(sentOverrides(stub, 1)).toEqual({ tools: ['lookup-order', 'issue-refund'] });
    const spend = await findByLabelText('Spend limit per chat');
    await fireEvent.input(spend, { target: { value: '4' } });
    await fireEvent.change(spend);
    await waitFor(() => expect(updates(stub)).toHaveLength(3));
    expect(sentOverrides(stub, 2)).toEqual({
      tools: ['lookup-order', 'issue-refund'],
      limits: { cost: { run: 4, chat: 4 } },
    });
  });

  test('a save of the spend limit alone writes no tools when none are overridden', async () => {
    landAt('/agents/demo%3Aecho/access');
    const stub = serveEcho(QUALIFIED);
    const { findByLabelText, findByRole } = mount();

    await findByRole('checkbox', { name: /Allow Issue refund/ });
    const spend = await findByLabelText('Spend limit per chat');
    await fireEvent.input(spend, { target: { value: '4' } });
    await fireEvent.change(spend);
    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    expect(sentOverrides(stub)).toEqual({ limits: { cost: { run: 4, chat: 4 } } });
  });

  test('an override that names a tool both ways is one row', async () => {
    landAt('/agents/demo%3Aecho/access');
    const stub = serveEcho({
      ...QUALIFIED,
      overrides: { tools: ['lookup-order', 'demo:lookup-order'] },
    });
    const { findByRole, container } = mount();

    const box = (await findByRole('checkbox', { name: /Allow Lookup order/ })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(container.querySelectorAll('[data-tool]')).toHaveLength(2);
    expect(container.querySelector('[data-group="retired"]')).toBeNull();
    await fireEvent.click(box);
    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    // Withdrawn under both names, so the row is not allowed again by the name left behind.
    expect(sentOverrides(stub)).toEqual({ tools: [] });
  });
});

describe('the states of a plugin’s code agent’s tabs (COR-2229)', () => {
  test('a failed read of the overrides is the tab’s own failure, with Try again, and the form follows', async () => {
    landAt('/agents/demo%3Aecho/settings');
    serveEcho({ failReads: 1 });
    const { findByRole, findByTestId } = mount();

    expect(await findByTestId('agent-tab-failed')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    expect(await findByTestId('agent-settings-form')).not.toBeNull();
  });

  test('a save over overrides that moved since the page read them says so, writes nothing and reads again', async () => {
    landAt('/agents/demo%3Aecho/settings');
    const stub = serveEcho();
    const { findByRole } = mount();

    const field = (await findByRole('textbox', {
      name: copy.settings.instructionsLabel,
    })) as HTMLTextAreaElement;
    stub.bump();
    await fireEvent.input(field, { target: { value: 'Mine.' } });
    await fireEvent.click(await findByRole('button', { name: copy.settings.save }));

    const alert = await findByRole('alert');
    expect(alert.textContent).toContain(copy.settings.stale);
    // The Bureau refused it: no version was made over the other person's.
    expect(updates(stub).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(stub.callsTo('bureau.agents.overrides.get').length).toBeGreaterThan(1),
    );
  });

  test('the Instructions tab shows the instructions with the overrides applied and says where they are changed', async () => {
    landAt('/agents/demo%3Aecho/instructions');
    serveEcho({ overrides: { instructions: 'Be terse.' } });
    const { findByTestId, findByRole } = mount();

    const body = await findByTestId('agent-instructions-body');
    expect(body.textContent).toContain('Be terse.');
    const line = await findByTestId('agent-instructions-settings');
    expect(line.textContent?.trim()).toBe('Change them on the Settings tab.');

    await fireEvent.click(await findByRole('link', { name: copy.instructions.changeSettings }));

    await waitFor(() => expect(router.pathname).toBe('/agents/demo%3Aecho/settings'));
  });

  test('the Instructions tab of an agent that states none has one statement, an action that goes to Settings, and no line beside it', async () => {
    landAt('/agents/demo%3Aecho/instructions');
    serveEcho({ instructions: null });
    const { findByRole, findByText, container } = mount();

    await findByText(copy.instructions.emptyTitle);
    const action = await findByRole('link', { name: copy.instructions.emptyAction });
    // The action is the empty state's own; the separate line that said the same is gone.
    expect(action.closest('.cinder-empty-state')).not.toBeNull();
    const notes = [
      ...container.querySelectorAll('[data-testid="agent-instructions"] .ib-agent-note'),
    ];
    expect(notes.some((note) => note.textContent?.includes('Settings tab'))).toBe(false);
    await fireEvent.click(action);
    await waitFor(() => expect(router.pathname).toBe('/agents/demo%3Aecho/settings'));
  });
});

describe('Restore on a plugin’s code agent (COR-2229 AC3)', () => {
  const saved = (revision: number, instructions: string): Saved => ({
    revision,
    hash: `hash-${String(revision)}`,
    savedAt: '2026-11-13T08:00:00.000Z',
    savedBy: 'anonymous:local',
    definition: null,
    overrides: { ...NONE, instructions },
    changedKeys: ['instructions'],
  });

  test('lists the versions with what each changed, shows one with its instructions, and restores it as a new version over the overrides’ hash', async () => {
    landAt('/agents/demo%3Aecho/settings');
    const stub = serveEcho({
      overrides: { instructions: 'Second.' },
      versions: [saved(2, 'Second.'), saved(1, 'First.')],
    });
    const { findByRole, findByTestId, container } = mount();

    // An override version is shown with its own instructions, not as a version with no definition.
    await fireEvent.click(await findByRole('button', { name: copy.versions.viewLabel(1) }));
    const view = await findByTestId('agent-version-view');
    expect(view.textContent).toContain('First.');
    expect(view.textContent).not.toContain(copy.versions.view.noDefinition);
    await fireEvent.click(within(view).getByRole('button', { name: copy.versions.view.back }));

    await fireEvent.click(await findByRole('button', { name: copy.versions.restoreLabel(1) }));
    const dialog = await findByRole('dialog', { name: copy.versions.restoreDialog.title(1) });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: copy.versions.restoreDialog.confirm(1) }),
    );

    await waitFor(() => expect(stub.callsTo('bureau.agents.versions.restore')).toHaveLength(1));
    // The restore names the hash of the overrides in force, which a code agent has no file for.
    expect(stub.callsTo('bureau.agents.versions.restore')[0]?.params).toEqual({
      id: 'demo:echo',
      revision: 1,
      expectedHash: 'hash-2',
    });
    await waitFor(() => {
      const list = container.querySelector('[data-testid="agent-versions"] [data-revision="3"]');
      expect(list?.textContent).toContain('Version 3');
    });
  });

  test('after a Restore whose overrides were read before the agent was, a form filled again writes only what the person changed', async () => {
    landAt('/agents/demo%3Aecho/settings');
    const definitionGate: { held: Promise<void> | null } = { held: null };
    const stub = serveEcho({
      overrides: { instructions: 'Second.' },
      // Version 1 changed only the effort, so restoring it takes the instructions override away.
      versions: [
        saved(2, 'Second.'),
        { ...saved(1, 'First.'), overrides: { ...NONE, effort: 'high' }, changedKeys: ['effort'] },
      ],
      definitionGate,
    });
    const { findByRole, findByLabelText, container } = mount();
    const field = (await findByRole('textbox', {
      name: copy.settings.instructionsLabel,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(field.value).toBe('Second.'));

    // The definition is read again behind the overrides: the overrides land first.
    let release = (): void => undefined;
    definitionGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await fireEvent.click(await findByRole('button', { name: copy.versions.viewLabel(1) }));
    await fireEvent.click(await findByRole('button', { name: copy.versions.restoreLabel(1) }));
    const dialog = await findByRole('dialog', { name: copy.versions.restoreDialog.title(1) });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: copy.versions.restoreDialog.confirm(1) }),
    );
    await waitFor(() => expect(stub.callsTo('bureau.agents.versions.restore')).toHaveLength(1));
    await waitFor(() =>
      expect(stub.callsTo('bureau.agents.overrides.get').length).toBeGreaterThan(1),
    );
    const reads = stub.callsTo('bureau.agents.definitions.get').length;
    release();
    await waitFor(() =>
      expect(stub.callsTo('bureau.agents.definitions.get').length).toBeGreaterThanOrEqual(reads),
    );
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="agent-versions"] [data-revision="3"]'),
      ).not.toBeNull(),
    );

    // Another tab and back: Settings is filled again, now with the agent's own instructions.
    router.navigate('/agents/demo%3Aecho/instructions');
    await waitFor(() => expect(router.pathname).toBe('/agents/demo%3Aecho/instructions'));
    router.navigate('/agents/demo%3Aecho/settings');
    const again = (await findByRole('textbox', {
      name: copy.settings.instructionsLabel,
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(again.value).toBe('Repeat the last message.'));
    await fireEvent.input(await findByLabelText('Step limit'), { target: { value: '12' } });
    await fireEvent.click(await findByRole('button', { name: copy.settings.save }));

    await waitFor(() => expect(updates(stub)).toHaveLength(1));
    // The effort the Restore brought back and the step limit the person typed: not the agent's own
    // instructions, which the Restore had just taken the override away from.
    expect(sentOverrides(stub)).toEqual({ effort: 'high', limits: { steps: 12 } });
  });

  test('a version that left the guardrails alone says the agent’s own apply, as it does for the instructions, and states read-only once', async () => {
    landAt('/agents/demo%3Aecho/settings');
    serveEcho({
      overrides: { instructions: 'Third.' },
      versions: [
        saved(3, 'Third.'),
        saved(2, 'Second.'),
        { ...saved(1, 'First.'), overrides: { ...NONE, guardrails: ['demo:no-secrets'] } },
      ],
    });
    const { findByRole, findByTestId } = mount();

    await fireEvent.click(await findByRole('button', { name: copy.versions.viewLabel(2) }));
    const view = await findByTestId('agent-version-view');
    const guardrails = within(view).getByRole('region', { name: copy.versions.view.guardrails });
    // Guardrails, as the instructions and the tools already do: not changed, so the agent's own apply.
    expect(guardrails.textContent).toContain(copy.versions.view.ownGuardrails);
    expect(guardrails.textContent).not.toContain(copy.versions.view.noGuardrails);
    // Read-only is said once, in the line under the title, and not again in the note.
    expect(view.textContent?.match(/read-only/giu)).toHaveLength(1);
    expect(view.textContent).not.toContain('nothing here can be edited');

    // A version that did change the guardrails lists them.
    await fireEvent.click(within(view).getByRole('button', { name: copy.versions.view.back }));
    await fireEvent.click(await findByRole('button', { name: copy.versions.viewLabel(1) }));
    const first = await findByTestId('agent-version-view');
    const changed = within(first).getByRole('region', { name: copy.versions.view.guardrails });
    expect(changed.textContent).toContain('demo:no-secrets');
    expect(changed.textContent).not.toContain(copy.versions.view.ownGuardrails);
  });
});

describe('a plugin’s agent that cannot be changed here', () => {
  const RELEASE_HELPER = readyAgent({
    id: 'demo:release-helper',
    name: 'Release helper',
    description: 'Drafts release notes.',
    source: 'code',
    state: 'unavailable',
    unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
    hash: null,
    definition: null,
  });

  function serveUnavailable(): BureauStub {
    const stub = installBureauStub({
      // The list holds what can run, so it leaves the agent out.
      'bureau.agents.list': () => ({ agents: [] }),
      'bureau.agents.definitions.get': () => RELEASE_HELPER,
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
      'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
      'bureau.hooks.list': () => ({ hooks: [] }),
      'bureau.agents.catalog': () =>
        catalogFixture({
          models: [],
          tools: [
            { name: 'lookup-order', description: 'Looks an order up.', shortDescription: null },
          ],
        }),
      'bureau.guardrails.list': () => ({ guardrails: [] }),
      'bureau.skills.list': () => ({ skills: [], sources: [] }),
    });
    restores.push(stub.restore);
    return stub;
  }

  test('a ready agent that is a file of a running plugin is read-only on Settings and Access, and says the plugin ships it', async () => {
    const shipped = readyAgent({
      id: 'demo:release-helper',
      name: 'release-helper',
      description: 'Drafts release notes.',
      hash: 'plugin-file-hash',
    });
    for (const tab of ['settings', 'access'] as const) {
      landAt(`/agents/demo%3Arelease-helper/${tab}`);
      const stub = installBureauStub(
        {
          'bureau.agents.list': () => ({
            agents: [{ ...LISTING, name: 'demo:release-helper', displayName: 'Release helper' }],
          }),
          'bureau.agents.definitions.get': () => shipped,
          'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
          'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
          'bureau.hooks.list': () => ({ hooks: [] }),
          'bureau.agents.catalog': () =>
            catalogFixture({
              models: [],
              tools: [
                { name: 'lookup-order', description: 'Looks an order up.', shortDescription: null },
              ],
            }),
          'bureau.guardrails.list': () => ({ guardrails: [] }),
          'bureau.skills.list': () => ({ skills: [], sources: [] }),
        },
        { hostProviders: [{ name: 'anthropic', hasKey: true }] },
      );
      restores.push(stub.restore);
      const { findByTestId, queryByRole, container } = mount();

      const note = await findByTestId('agent-plugin-note');
      await waitFor(() => expect(note.textContent?.trim()).toContain('plugin ships this agent'));
      expect(note.getAttribute('data-mode')).toBe('read-only');
      expect(note.textContent).not.toContain('is disabled');
      expect(container.querySelector('textarea')).toBeNull();
      expect(queryByRole('button', { name: copy.settings.save })).toBeNull();
      expect(stub.callsTo('bureau.agents.overrides.get')).toHaveLength(0);
      cleanup();
    }
  });

  test('an unavailable agent’s Settings tab is read-only, says Plugin Demo is disabled, and keeps Duplicate in the header (COR-2229 AC2)', async () => {
    landAt('/agents/demo%3Arelease-helper/settings');
    const stub = serveUnavailable();
    const { findByRole, findByTestId, queryByRole, container } = mount();

    const note = await findByTestId('agent-plugin-note');
    expect(note.textContent).toContain('Plugin Demo is disabled');
    expect(note.getAttribute('data-mode')).toBe('unavailable');
    expect(container.querySelector('[data-testid="agent-settings-form"]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(queryByRole('button', { name: copy.settings.save })).toBeNull();
    expect(await findByRole('button', { name: copy.plugin.duplicate })).not.toBeNull();
    // Nothing is read for overrides, which the Bureau does not answer for an unavailable agent.
    expect(stub.callsTo('bureau.agents.overrides.get')).toHaveLength(0);
  });

  test('an unavailable agent’s Access tab is read-only with the same reason, every box off', async () => {
    landAt('/agents/demo%3Arelease-helper/access');
    serveUnavailable();
    const { findByTestId, container } = mount();

    const note = await findByTestId('agent-plugin-note');
    expect(note.textContent).toContain('Plugin Demo is disabled');
    await waitFor(() => {
      expect(container.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0);
    });
    for (const box of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(box.disabled).toBe(true);
    }
  });
});
