/**
 * The Access tab (COR-1853): the tools an agent may call and when each asks first, the skills the
 * host found (read-only), the plugin guardrails and the budgets, and the one write that saves them.
 * The write sends the whole definition, because an update that leaves out `tools` removes them, and
 * it names the hash of the file the page read.
 */
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AGENT_PAGE_COPY } from '../../app/copy.ts';
import {
  catalogFixture,
  faults,
  readyAgent,
  StubFault,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import { AgentAccessState } from './agent-access-state.svelte.ts';
import AgentDetail from './agent-detail.svelte';

const copy = AGENT_PAGE_COPY.access;

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const UPDATE = 'bureau.agents.definitions.update';
const updatesOf = (served: { calls: { method: string; params: Record<string, unknown> }[] }) =>
  served.calls.filter((call) => call.method === UPDATE);

const mount = () => render(QueryPage, { props: { page: AgentDetail } } as never);

const FILE_AGENT = { ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' };

const TOOLS = [
  { name: 'lookup-order', description: 'Look an order up.', shortDescription: 'Looks up an order' },
  {
    name: 'issue-refund',
    description: 'Refund an order.',
    shortDescription: 'Refunds an order',
    tier: 'mutating' as const,
    defaultApproval: 'ask' as const,
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

type Answers = Parameters<typeof bureau>[0];

function detailWith(patch: Record<string, unknown> = {}) {
  const detail = readyAgent({ id: 'researcher' });
  if (detail.definition === null) throw new Error('expected a definition');
  return { ...detail, definition: { ...detail.definition, ...patch } };
}

function serve(extra: Answers = {}, detail = detailWith(), skills: unknown[] = SKILLS) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [FILE_AGENT] }),
    'bureau.agents.definitions.get': () => detail,
    'bureau.agents.catalog': () => catalogFixture({ tools: TOOLS }),
    'bureau.skills.list': () => ({ revision: 1, skills, sources: [], trustLocked: null }),
    'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    'bureau.memory.list': () => ({ memories: [], nextOffset: null }),
    ...extra,
  });
  restore = served.restore;
  return served;
}

describe('the tab', () => {
  test('is the Access tab, in the address, after Instructions', async () => {
    landAt('/agents/researcher?tab=access');
    serve();
    const { findByRole, findByTestId } = mount();

    const tab = await findByRole('tab', { name: 'Access' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await findByTestId('agent-access');
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) =>
      tab.textContent.trim(),
    );
    expect(tabs).toEqual(['Chats', 'Instructions', 'Access', 'Settings']);
  });

  test('lists each tool with its tier and, for an allowed tool, when it asks first', async () => {
    landAt('/agents/researcher?tab=access');
    serve();
    const { container, findByTestId, getByRole } = mount();

    const access = await findByTestId('agent-access');
    await waitFor(() =>
      expect(container.querySelector('[data-tool="lookup-order"]')).not.toBeNull(),
    );
    expect(access.textContent).toContain(copy.toolCount(1, 2));
    const lookup = container.querySelector('[data-tool="lookup-order"]');
    const refund = container.querySelector('[data-tool="issue-refund"]');
    expect(lookup?.textContent).toContain('Looks up an order');
    expect(refund?.textContent).toContain('Changes things');
    expect(getByRole('checkbox', { name: 'lookup-order' })).toHaveProperty('checked', true);
    expect(getByRole('checkbox', { name: 'issue-refund' })).toHaveProperty('checked', false);
    // A tool the agent may not call has no ask-first choice.
    expect(refund?.querySelector('select')).toBeNull();
    expect(lookup?.querySelector('select')).toHaveProperty('value', 'on-changes');
    const options = [...(lookup?.querySelectorAll('option') ?? [])].map((o) => o.textContent);
    expect(options).toEqual(['Never', 'On changes', 'Always', 'Blocked']);
  });

  test('saves a per-tool Always as the whole definition, over the hash of the file as read', async () => {
    landAt('/agents/researcher?tab=access');
    const served = serve({
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
    });
    const { container, findByRole } = mount();

    const save = await findByRole('button', { name: copy.saveAction });
    expect(save.hasAttribute('data-changes')).toBe(true);
    expect(save).toHaveProperty('disabled', true);
    const select = await waitFor(() => {
      const found = container.querySelector<HTMLSelectElement>('[data-tool="lookup-order"] select');
      if (found === null) throw new Error('waiting for the tool');
      return found;
    });
    await fireEvent.change(select, { target: { value: 'always' } });
    await waitFor(() => expect(save).toHaveProperty('disabled', false));
    await fireEvent.click(save);

    await waitFor(() => expect(updatesOf(served).length > 0).toBe(true));
    const sent = updatesOf(served)[0]?.params;
    expect(sent).toMatchObject({
      id: 'researcher',
      expectedHash: 'hash-1',
      definition: {
        name: 'Researcher',
        model: 'anthropic/sonnet',
        tools: ['lookup-order'],
        toolApproval: { 'lookup-order': 'always' },
        instructions: 'You are a careful researcher.',
      },
    });
  });

  test('drops a tool’s approval in the same write that withdraws the tool', async () => {
    landAt('/agents/researcher?tab=access');
    const served = serve(
      { 'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }) },
      detailWith({ toolApproval: { 'lookup-order': 'always' } }),
    );
    const { findByRole, getByRole } = mount();

    const box = await findByRole('checkbox', { name: 'lookup-order' });
    await fireEvent.click(box);
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    const definition = updatesOf(served)[0]?.params['definition'];
    expect(definition).toMatchObject({ tools: [], toolApproval: null });
  });

  test('saves the budgets and refuses a number the Bureau would refuse', async () => {
    landAt('/agents/researcher?tab=access');
    const served = serve({
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
    });
    const { findByLabelText, getByRole } = mount();

    const calls = await findByLabelText('Tool calls per run');
    await fireEvent.input(calls, { target: { value: '2.5' } });
    expect(getByRole('button', { name: copy.saveAction })).toHaveProperty('disabled', true);
    await fireEvent.input(calls, { target: { value: '3' } });
    await fireEvent.input(await findByLabelText('Spend per run (USD)'), {
      target: { value: '0.5' },
    });
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await waitFor(() => expect(updatesOf(served).length > 0).toBe(true));
    const definition = updatesOf(served)[0]?.params['definition'];
    expect(definition).toMatchObject({
      costBudget: { perRunUsd: 0.5 },
      toolBudget: { maxCalls: 3 },
    });
  });

  test('says the file changed, and reloads it, when the write is stale', async () => {
    landAt('/agents/researcher?tab=access');
    let reads = 0;
    const served = serve({
      'bureau.agents.definitions.get': () => {
        reads += 1;
        return detailWith();
      },
      'bureau.agents.definitions.update': () => {
        throw faults.stale('hash-2');
      },
    });
    const { findByRole, findByText, getByRole } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'issue-refund' }));
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await findByText(copy.stale);
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(updatesOf(served).length > 0).toBe(true);
  });

  test('keeps a dirty form, says the file changed, and reloads on request, when the write is stale', async () => {
    landAt('/agents/researcher?tab=access');
    let hash = 'hash-1';
    serve({
      'bureau.agents.definitions.get': () => ({ ...detailWith(), hash }),
      'bureau.agents.definitions.update': () => {
        hash = 'hash-2';
        throw faults.stale('hash-2');
      },
    });
    const { findByRole, findByText, getByRole } = mount();

    const refund = await findByRole('checkbox', { name: 'issue-refund' });
    await fireEvent.click(refund);
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await findByText(copy.stale);
    // The refetch has read the new hash, and the form still holds what was ticked.
    await waitFor(() => expect(hash).toBe('hash-2'));
    expect(getByRole('checkbox', { name: 'issue-refund' })).toHaveProperty('checked', true);
    expect(getByRole('button', { name: copy.saveAction })).toHaveProperty('disabled', false);

    await fireEvent.click(getByRole('button', { name: copy.reload }));
    await waitFor(() =>
      expect(getByRole('checkbox', { name: 'issue-refund' })).toHaveProperty('checked', false),
    );
    expect(getByRole('button', { name: copy.saveAction })).toHaveProperty('disabled', true);
  });

  test('says the file could not be read when a reload fails', async () => {
    landAt('/agents/researcher?tab=access');
    let failReads = false;
    serve({
      'bureau.agents.definitions.get': () => {
        if (failReads) throw new Error('down');
        return detailWith();
      },
      'bureau.agents.definitions.update': () => {
        throw faults.stale('hash-2');
      },
    });
    const { findByRole, findByText, getByRole } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'issue-refund' }));
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));
    await findByText(copy.stale);
    failReads = true;
    await fireEvent.click(getByRole('button', { name: copy.reload }));

    await findByText(copy.loadFailed);
  });

  test('keeps a dirty form when coming back to the window reads a file with a new hash', async () => {
    landAt('/agents/researcher?tab=access');
    let hash = 'hash-1';
    let reads = 0;
    serve({
      'bureau.agents.definitions.get': () => {
        reads += 1;
        return { ...detailWith(), hash };
      },
    });
    const { findByRole, findByText, getByRole, queryByText } = mount();

    await fireEvent.change(await findByRole('combobox', { name: /lookup-order/ }), {
      target: { value: 'blocked' },
    });
    expect(queryByText(copy.stale)?.outerHTML ?? null).toBeNull();

    hash = 'hash-2';
    const before = reads;
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await findByText(copy.stale);
    expect(getByRole('combobox', { name: /lookup-order/ })).toHaveProperty('value', 'blocked');
    expect(getByRole('button', { name: copy.saveAction })).toHaveProperty('disabled', false);
  });

  test('rebuilds a form with no edits when the file’s hash changes', async () => {
    landAt('/agents/researcher?tab=access');
    let hash = 'hash-1';
    let tools = ['lookup-order'];
    let reads = 0;
    serve({
      'bureau.agents.definitions.get': () => {
        reads += 1;
        return { ...detailWith({ tools }), hash };
      },
    });
    const { findByRole, getByRole, queryByText } = mount();

    await findByRole('checkbox', { name: 'issue-refund' });
    hash = 'hash-2';
    tools = ['lookup-order', 'issue-refund'];
    const before = reads;
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await waitFor(() =>
      expect(getByRole('checkbox', { name: 'issue-refund' })).toHaveProperty('checked', true),
    );
    expect(queryByText(copy.stale)?.outerHTML ?? null).toBeNull();
  });

  test('rebuilds from the hash a save returned, without calling it a change', async () => {
    landAt('/agents/researcher?tab=access');
    let hash = 'hash-1';
    let tools = ['lookup-order'];
    const served = serve({
      'bureau.agents.definitions.get': () => ({ ...detailWith({ tools }), hash }),
      'bureau.agents.definitions.update': () => {
        hash = 'hash-2';
        tools = ['lookup-order', 'issue-refund'];
        return { id: 'researcher', hash: 'hash-2' };
      },
    });
    const { findByRole, getByRole, queryByText } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'issue-refund' }));
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    await waitFor(() =>
      expect(getByRole('button', { name: copy.saveAction })).toHaveProperty('disabled', true),
    );
    expect(queryByText(copy.stale)?.outerHTML ?? null).toBeNull();
    expect(getByRole('checkbox', { name: 'issue-refund' })).toHaveProperty('checked', true);
  });

  test('restores a tool’s approval when it is withdrawn and allowed again', async () => {
    landAt('/agents/researcher?tab=access');
    const served = serve(
      { 'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }) },
      detailWith({ toolApproval: { 'lookup-order': 'blocked' } }),
    );
    const { container, findByRole, getByRole } = mount();

    const box = await findByRole('checkbox', { name: 'lookup-order' });
    await fireEvent.click(box);
    await fireEvent.click(box);
    expect(container.querySelector('[data-tool="lookup-order"] select')).toHaveProperty(
      'value',
      'blocked',
    );
    // Nothing differs from the file, so there is nothing to save, and nothing loosened.
    expect(getByRole('button', { name: copy.saveAction })).toHaveProperty('disabled', true);

    await fireEvent.click(await findByRole('checkbox', { name: 'issue-refund' }));
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));
    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({
      tools: ['lookup-order', 'issue-refund'],
      toolApproval: { 'lookup-order': 'blocked' },
    });
  });

  test('saves the guardrails, the chat limit and the tool time as typed', async () => {
    landAt('/agents/researcher?tab=access');
    const served = serve({
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
    });
    const { findByLabelText, findByRole, getByRole } = mount();

    await fireEvent.input(await findByRole('textbox', { name: 'Guardrails' }), {
      target: { value: 'acme:pii\nacme:tripwire' },
    });
    await fireEvent.input(await findByLabelText('Spend per run (USD)'), {
      target: { value: '2' },
    });
    await fireEvent.input(await findByLabelText('Spend per chat (USD)'), {
      target: { value: '9' },
    });
    await fireEvent.input(await findByLabelText('Tool time per run (seconds)'), {
      target: { value: '30' },
    });
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await waitFor(() => expect(updatesOf(served)).toHaveLength(1));
    expect(updatesOf(served)[0]?.params['definition']).toMatchObject({
      guardrails: ['acme:pii', 'acme:tripwire'],
      costBudget: { perRunUsd: 2, perChatUsd: 9 },
      toolBudget: { maxDurationSeconds: 30 },
    });
  });

  for (const [name, fault, message] of [
    ['an agent that is gone', faults.notFound('researcher'), copy.saveFailed],
    ['a caller who may not change it', new StubFault('Forbidden', 403, 'No.'), copy.forbidden],
  ] as const) {
    test(`says why the write failed: ${name}`, async () => {
      landAt('/agents/researcher?tab=access');
      serve({
        'bureau.agents.definitions.update': () => {
          throw fault;
        },
      });
      const { findByRole, findByText, getByRole } = mount();

      await fireEvent.click(await findByRole('checkbox', { name: 'issue-refund' }));
      await fireEvent.click(getByRole('button', { name: copy.saveAction }));

      await findByText(message);
    });
  }

  test('dismisses a refusal', async () => {
    landAt('/agents/researcher?tab=access');
    serve({
      'bureau.agents.definitions.update': () => {
        throw new StubFault('Unprocessable', 422, 'The budget is not valid.');
      },
    });
    const { findByRole, findByText, getByRole, queryByText } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'issue-refund' }));
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));
    await findByText('The budget is not valid.');
    await fireEvent.click(getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(queryByText('The budget is not valid.')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('says why when the Bureau refuses the write', async () => {
    landAt('/agents/researcher?tab=access');
    serve({
      'bureau.agents.definitions.update': () => {
        throw new StubFault('Unprocessable', 422, 'The budget is not valid.');
      },
    });
    const { findByRole, findByText, getByRole } = mount();

    await fireEvent.click(await findByRole('checkbox', { name: 'issue-refund' }));
    await fireEvent.click(getByRole('button', { name: copy.saveAction }));

    await findByText('The budget is not valid.');
  });
});

describe('the skills', () => {
  test('lists a skill from an untrusted source as not trusted, with no way to grant it', async () => {
    landAt('/agents/researcher?tab=access');
    serve();
    const { container, findByText } = mount();

    await findByText('deploy');
    const deploy = container.querySelector('[data-skill="deploy"]');
    expect(deploy?.getAttribute('data-trust')).toBe('untrusted');
    expect(deploy?.textContent).toContain('Not trusted');
    expect(deploy?.textContent).toContain('Its source is not trusted');
    expect(deploy?.querySelector('input, select, button')).toBeNull();
    expect(container.querySelector('[data-skill="summarize"]')?.textContent).toContain('Trusted');
  });

  test('says there are none, with the way to the skills, and that they could not be loaded', async () => {
    landAt('/agents/researcher?tab=access');
    serve({}, detailWith(), []);
    const { container, findByText, findByRole } = mount();

    await findByText(copy.noSkillsTitle);
    expect(
      container.querySelector('[data-testid="agent-access-skills"] [data-cinder-kind="first-use"]'),
    ).not.toBeNull();
    const link = await findByRole('link', { name: copy.noSkillsAction });
    expect(link.getAttribute('href')).toContain('/capabilities?tab=skills');
  });

  test('opens the skills page from the empty state', async () => {
    landAt('/agents/researcher?tab=access');
    serve({}, detailWith(), []);
    const { findByRole } = mount();

    const link = await findByRole('link', { name: copy.noSkillsAction });
    // A modified click is the browser's (a new tab), so the page leaves it alone.
    link.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await fireEvent.click(link, { metaKey: true });
    expect(router.pathname).toBe('/agents/researcher');
    link.click();
    expect(router.pathname).toBe('/capabilities');
  });

  test('says the skills could not be loaded, with a retry', async () => {
    landAt('/agents/researcher?tab=access');
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
    await findByText('deploy');
  });
});

describe('the states', () => {
  test('says the host offers no tools, with the first-use kind', async () => {
    landAt('/agents/researcher?tab=access');
    serve(
      { 'bureau.agents.catalog': () => catalogFixture({ tools: [] }) },
      detailWith({ tools: [] }),
    );
    const { container, findByText } = mount();

    await findByText(copy.noToolsTitle);
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  test('marks a tool the file lists and the host no longer offers, and lets it be withdrawn', async () => {
    landAt('/agents/researcher?tab=access');
    serve({}, detailWith({ tools: ['lookup-order', 'retired-tool'] }));
    const { container, findByText } = mount();

    await findByText(copy.notInCatalog);
    expect(
      container.querySelector('[data-tool="retired-tool"] input[type="checkbox"]'),
    ).toHaveProperty('checked', true);
  });

  test('says the tab could not be loaded, with a retry that asks again', async () => {
    landAt('/agents/researcher?tab=access');
    let fail = true;
    serve({
      'bureau.agents.catalog': () => {
        if (fail) throw new Error('down');
        return catalogFixture({ tools: TOOLS });
      },
    });
    const { findByText, findByRole } = mount();

    await findByText(copy.loadFailed);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));

    await findByRole('button', { name: copy.saveAction });
  });

  test('says an agent whose file has a problem cannot have its access changed', async () => {
    landAt('/agents/researcher?tab=access');
    serve({}, { ...detailWith(), state: 'invalid', definition: null } as never);
    const { findByText, queryByRole } = mount();

    await findByText(copy.invalid);
    expect(queryByRole('button', { name: copy.saveAction })).toBeNull();
  });

  test('says an agent in code states no tools', async () => {
    landAt('/agents/assistant?tab=access');
    serve({
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
          tools: [],
          skills: [],
          skillDescriptors: [],
          instructions: null,
        },
      }),
    });
    const { container, findByText } = mount();

    await findByText(copy.noToolsTitle);
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  test('shows an agent in code read-only, with the tools it states and no save', async () => {
    landAt('/agents/assistant?tab=access');
    serve({
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
          skillDescriptors: [],
          instructions: null,
        },
      }),
    });
    const { findByTestId, queryByRole, findByText } = mount();

    await findByTestId('agent-built-in');
    await findByText('lookup-order');
    expect(queryByRole('button', { name: copy.saveAction })).toBeNull();
    expect(queryByRole('checkbox')).toBeNull();
  });
});

describe('the form state', () => {
  const catalog = catalogFixture({ tools: TOOLS });

  function formOf(patch: Record<string, unknown> = {}) {
    const state = AgentAccessState.from(detailWith(patch), catalog);
    if (state === undefined) throw new Error('expected a form');
    return state;
  }

  test('has no form for an agent without a file', () => {
    expect(
      AgentAccessState.from({ ...readyAgent(), source: 'code', definition: null }, catalog),
    ).toBeUndefined();
  });

  test('is clean until something changes, and clean again when the change is undone', () => {
    const form = formOf();
    expect(form.dirty).toBe(false);
    form.setApproval('lookup-order', 'blocked');
    expect(form.dirty).toBe(true);
    expect(form.canSave).toBe(true);
    form.setApproval('lookup-order', 'on-changes');
    expect(form.dirty).toBe(false);
  });

  test('writes the keys it does not edit as they were, and leaves out the ones it must not touch', () => {
    const form = formOf({
      models: ['anthropic/haiku'],
      costBudget: { perRunUsd: 2, warnAt: [0.5] },
      stepLimit: 9,
    });
    form.spendPerChat = '5';
    const written = form.toDefinition();
    expect(written).toMatchObject({
      models: ['anthropic/haiku'],
      costBudget: { perRunUsd: 2, perChatUsd: 5, warnAt: [0.5] },
    });
    // Left out, the Bureau keeps the file’s step limit.
    expect('stepLimit' in written).toBe(false);
  });

  test('allows a tool after the ones the file lists, and counts what the host offers', () => {
    const form = formOf();
    form.setAllowed('issue-refund', true);
    expect(form.toDefinition().tools).toEqual(['lookup-order', 'issue-refund']);
    expect(form.offeredCount).toBe(2);
    expect(form.allowedCount).toBe(2);
    form.setAllowed('issue-refund', true);
    expect(form.tools).toEqual(['lookup-order', 'issue-refund']);
  });

  test('refuses a chat limit with no run limit, and a guardrail that is not plugin:name', () => {
    const form = formOf();
    form.spendPerChat = '4';
    form.guardrails = 'tripwire';
    expect(Object.keys(form.limitErrors).toSorted()).toEqual(['guardrails', 'spendPerChat']);
    expect(form.canSave).toBe(false);
  });
});
