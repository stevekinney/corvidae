/**
 * The Access tab (COR-1853, redrawn by COR-2020: board PageAgent, rows 38l to 40c; board
 * ResponsiveAndDark, rows 07a and 07b): the tools an agent may call in groups by source, when each
 * asks first, the skills it may activate (COR-1975, sweep S65), the plugin guardrails and the spend
 * limit per chat. Each change saves at once as its own write, which sends the whole definition,
 * because an update that leaves out `tools` removes them, and names the hash the tab holds.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
import type { AgentDefinitionInput, ToolApproval } from '../../lib/agent-definitions.ts';
import type { Skill } from '../../lib/bureau-skills.ts';
import {
  catalogFixture,
  faults,
  readyAgent,
  StubFault,
} from '../../lib/bureau-stub.test-support.ts';
import { AGENT, bureau, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import {
  AgentAccessState,
  groupAccessRows,
  matchesAccessRow,
  RETIRED_GROUP,
  skillGrantLocked,
} from './agent-access-state.svelte.ts';
import AgentDetail from './agent-detail.svelte';

const copy = AGENT_PAGE_COPY.access;

let restore: (() => void) | undefined;
const monitors: ConnectionMonitor[] = [];
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
  for (const monitor of monitors.splice(0)) monitor.dispose();
});

const UPDATE = 'bureau.agents.definitions.update';
const updatesOf = (served: { calls: { method: string; params: Record<string, unknown> }[] }) =>
  served.calls.filter((call) => call.method === UPDATE);

const mount = (connection?: ConnectionMonitor) =>
  render(QueryPage, {
    props: { page: AgentDetail, ...(connection === undefined ? {} : { connection }) },
  } as never);

const FILE_AGENT = { ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' };

/** Three tools Bureau adds and one from a host server, as the board's sample has them. */
const TOOLS = [
  {
    name: 'lookup-order',
    description: 'Look an order up.',
    shortDescription: 'Looks an order up by its ID',
    tier: 'read-only' as const,
    defaultApproval: 'allow' as const,
    source: 'bureau' as const,
  },
  {
    name: 'issue-refund',
    description: 'Refund an order.',
    shortDescription: 'Refunds an order to the original card',
    tier: 'dangerous' as const,
    defaultApproval: 'ask' as const,
    source: 'bureau' as const,
  },
  {
    name: 'triage-refunds',
    description: 'Sort refund requests.',
    shortDescription: 'Sorts refund requests',
    tier: 'mutating' as const,
    defaultApproval: 'ask' as const,
    source: 'bureau' as const,
  },
  {
    name: 'github__list_issues',
    description: 'List the issues of a repository.',
    shortDescription: 'Lists issues',
    tier: null,
    defaultApproval: 'ask' as const,
    source: 'host' as const,
  },
];

const SKILLS = [
  {
    name: 'summarize',
    description: 'Summarizes a document.',
    source: { id: 'home', kind: 'user', location: '/skills/home', plugin: null },
    trust: 'trusted',
    trustReason: 'Listed in the configuration.',
    available: true,
    unavailableReason: null,
    allowedTools: [],
  },
  {
    name: 'deploy',
    description: 'Ships a build.',
    source: { id: 'workspace', kind: 'project', location: '/skills/workspace', plugin: null },
    trust: 'untrusted',
    trustReason: 'Not listed as trusted.',
    available: false,
    unavailableReason: 'source-untrusted',
    allowedTools: [],
  },
];

const GUARDRAILS = [
  {
    id: 'acme:pii-redaction',
    family: 'output',
    description: 'masks emails and card numbers in replies and tool inputs',
    configurable: false,
    configuration: null,
    source: 'plugin',
    plugin: 'acme',
  },
  // The same guardrail serves a second family; the tab lists it once.
  {
    id: 'acme:pii-redaction',
    family: 'input',
    description: 'masks emails and card numbers in replies and tool inputs',
    configurable: false,
    configuration: null,
    source: 'plugin',
    plugin: 'acme',
  },
  {
    id: 'acme:refund-cap',
    family: 'tools',
    description: 'blocks refunds over $100',
    configurable: false,
    configuration: null,
    source: 'plugin',
    plugin: 'acme',
  },
  // A memory guardrail guards the host's memory, and no agent file lists it.
  {
    id: 'acme:memory-scrub',
    family: 'memory',
    description: 'scrubs what is remembered',
    configurable: false,
    configuration: null,
    source: 'plugin',
    plugin: 'acme',
  },
];

type Answers = Parameters<typeof bureau>[0];

function detailWith(patch: Record<string, unknown> = {}) {
  const detail = readyAgent({ id: 'researcher' });
  if (detail.definition === null) throw new Error('expected a definition');
  return {
    ...detail,
    definition: { ...detail.definition, tools: ['lookup-order', 'issue-refund'], ...patch },
  };
}

function serve(extra: Answers = {}, detail = detailWith(), skills: unknown[] = SKILLS) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
    'bureau.agents.definitions.get': () => detail,
    'bureau.agents.catalog': () => catalogFixture({ tools: TOOLS }),
    'bureau.agents.versions.list': () => ({
      versions: [
        {
          revision: 5,
          hash: 'hash-2',
          savedAt: '2026-11-02T16:44:00.000Z',
          savedBy: null,
          definition: null,
          changedKeys: ['approvals'],
        },
      ],
    }),
    'bureau.guardrails.list': () => ({ guardrails: GUARDRAILS }),
    'bureau.skills.list': () => ({ revision: 1, skills, sources: [], trustLocked: null }),
    'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    ...extra,
  });
  restore = served.restore;
  return served;
}

/** The row of one tool, once the table has drawn it. */
async function rowOf(container: HTMLElement, tool: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
    if (found === null) throw new Error(`waiting for ${tool}`);
    return found;
  });
}

function selectOf(row: HTMLElement): HTMLSelectElement {
  const found = row.querySelector<HTMLSelectElement>('select');
  if (found === null) throw new Error('the row has no Asks select');
  return found;
}

describe('the tab', () => {
  test('is the Access tab, in the address, after Instructions', async () => {
    landAt('/agents/researcher/access');
    serve();
    const { findByRole, findByTestId } = mount();

    // A tab carries its count after its name once it is known ("Access 2"), so the names are read
    // as the first word of each tab.
    const tab = await findByRole('tab', { name: /^Access/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await findByTestId('agent-access');
    const tabs = [...document.querySelectorAll('[role="tab"]')].map(
      (tab) => tab.textContent.trim().split(/\s+/)[0],
    );
    expect(tabs).toEqual(['Chats', 'Instructions', 'Access', 'Hooks', 'Memory', 'Settings']);
  });

  test('says how many tools are allowed, once, and nothing about saving at rest (row 38l)', async () => {
    landAt('/agents/researcher/access');
    serve();
    const { container, findByTestId, queryByTestId } = mount();

    await rowOf(container, 'lookup-order');
    const awaited230 = await findByTestId('agent-access-count');
    expect(awaited230.textContent).toContain(copy.toolCount(2, 4));
    expect(queryByTestId('agent-access-saved')).toBeNull();
    expect(container.querySelector('.ib-access-row__saving')).toBeNull();
  });

  test('groups the tools by source, each header counting what it allows (row 38m)', async () => {
    landAt('/agents/researcher/access');
    serve();
    const { container } = mount();

    await rowOf(container, 'lookup-order');
    const headers = [...container.querySelectorAll<HTMLElement>('[data-group]')].map((header) =>
      header.getAttribute('data-group'),
    );
    expect(headers).toEqual(['bureau:', 'host:github', 'skills']);
    const builtIn = container.querySelector('[data-group="bureau:"]');
    expect(builtIn?.textContent).toContain('Built in');
    expect(builtIn?.textContent).toContain(copy.groupCount(2, 3));
    expect(container.querySelector('[data-group="host:github"]')?.textContent).toContain(
      copy.groupCount(0, 1),
    );
  });

  test('folds a group and opens it again', async () => {
    landAt('/agents/researcher/access');
    serve();
    const { container } = mount();

    await rowOf(container, 'lookup-order');
    const toggle = container.querySelector<HTMLButtonElement>('[data-group="bureau:"] button');
    if (toggle === null) throw new Error('expected the group’s toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.click(toggle);
    await waitFor(() =>
      expect(container.querySelector('[data-tool="lookup-order"]')?.outerHTML ?? null).toBeNull(),
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    await rowOf(container, 'lookup-order');
  });

  test('shows each tool’s name, identifier, line, risk word and Asks at its default (rows 38n to 38p)', async () => {
    landAt('/agents/researcher/access');
    serve();
    const { container, getByRole } = mount();

    const lookup = await rowOf(container, 'lookup-order');
    const refund = await rowOf(container, 'issue-refund');
    const triage = await rowOf(container, 'triage-refunds');
    expect(lookup.textContent).toContain('Lookup order');
    expect(lookup.querySelector('code')?.textContent).toBe('lookup-order');
    expect(lookup.textContent).toContain('Looks an order up by its ID');
    expect(lookup.querySelector('[data-testid="agent-access-risk"]')?.textContent).toBe('Reads');
    expect(refund.querySelector('[data-testid="agent-access-risk"]')?.textContent).toBe(
      'Dangerous',
    );
    // Risk is said in words, never in a coloured pill (sweep S32).
    expect(lookup.querySelector('.cinder-badge')).toBeNull();

    expect(selectOf(lookup).value).toBe('never');
    expect(selectOf(refund).value).toBe('always');
    expect(selectOf(triage).value).toBe('on-changes');
    const options = [...selectOf(refund).options].map((option) => option.text.trim());
    expect(options).toEqual(['Never', 'On changes', 'Always (default)', 'Blocked']);

    expect(getByRole('checkbox', { name: 'Allow Lookup order' })).toHaveProperty('checked', true);
    expect(getByRole('checkbox', { name: 'Allow Triage refunds' })).toHaveProperty(
      'checked',
      false,
    );
    // Asks is disabled while a tool is off.
    expect(selectOf(triage).disabled).toBe(true);
    expect(selectOf(lookup).disabled).toBe(false);
  });

  test('says an unclassified tool still asks under Never', async () => {
    landAt('/agents/researcher/access');
    serve(
      {},
      detailWith({
        tools: ['github__list_issues'],
        approvals: { github__list_issues: 'never' },
      }),
    );
    const { container } = mount();

    const issues = await rowOf(container, 'github__list_issues');
    expect(issues.textContent).toContain(copy.neverUnclassifiedHint);
  });
});

describe('a change', () => {
  test('saves at once as the whole definition, over the hash of the file as read (row 39j)', async () => {
    landAt('/agents/researcher/access');
    const served = serve({ [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) });
    const { container } = mount();

    await fireEvent.change(selectOf(await rowOf(container, 'issue-refund')), {
      target: { value: 'blocked' },
    });

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params).toMatchObject({
      id: 'researcher',
      expectedHash: 'hash-1',
      definition: {
        name: 'Researcher',
        model: 'anthropic/sonnet',
        tools: ['lookup-order', 'issue-refund'],
        approvals: { 'issue-refund': 'blocked' },
        instructions: 'You are a careful researcher.',
      },
    });
  });

  test('says which version it made beside the count (row 39h)', async () => {
    landAt('/agents/researcher/access');
    serve({ [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) });
    const { container, findByTestId } = mount();

    const refundsRow = await rowOf(container, 'triage-refunds');
    await fireEvent.click(refundsRow.querySelector('input[type="checkbox"]') as HTMLInputElement);

    const saved = await findByTestId('agent-access-saved');
    expect(saved.textContent).toContain(copy.saved(5));
    const awaited358 = await findByTestId('agent-access-count');
    expect(awaited358.textContent).toContain(copy.toolCount(3, 4));
  });

  test('moved off its default, drops the (default) mark, and is written (row 39i)', async () => {
    landAt('/agents/researcher/access');
    const served = serve(
      { [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) },
      detailWith({ tools: ['issue-refund', 'triage-refunds'] }),
    );
    const { container } = mount();

    const triage = await rowOf(container, 'triage-refunds');
    await fireEvent.change(selectOf(triage), { target: { value: 'always' } });

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({
      approvals: { 'triage-refunds': 'always' },
    });
    const shown = selectOf(container.querySelector('[data-tool="triage-refunds"]') as HTMLElement);
    expect(shown.value).toBe('always');
    expect(shown.options[shown.selectedIndex]?.text.trim()).toBe('Always');
  });

  test('writes nothing for On changes on a tool whose default it is, which a file says by saying nothing', async () => {
    landAt('/agents/researcher/access');
    const served = serve(
      { [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) },
      detailWith({
        tools: ['issue-refund', 'triage-refunds'],
        approvals: { 'triage-refunds': 'blocked' },
      }),
    );
    const { container } = mount();

    await fireEvent.change(selectOf(await rowOf(container, 'triage-refunds')), {
      target: { value: 'on-changes' },
    });

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({ approvals: null });
  });

  test('leaves the default effort and the step limit out of its write', async () => {
    landAt('/agents/researcher/access');
    const served = serve(
      { [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) },
      detailWith({ effort: 'high', limits: { steps: 9, cost: null, tools: { calls: 3 } } }),
    );
    const { container } = mount();

    await fireEvent.change(selectOf(await rowOf(container, 'lookup-order')), {
      target: { value: 'always' },
    });

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    const definition = updatesOf(served)[0]?.params['definition'] as Record<string, unknown>;
    // An update that omits `effort` keeps the file's; the editor owns the field.
    expect(definition).not.toHaveProperty('effort');
    expect(definition['limits']).toEqual({ cost: null });
  });

  test('drops a tool’s approval in the same write that withdraws the tool', async () => {
    landAt('/agents/researcher/access');
    const served = serve(
      { [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) },
      detailWith({ tools: ['lookup-order'], approvals: { 'lookup-order': 'always' } }),
    );
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'Allow Lookup order' }));

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({
      tools: [],
      approvals: null,
    });
  });

  test('that fails puts the row back and says so under it, with Try again (row 39k)', async () => {
    landAt('/agents/researcher/access');
    let fail = true;
    const served = serve({
      [UPDATE]: () => {
        if (fail) throw new StubFault('Internal', 500, 'The disk is full.');
        return { id: 'researcher', hash: 'hash-2' };
      },
    });
    const { container, findByRole } = mount();

    const refund = await rowOf(container, 'issue-refund');
    await fireEvent.change(selectOf(refund), { target: { value: 'never' } });

    const line = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-failed="issue-refund"]');
      if (found === null) throw new Error('waiting for the failure line');
      return found;
    });
    expect(line.textContent).toContain(copy.failed('Issue refund', 'Always'));
    await waitFor(() =>
      expect(
        selectOf(container.querySelector('[data-tool="issue-refund"]') as HTMLElement).value,
      ).toBe('always'),
    );

    fail = false;
    await fireEvent.click(await findByRole('button', { name: copy.retry }));
    await waitFor(() => expect(updatesOf(served)).toHaveLength(2));
    expect(updatesOf(served)[1]?.params['definition']).toMatchObject({
      approvals: { 'issue-refund': 'never' },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-failed="issue-refund"]')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('that the Bureau refuses says why above the table', async () => {
    landAt('/agents/researcher/access');
    serve({
      [UPDATE]: () => {
        throw new StubFault('Unprocessable', 422, 'The definition is not valid.');
      },
    });
    const { findByRole, findByText } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'Allow Triage refunds' }));

    await findByText('The definition is not valid.');
  });

  test('that is refused to the caller says they may not change the agent', async () => {
    landAt('/agents/researcher/access');
    serve({
      [UPDATE]: () => {
        throw new StubFault('Forbidden', 403, 'No.');
      },
    });
    const { findByRole, findByText } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'Allow Triage refunds' }));

    await findByText(copy.forbidden);
  });

  test('over a file that changed reads it again and shows it as it is now', async () => {
    landAt('/agents/researcher/access');
    let tools = ['lookup-order', 'issue-refund'];
    let hash = 'hash-1';
    serve({
      'bureau.agents.definitions.get': () => ({ ...detailWith({ tools }), hash }),
      [UPDATE]: () => {
        tools = ['lookup-order'];
        hash = 'hash-9';
        throw faults.stale('hash-9');
      },
    });
    const { findByRole, getByRole } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'Allow Triage refunds' }));

    // The file someone else wrote has Issue refund off; the tab shows that, not what it held.
    const checked = (name: string): boolean =>
      (getByRole('checkbox', { name }) as HTMLInputElement).checked;
    await waitFor(() => expect(checked('Allow Issue refund')).toBe(false));
    expect(checked('Allow Triage refunds')).toBe(false);
  });
});

describe('guardrails and spend', () => {
  test('lists the plugin guardrails once each as boxes, and saves one turned on (row 38r)', async () => {
    landAt('/agents/researcher/access');
    const served = serve({ [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) });
    const { container, findByRole, findByText } = mount();

    const pii = await findByRole('checkbox', { name: 'Pii redaction' });
    expect(container.querySelectorAll('[data-guardrail="acme:pii-redaction"]')).toHaveLength(1);
    expect(container.querySelector('[data-guardrail="acme:memory-scrub"]')).toBeNull();
    await findByText(copy.guardrailsNote);

    await fireEvent.click(pii);

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({
      guardrails: ['acme:pii-redaction'],
    });
  });

  test('keeps a guardrail the file lists that no plugin offers now, and lets it be turned off', async () => {
    landAt('/agents/researcher/access');
    serve({}, detailWith({ guardrails: ['gone:tripwire'] }));
    const { container, findByRole } = mount();

    const box = await findByRole('checkbox', { name: 'Tripwire' });
    expect(box).toHaveProperty('checked', true);
    expect(box).toHaveProperty('disabled', false);
    expect(container.querySelector('[data-guardrail="gone:tripwire"]')?.textContent).toContain(
      copy.guardrailMissing,
    );
  });

  test('saves a spend limit per chat when the field is left, on a run limit at the same amount', async () => {
    landAt('/agents/researcher/access');
    const served = serve({ [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) });
    const { findByLabelText } = mount();

    const spend = await findByLabelText(copy.spendLabel);
    expect(spend.getAttribute('placeholder')).toBe(copy.spendPlaceholder);
    await fireEvent.input(spend, { target: { value: '5' } });
    await fireEvent.change(spend);

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({
      limits: { cost: { run: 5, chat: 5 } },
    });
  });

  test('refuses an amount the Bureau would refuse, and sends nothing', async () => {
    landAt('/agents/researcher/access');
    const served = serve({ [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) });
    const { findByLabelText, findByText } = mount();

    const spend = await findByLabelText(copy.spendLabel);
    await fireEvent.input(spend, { target: { value: 'lots' } });
    await fireEvent.change(spend);

    await findByText(/Use an amount above 0/);
    expect(updatesOf(served)).toHaveLength(0);
  });
});

describe('the skills', () => {
  test('heads the group with the count and lists the file’s own skills first (row 38q, sweep S65)', async () => {
    landAt('/agents/researcher/access');
    serve();
    const { container, findByTestId } = mount();

    const skills = await findByTestId('agent-access-skills');
    await waitFor(() => expect(skills.querySelector('[data-skill="summarize"]')).not.toBeNull());
    // The file's card skill, then the two the host found.
    expect(skills.querySelector('[data-group="skills"]')?.textContent).toContain(
      copy.skillsTitle(3),
    );
    const rows = [...skills.querySelectorAll('[data-skill]')].map((row) =>
      row.getAttribute('data-skill'),
    );
    expect(rows).toEqual(['cite', 'summarize', 'deploy']);
    const own = skills.querySelector('[data-skill="cite"]');
    expect(own?.textContent).toContain(copy.definedInFile);
    expect(own?.querySelector('input[type="checkbox"]')).toHaveProperty('checked', true);
    expect(skills.querySelector('[data-skill="summarize"]')?.textContent).toContain(copy.skillAsks);
    // Skills are not counted with the tools.
    expect(container.querySelector('[data-testid="agent-access-count"]')?.textContent).toContain(
      copy.toolCount(2, 4),
    );
  });

  test('disables an untrusted skill and says why, so it cannot be granted', async () => {
    landAt('/agents/researcher/access');
    serve();
    const { container, findByRole } = mount();

    const box = await findByRole('checkbox', { name: 'Grant Deploy' });
    expect(box).toHaveProperty('disabled', true);
    expect(box).toHaveProperty('checked', false);
    const deploy = container.querySelector('[data-skill="deploy"]');
    expect(deploy?.getAttribute('data-trust')).toBe('untrusted');
    expect(deploy?.textContent).toContain('Its source is not trusted');
    expect(await findByRole('checkbox', { name: 'Grant Summarize' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  test('grants a skill at once, and keeps the file with no list until then', async () => {
    landAt('/agents/researcher/access');
    const served = serve({ [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) });
    const { findByRole } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'Grant Summarize' }));

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({ skills: ['summarize'] });
  });

  test('keeps a skill the host no longer lists, marked, until it is withdrawn', async () => {
    landAt('/agents/researcher/access');
    const served = serve(
      { [UPDATE]: () => ({ id: 'researcher', hash: 'hash-2' }) },
      detailWith({ skills: ['gone', 'summarize'] }),
      [],
    );
    const { container, findByRole } = mount();

    const gone = await findByRole('checkbox', { name: 'Grant gone' });
    expect(gone).toHaveProperty('checked', true);
    expect(container.querySelector('[data-skill="gone"]')?.textContent).toContain(
      copy.notInCatalog,
    );

    await fireEvent.click(gone);
    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({ skills: ['summarize'] });
  });

  test('a shadowed twin of an available skill has no box of its own to change', () => {
    const available = SKILLS[0] as unknown as Skill;
    const twin = { ...available, available: false, unavailableReason: 'shadowed' } as Skill;
    expect(skillGrantLocked(twin, [available, twin], true)).toBe(true);
    expect(skillGrantLocked(twin, [twin], true)).toBe(false);
    expect(skillGrantLocked(twin, [twin], false)).toBe(true);
    expect(skillGrantLocked(available, [available, twin], false)).toBe(false);
    // Whichever the catalog lists first, the available record keeps the box and its twin is the report.
    expect(skillGrantLocked(twin, [twin, available], true)).toBe(true);
    expect(skillGrantLocked(available, [twin, available], false)).toBe(false);
  });

  test('says the skills could not be loaded, with a retry', async () => {
    landAt('/agents/researcher/access');
    let fail = true;
    serve({
      'bureau.skills.list': () => {
        if (fail) throw new Error('down');
        return { revision: 1, skills: SKILLS, sources: [], trustLocked: null };
      },
    });
    const { findByRole, findByText } = mount();

    await findByText(copy.skillsLoadFailed);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await findByRole('checkbox', { name: 'Grant Summarize' });
  });
});

describe('the states', () => {
  test('says the host offers no tools, with the first-use kind', async () => {
    landAt('/agents/researcher/access');
    serve(
      { 'bureau.agents.catalog': () => catalogFixture({ tools: [] }) },
      detailWith({ tools: [] }),
    );
    const { container, findByText } = mount();

    await findByText(copy.noToolsTitle);
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  test('puts a tool the file lists and the host no longer offers in a group of its own', async () => {
    landAt('/agents/researcher/access');
    serve({}, detailWith({ tools: ['lookup-order', 'retired-tool'] }));
    const { container } = mount();

    const retired = await rowOf(container, 'retired-tool');
    expect(retired.querySelector('input[type="checkbox"]')).toHaveProperty('checked', true);
    expect(container.querySelector(`[data-group="${RETIRED_GROUP}"]`)?.textContent).toContain(
      copy.notInCatalogGroup,
    );
  });

  test('says the tab could not be loaded, with a retry that asks again', async () => {
    landAt('/agents/researcher/access');
    let fail = true;
    serve({
      'bureau.agents.catalog': () => {
        if (fail) throw new Error('down');
        return catalogFixture({ tools: TOOLS });
      },
    });
    const { container, findByText, findByRole } = mount();

    await findByText(copy.loadFailed);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    await rowOf(container, 'lookup-order');
  });

  test('says an agent whose file has a problem cannot have its access changed', async () => {
    landAt('/agents/researcher/access');
    serve({}, { ...detailWith(), state: 'invalid', definition: null } as never);
    const { findByText, queryByRole } = mount();

    await findByText(copy.invalid);
    expect(queryByRole('checkbox', { name: 'Allow Lookup order' })).toBeNull();
  });

  /** A built-in agent that states one tool, with `overrides` in force over it. */
  function serveBuiltIn(overrides: Record<string, unknown>) {
    return serve({
      'bureau.agents.list': () => ({ agents: [{ ...AGENT, name: 'assistant', kind: 'code' }] }),
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
          tools: ['lookup-order'],
          skills: [],
          card: [],
          instructions: null,
        },
        // A built-in agent reports nothing it would drop: its own policy is not on the wire.
        dropped: [],
      }),
      'bureau.agents.overrides.get': () => ({
        id: 'assistant',
        hash: 'hash-0',
        version: null,
        overrides,
        ownTools: ['lookup-order'],
      }),
      'bureau.agents.overrides.update': () => ({ id: 'assistant', hash: 'hash-1', version: 1 }),
    });
  }

  test('shows a built-in agent’s tools and holds them, with the Asks, because its own policy cannot be read (COR-2229)', async () => {
    landAt('/agents/assistant/access');
    const served = serveBuiltIn({});
    const { container, findByTestId } = mount();

    await findByTestId('agent-built-in');
    const lookup = await rowOf(container, 'lookup-order');
    const box = lookup.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(true);
    // An override of the tools rebuilds the run's toolbox with only the Asks it states, so a change
    // to the tools would drop the agent's own policy: the box is held as the select is.
    expect(box?.disabled).toBe(true);
    expect(selectOf(lookup).disabled).toBe(true);

    await fireEvent.click(box!);
    expect(
      served.calls.filter((call) => call.method === 'bureau.agents.overrides.update'),
    ).toHaveLength(0);
  });

  test('saves a change to a built-in agent’s tools as a version of its overrides once its Asks are overridden, not to a file (COR-2229)', async () => {
    landAt('/agents/assistant/access');
    const served = serveBuiltIn({ approvals: { 'lookup-order': 'always' } });
    const { container, findByTestId } = mount();

    await findByTestId('agent-built-in');
    const lookup = await rowOf(container, 'lookup-order');
    const box = lookup.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(true);
    expect(box?.disabled).toBe(false);
    expect(selectOf(lookup).disabled).toBe(false);

    await fireEvent.click(box!);

    await waitFor(() =>
      expect(
        served.calls.filter((call) => call.method === 'bureau.agents.overrides.update'),
      ).toHaveLength(1),
    );
    const [call] = served.calls.filter(
      (entry) => entry.method === 'bureau.agents.overrides.update',
    );
    expect(call?.params).toEqual({
      id: 'assistant',
      expectedHash: 'hash-0',
      // The withdrawn tool's Asks are left out of the write: the Bureau refuses one for a tool the agent may not use.
      overrides: { tools: [] },
    });
    expect(updatesOf(served)).toHaveLength(0);
  });

  test('shows an agent a disabled plugin ships read-only, with every tool off (row 39n)', async () => {
    landAt('/agents/demo%3Arelease-helper/access');
    serve({
      // The list holds what can run, so it leaves the agent out.
      'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
      'bureau.agents.definitions.get': () =>
        readyAgent({
          id: 'demo:release-helper',
          name: 'Release helper',
          source: 'code',
          state: 'unavailable',
          unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
          hash: null,
          definition: null,
        }),
      'bureau.hooks.list': () => ({ hooks: [] }),
    });
    const { container } = mount();

    const lookup = await rowOf(container, 'lookup-order');
    const box = lookup.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box?.checked).toBe(false);
    expect(box?.disabled).toBe(true);
    expect(selectOf(lookup).disabled).toBe(true);
    expect(container.querySelector('[data-group="bureau:"]')?.textContent).toContain(
      copy.groupCount(0, 3),
    );
  });

  test('while the server does not answer, says so and holds every change (rows 40b, 40c)', async () => {
    landAt('/agents/researcher/access');
    serve();
    const monitor = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      probeDelayMs: () => 60_000,
      browserOffline: false,
    });
    monitors.push(monitor);
    const { container, findByRole } = mount(monitor);

    const lookup = await rowOf(container, 'lookup-order');
    monitor.reportUnreachable();

    await waitFor(() =>
      expect(container.textContent).toContain('Can’t reach the Interborough server.'),
    );
    const box = await findByRole('checkbox', { name: 'Allow Lookup order' });
    await waitFor(() => expect(box.getAttribute('aria-disabled')).toBe('true'));
    // The old table stays: the row is still there, with its value.
    expect(selectOf(lookup).value).toBe('never');
    expect(selectOf(lookup).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the state', () => {
  const catalog = catalogFixture({ tools: TOOLS });

  /** A state over a writer the test answers by hand, one write at a time. */
  function stateWith(patch: Record<string, unknown> = {}) {
    const writes: {
      hash: string;
      definition: AgentDefinitionInput;
      answer: (hash: string) => void;
      fail: (error: unknown) => void;
    }[] = [];
    const state = AgentAccessState.from(
      detailWith(patch),
      catalog,
      (hash, definition) =>
        new Promise((resolve, reject) => {
          writes.push({
            hash,
            definition,
            answer: (next) => resolve({ hash: next }),
            fail: reject,
          });
        }),
    );
    if (state === undefined) throw new Error('expected a state');
    return { state, writes };
  }

  function allow(state: AgentAccessState, name: string, next: boolean) {
    return state.change({
      key: `tool:${name}`,
      subject: name,
      restored: next ? 'not allowed' : 'allowed',
      apply: () => state.setAllowed(name, next),
      undo: () => state.setAllowed(name, !next),
    });
  }

  /** Picks a tool's Asks level, as the row's select does. */
  function ask(state: AgentAccessState, name: string, next: ToolApproval) {
    const before = state.approvalOf(name);
    return state.change({
      key: `tool:${name}`,
      subject: name,
      restored: before,
      apply: () => state.setApproval(name, next),
      undo: () => state.setApproval(name, before),
    });
  }

  /** Applies a typed spend limit, as leaving the field does. */
  function spend(state: AgentAccessState, next: string) {
    const before = state.spendApplied;
    state.spendPerChat = next;
    return state.change({
      key: 'spend',
      subject: 'the spend limit',
      restored: before,
      apply: () => {
        state.spendPerChat = next;
        state.spendApplied = next;
      },
      undo: () => {
        state.spendPerChat = before;
        state.spendApplied = before;
      },
    });
  }

  test('marks a row saving until its write answers, and names the hash the last write returned', async () => {
    const { state, writes } = stateWith();
    const first = allow(state, 'triage-refunds', true);
    expect(state.saves.get('tool:triage-refunds')).toEqual({ kind: 'saving' });
    expect(state.busy).toBe(true);
    const second = allow(state, 'github__list_issues', true);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.hash).toBe('hash-1');
    writes[0]?.answer('hash-2');
    expect(await first).toEqual({ kind: 'saved', hash: 'hash-2' });
    // The first write already carried the second change, so nothing is written again.
    expect(await second).toEqual({ kind: 'unchanged' });
    expect(writes).toHaveLength(1);
    expect(state.hash).toBe('hash-2');
    expect(state.wrote('hash-2')).toBe(true);
    expect(state.wrote('hash-1')).toBe(true);
    expect(state.wrote('hash-3')).toBe(false);
    expect(state.saves.size).toBe(0);
    expect(state.busy).toBe(false);
  });

  test('writes a later change over the hash the earlier write returned', async () => {
    const { state, writes } = stateWith();
    const first = allow(state, 'triage-refunds', true);
    await waitFor(() => expect(writes).toHaveLength(1));
    const second = allow(state, 'github__list_issues', true);
    writes[0]?.answer('hash-2');
    await first;

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.hash).toBe('hash-2');
    expect(writes[1]?.definition.tools).toEqual([
      'lookup-order',
      'issue-refund',
      'triage-refunds',
      'github__list_issues',
    ]);
    writes[1]?.answer('hash-3');
    expect(await second).toEqual({ kind: 'saved', hash: 'hash-3' });
  });

  test('undoes a failed change, says what it went back to, and saves it again on retry', async () => {
    const { state, writes } = stateWith();
    const failed = allow(state, 'triage-refunds', true);
    await waitFor(() => expect(writes).toHaveLength(1));
    writes[0]?.fail(new Error('down'));

    const awaited948 = await failed;
    expect(awaited948.kind).toBe('failed');
    expect(state.isAllowed('triage-refunds')).toBe(false);
    const save = state.saves.get('tool:triage-refunds');
    if (save?.kind !== 'failed') throw new Error('expected a failed row');
    expect(save.restored).toBe('not allowed');

    save.retry();
    expect(state.isAllowed('triage-refunds')).toBe(true);
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]?.answer('hash-2');
    await waitFor(() => expect(state.saves.size).toBe(0));
  });

  test('restores a tool’s approval when it is withdrawn and allowed again', () => {
    const { state } = stateWith({ approvals: { 'lookup-order': 'blocked' } });
    state.setAllowed('lookup-order', false);
    expect(state.toDefinition().approvals).toBeNull();
    state.setAllowed('lookup-order', true);
    expect(state.approvalOf('lookup-order')).toBe('blocked');
    expect(state.toDefinition().approvals).toEqual({ 'lookup-order': 'blocked' });
  });

  test('reads a level the file leaves out as the tool’s own default', () => {
    const { state } = stateWith();
    expect(state.approvalOf('lookup-order')).toBe('never');
    expect(state.approvalOf('issue-refund')).toBe('always');
    expect(state.approvalOf('triage-refunds')).toBe('on-changes');
    // A file that says nothing runs a tool On changes, which Allow all and a remembered tool can
    // skip, so a dangerous tool's Always is written, and only On changes is left out.
    state.setApproval('issue-refund', 'always');
    expect(state.approvals.get('issue-refund')).toBe('always');
    state.setApproval('triage-refunds', 'always');
    state.setApproval('triage-refunds', 'on-changes');
    expect(state.approvals.has('triage-refunds')).toBe(false);
    state.setApproval('issue-refund', 'on-changes');
    expect(state.approvals.get('issue-refund')).toBe('on-changes');
  });

  test('writes the keys it does not edit as they were, and leaves out the ones it must not touch', () => {
    const { state } = stateWith({
      models: ['anthropic/haiku'],
      limits: { steps: 9, cost: { run: 2, warn: [0.5] }, tools: null },
    });
    state.spendApplied = '5';
    const written = state.toDefinition();
    expect(written).toMatchObject({
      models: ['anthropic/haiku'],
      limits: { cost: { run: 2, chat: 5, warn: [0.5] } },
    });
    // Left out, the Bureau keeps the file’s step limit and tool limits.
    expect(written.limits).not.toHaveProperty('steps');
    expect(written.limits).not.toHaveProperty('tools');
    state.spendApplied = '';
    expect(state.toDefinition().limits).toEqual({ cost: { run: 2, warn: [0.5] } });
    state.spendPerChat = 'lots';
    expect(state.spendLimit).toBeUndefined();
  });

  test('writes the spend limit as last applied, never an amount typed and refused', async () => {
    const { state, writes } = stateWith({
      limits: { steps: null, cost: { run: 10, chat: 5 }, tools: null },
    });
    // The field holds an amount the Bureau would refuse, which the tab does not apply.
    state.spendPerChat = 'abc';
    expect(state.spendLimit).toBeUndefined();
    const toggled = allow(state, 'triage-refunds', true);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.definition.limits).toEqual({ cost: { run: 10, chat: 5 } });
    writes[0]?.answer('hash-2');
    expect(await toggled).toEqual({ kind: 'saved', hash: 'hash-2' });
    expect(state.spendApplied).toBe('5');
  });

  test('a failed write leaves a later change of the same row in place, for its own write to carry', async () => {
    const { state, writes } = stateWith();
    expect(state.approvalOf('lookup-order')).toBe('never');
    const first = ask(state, 'lookup-order', 'always');
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.definition.approvals).toEqual({ 'lookup-order': 'always' });
    const second = ask(state, 'lookup-order', 'blocked');

    writes[0]?.fail(new Error('down'));
    const awaited1031 = await first;
    expect(awaited1031.kind).toBe('failed');
    // The later choice stands and still waits on its write: no failure line, no undo.
    expect(state.approvalOf('lookup-order')).toBe('blocked');
    expect(state.saves.get('tool:lookup-order')).toEqual({ kind: 'saving' });

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.definition.approvals).toEqual({ 'lookup-order': 'blocked' });
    writes[1]?.answer('hash-2');
    expect(await second).toEqual({ kind: 'saved', hash: 'hash-2' });
    expect(state.approvalOf('lookup-order')).toBe('blocked');
    expect(state.saves.size).toBe(0);
  });

  test('when both writes of one row fail, goes back to the value on disk and says so', async () => {
    const { state, writes } = stateWith();
    const first = ask(state, 'lookup-order', 'always');
    await waitFor(() => expect(writes).toHaveLength(1));
    const second = ask(state, 'lookup-order', 'blocked');

    writes[0]?.fail(new Error('down'));
    const awaited1051 = await first;
    expect(awaited1051.kind).toBe('failed');
    await waitFor(() => expect(writes).toHaveLength(2));
    writes[1]?.fail(new Error('down'));
    const awaited1054 = await second;
    expect(awaited1054.kind).toBe('failed');

    // Not Always, which the first change chose and no write saved.
    expect(state.approvalOf('lookup-order')).toBe('never');
    const save = state.saves.get('tool:lookup-order');
    if (save?.kind !== 'failed') throw new Error('expected a failed row');
    expect(save.restored).toBe('never');

    // A retry applies the latest choice; failing again, it goes back to the value on disk too.
    save.retry();
    expect(state.approvalOf('lookup-order')).toBe('blocked');
    await waitFor(() => expect(writes).toHaveLength(3));
    writes[2]?.fail(new Error('down'));
    await waitFor(() => expect(state.saves.get('tool:lookup-order')?.kind).toBe('failed'));
    expect(state.approvalOf('lookup-order')).toBe('never');
  });

  test('a failed spend limit leaves a later amount in place, and both failing go back to the first', async () => {
    const { state, writes } = stateWith({
      limits: { steps: null, cost: { run: 10, chat: 5 }, tools: null },
    });
    const first = spend(state, '7');
    await waitFor(() => expect(writes).toHaveLength(1));
    const second = spend(state, '9');

    writes[0]?.fail(new Error('down'));
    const awaited1080 = await first;
    expect(awaited1080.kind).toBe('failed');
    expect(state.spendApplied).toBe('9');
    expect(state.spendPerChat).toBe('9');

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.definition.limits).toEqual({ cost: { run: 10, chat: 9 } });
    writes[1]?.fail(new Error('down'));
    const awaited1087 = await second;
    expect(awaited1087.kind).toBe('failed');
    expect(state.spendApplied).toBe('5');
    expect(state.spendPerChat).toBe('5');
    const save = state.saves.get('spend');
    if (save?.kind !== 'failed') throw new Error('expected a failed row');
    expect(save.restored).toBe('5');
  });

  test('keeps a configured guardrail’s configuration (COR-2118)', () => {
    const configured = { id: 'acme:grounding', configuration: { threshold: 0.95 } };
    const { state } = stateWith({ guardrails: ['acme:pii', configured] });
    expect(state.guardrails).toEqual(['acme:pii', 'acme:grounding']);
    expect(state.toDefinition().guardrails).toEqual(['acme:pii', configured]);
    state.setGuardrail('acme:pii', false);
    expect(state.toDefinition().guardrails).toEqual([configured]);
  });

  test('is read-only for an agent with no file, and saves nothing', async () => {
    const state = AgentAccessState.from(
      {
        ...readyAgent(),
        source: 'code',
        hash: null,
        definition: null,
        codeDefinition: {
          name: 'assistant',
          description: null,
          model: null,
          models: [],
          tools: ['lookup-order'],
          skills: ['summarize'],
          card: [],
          instructions: null,
        },
      },
      catalog,
    );
    if (state === undefined) throw new Error('expected a state');
    expect(state.editable).toBe(false);
    expect(state.isAllowed('lookup-order')).toBe(true);
    expect(state.isGranted('summarize')).toBe(true);
    expect(await allow(state, 'issue-refund', true)).toEqual({ kind: 'unchanged' });
    expect(state.saves.size).toBe(0);
  });

  test('groups the rows Built in first, the other sources by name, and the retired last', () => {
    const state = AgentAccessState.from(detailWith({ tools: ['retired-tool'] }), catalog);
    if (state === undefined) throw new Error('expected a state');
    const groups = groupAccessRows(state.rows);
    expect(groups.map((group) => group.key)).toEqual(['bureau:', 'host:github', RETIRED_GROUP]);
    expect(groups[0]?.rows.map((row) => row.name)).toEqual([
      'lookup-order',
      'issue-refund',
      'triage-refunds',
    ]);
    const issues = groups[1]?.rows[0];
    if (issues === undefined) throw new Error('expected a row');
    expect(matchesAccessRow(issues, 'list iss')).toBe(true);
    expect(matchesAccessRow(issues, 'github__list')).toBe(true);
    expect(matchesAccessRow(issues, 'refund')).toBe(false);
  });
});
