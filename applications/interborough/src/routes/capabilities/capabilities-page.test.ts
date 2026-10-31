/**
 * The Capabilities page: the tools of the catalog and the executable skills as a list with the open
 * item beside it, their empty states, and the tab in the address.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { CAPABILITIES_COPY } from '../../app/copy.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import CapabilitiesPage from './index.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: CapabilitiesPage } } as never);

const TOOLS = [
  {
    name: 'read-file',
    description: 'Reads a file from disk.',
    shortDescription: 'Reads one file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Where the file is.' } },
      required: ['path'],
    },
    tier: 'read-only',
    defaultApproval: 'allow',
    source: 'host',
    users: ['assistant'],
  },
  {
    name: 'run-shell',
    description: 'Runs a shell command.',
    shortDescription: null,
    inputSchema: null,
    tier: null,
    defaultApproval: 'ask',
    source: 'bureau',
    users: [],
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
    allowedTools: ['read-file'],
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

function codeDetail(id: string, skills: string[]) {
  return {
    id,
    source: 'code',
    state: 'ready',
    name: id,
    description: null,
    a2a: false,
    hash: null,
    problem: null,
    definition: null,
    codeDefinition: {
      name: id,
      description: null,
      model: null,
      models: [],
      tools: [],
      skills,
      skillDescriptors: [],
      instructions: null,
    },
  };
}

function serve(tools: unknown[] = TOOLS, skills: unknown[] = SKILLS) {
  return bureau({
    'bureau.agents.catalog': () => ({ models: [], tools }),
    'bureau.skills.list': () => ({ revision: 1, skills, sources: [], trustLocked: null }),
    'bureau.agents.list': () => ({ agents: [AGENT] }),
    'bureau.agents.definitions.get': (params) => codeDetail(String(params['id']), ['summarize']),
  });
}

const copy = CAPABILITIES_COPY;

describe('the Tools tab', () => {
  test('lists every tool with its tier, and shows the open tool’s details, inputs and users', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, findByText, getByRole } = mount();

    await findByText('read-file');
    expect(container.querySelector('[data-testid="tools-count"]')?.textContent?.trim()).toBe('2');
    const row = (name: string) => container.querySelector(`[data-tool-row="${name}"]`);
    expect(row('read-file')?.textContent).toContain('Reads only');
    expect(row('read-file')?.textContent).toContain('Reads one file');
    // A tool that declares no tier is not classified, which is never read as read-only.
    expect(row('run-shell')?.textContent).toContain('Not classified');
    expect(row('run-shell')?.textContent).toContain('Runs a shell command.');

    await fireEvent.click(row('read-file')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="tool-detail"]')).not.toBeNull(),
    );
    const detail = container.querySelector('[data-testid="tool-detail"]')!;
    expect(detail.getAttribute('data-tool')).toBe('read-file');
    expect(detail.textContent).toContain('Reads a file from disk.');
    expect(detail.querySelector('[data-testid="tool-approval"]')?.textContent).toBe(
      'Runs without asking',
    );
    expect(detail.querySelector('[data-testid="tool-source"]')?.textContent).toBe(
      'Provided by this host',
    );
    expect(detail.querySelector('[data-testid="tool-input-schema"]')?.textContent).toContain(
      'Path',
    );
    expect(detail.querySelector('[data-testid="tool-input-schema"]')?.textContent).toContain(
      'Where the file is.',
    );
    expect(getByRole('link', { name: 'assistant' }).getAttribute('href')).toBe('/agents/assistant');
    // The open tool is in the address, and the router has read it back.
    expect(router.search.get('tool')).toBe('read-file');

    // A user opens its page in the application; a modified click is left to the browser.
    await fireEvent.click(getByRole('link', { name: 'assistant' }), { ctrlKey: true });
    expect(router.pathname).toBe('/capabilities');
    await fireEvent.click(getByRole('link', { name: 'assistant' }));
    expect(router.pathname).toBe('/agents/assistant');
  });

  test('says a tool no agent uses with the action that gives it a user, and a tool without a described input in words', async () => {
    restore = serve().restore;
    landAt('/capabilities?tool=run-shell');
    const { container, findByText } = mount();

    const detail = await waitFor(() => {
      const found = container.querySelector('[data-testid="tool-detail"]');
      if (found === null) throw new Error('the tool is not open yet');
      return found;
    });
    await findByText(copy.tool.noUsers.title);
    const empty = detail.querySelector('[data-testid="capability-users"] [data-cinder-kind]');
    expect(empty?.getAttribute('data-cinder-kind')).toBe('first-use');
    expect(
      detail.querySelector(`a[href="${copy.tool.noUsers.action.href}"]`)?.textContent,
    ).toContain(copy.tool.noUsers.action.label);
    expect(detail.querySelector('[data-testid="tool-input-schema"]')?.textContent).toContain(
      copy.tool.noSchema,
    );
    expect(detail.querySelector('[data-testid="tool-approval"]')?.textContent).toBe(
      'Asks you first',
    );
    expect(detail.textContent).not.toMatch(/\bNone\b/);
  });

  test('filters by name, says so when nothing matches, and clears the filter', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, findByText, getByRole, findByRole } = mount();
    await findByText('read-file');

    await fireEvent.input(getByRole('searchbox', { name: copy.filterLabel.tools }), {
      target: { value: 'nothing-like-this' },
    });
    await findByText(copy.tool.filtered.title);
    const empty = container.querySelector('[data-cinder-kind="filtered"]');
    expect(empty).not.toBeNull();
    expect(container.querySelector('[data-testid="tools-count"]')?.textContent?.trim()).toBe(
      '0 of 2',
    );

    await fireEvent.click(await findByRole('button', { name: copy.tool.filtered.clear }));
    await findByText('read-file');
    expect(container.querySelector('[data-testid="tools-count"]')?.textContent?.trim()).toBe('2');
  });

  test('is a first-use empty state, with no list, when the catalog holds no tool', async () => {
    restore = serve([]).restore;
    landAt('/capabilities');
    const { container, findByText } = mount();
    await findByText(copy.tool.empty.title);
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tools-count"]')).toBeNull();
  });

  test('says the tools could not be read, and reads them again on Try again', async () => {
    let fail = true;
    restore = bureau({
      'bureau.agents.catalog': () => {
        if (fail) throw new Error('down');
        return { models: [], tools: TOOLS };
      },
    }).restore;
    landAt('/capabilities');
    const { findByText, findByRole } = mount();
    await findByText(copy.tool.loadFailed.title);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await findByText('read-file');
  });
});

describe('the Skills tab', () => {
  test('marks a skill whose source is not trusted, in its row and its details, and says why it is refused', async () => {
    restore = serve().restore;
    landAt('/capabilities?tab=skills&skill=workspace%2Fdeploy');
    const { container, findByText } = mount();

    await findByText('summarize');
    const row = (name: string) => container.querySelector(`[data-skill-row="${name}"]`);
    expect(row('deploy')?.getAttribute('data-trust')).toBe('untrusted');
    expect(row('deploy')?.textContent).toContain(copy.skill.untrustedBadge);
    expect(row('summarize')?.textContent).not.toContain(copy.skill.untrustedBadge);

    const detail = await waitFor(() => {
      const found = container.querySelector('[data-testid="skill-detail"]');
      if (found === null) throw new Error('the skill is not open yet');
      return found;
    });
    expect(detail.getAttribute('data-skill')).toBe('deploy');
    expect(detail.getAttribute('data-trust')).toBe('untrusted');
    expect(detail.querySelector('[data-testid="skill-trust"]')?.textContent).toContain(
      'Not trusted',
    );
    expect(detail.querySelector('[data-testid="skill-unavailable"]')?.textContent).toContain(
      copy.skill.unavailable['source-untrusted'],
    );
    expect(detail.querySelector('[data-testid="skill-source"]')?.textContent).toContain(
      '/skills/workspace',
    );
    // A skill that asks to keep no tool has no such row.
    expect(detail.textContent).not.toContain(copy.skill.allowedTools);
  });

  test('shows a trusted skill’s users, read from the agents defined in code, and the tools it asks to keep', async () => {
    restore = serve().restore;
    landAt('/capabilities?tab=skills&skill=home%2Fsummarize');
    const { container, findByRole } = mount();

    const link = await findByRole('link', { name: 'assistant' });
    expect(link.getAttribute('href')).toBe('/agents/assistant');
    const detail = container.querySelector('[data-testid="skill-detail"]')!;
    expect(detail.querySelector('[data-testid="skill-unavailable"]')).toBeNull();
    expect(detail.querySelector('[data-testid="skill-trust"]')?.textContent).toContain('Trusted');
    expect(detail.querySelector('[data-testid="skill-allowed-tools"]')?.textContent).toContain(
      'read-file',
    );
  });

  test('says which agents use a skill could not be read, rather than that none do', async () => {
    restore = bureau({
      'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
      'bureau.skills.list': () => ({ revision: 1, skills: SKILLS, sources: [], trustLocked: null }),
      'bureau.agents.list': () => {
        throw new Error('down');
      },
    }).restore;
    landAt('/capabilities?tab=skills&skill=home%2Fsummarize');
    const { findByText, container } = mount();
    await findByText(copy.skill.usersFailed);
    expect(container.textContent).not.toContain(copy.skill.noUsers.title);
  });

  test('marks an unavailable skill of a trusted source in its row', async () => {
    const broken = { ...SKILLS[0], name: 'broken', available: false, unavailableReason: 'invalid' };
    restore = serve(TOOLS, [SKILLS[0], broken]).restore;
    landAt('/capabilities?tab=skills');
    const { container, findByText } = mount();
    await findByText('broken');
    const row = (name: string) => container.querySelector(`[data-skill-row="${name}"]`);
    expect(row('broken')?.textContent).toContain(copy.skill.unavailableBadge);
    expect(row('summarize')?.textContent).not.toContain(copy.skill.unavailableBadge);
  });

  test('shows no users while they are pending, and none for a shadowed skill', async () => {
    const shadowed = {
      ...SKILLS[0],
      source: { id: 'other', kind: 'user', location: '/skills/other', plugin: null },
      available: false,
      unavailableReason: 'shadowed',
    };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const served = bureau({
      'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
      'bureau.skills.list': () => ({
        revision: 1,
        skills: [SKILLS[0], shadowed],
        sources: [],
        trustLocked: null,
      }),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.get': (params) => codeDetail(String(params['id']), ['summarize']),
    });
    // Hold the agents back until released, so the users are pending.
    const base = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('bureau.agents.list')) await gate;
      return base(input, init);
    }) as typeof fetch;
    restore = () => {
      globalThis.fetch = base;
      served.restore();
    };
    landAt('/capabilities?tab=skills&skill=home%2Fsummarize');
    const { container, findByText, findByRole } = mount();
    await findByText(copy.skill.whatItDoes);
    expect(container.textContent).not.toContain(copy.skill.noUsers.title);
    release?.();
    await findByRole('link', { name: 'assistant' });

    await fireEvent.click(container.querySelectorAll('[data-skill-row="summarize"]')[1]!);
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="skill-detail"]')?.getAttribute('data-trust'),
      ).toBe('trusted');
      expect(container.querySelector('[data-testid="skill-unavailable"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="capability-users"]')).toBeNull();
    expect(container.textContent).not.toContain(copy.skill.noUsers.title);
  });

  test('says no skill was found, not to add a directory, when sources are configured', async () => {
    restore = bureau({
      'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
      'bureau.skills.list': () => ({
        revision: 1,
        skills: [],
        sources: [{ id: 'home', kind: 'user', location: '/skills/home', precedence: 20 }],
        trustLocked: null,
      }),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
    }).restore;
    landAt('/capabilities?tab=skills');
    const { container, findByText } = mount();
    await findByText(copy.skill.emptySources.title);
    expect(container.textContent).not.toContain(copy.skill.empty.title);
  });

  test('leaving with an item open does not carry its parameter to the next page', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, findByText } = mount();
    await findByText('read-file');
    await fireEvent.click(container.querySelector('[data-tool-row="read-file"]')!);
    await waitFor(() => expect(window.location.search).toContain('tool=read-file'));
    router.navigate('/agents');
    await tick();
    await tick();
    expect(window.location.pathname + window.location.search).toBe('/agents');
  });

  test('is a first-use empty state when the host discovered no skill', async () => {
    restore = serve(TOOLS, []).restore;
    landAt('/capabilities?tab=skills');
    const { container, findByText } = mount();
    await findByText(copy.skill.empty.title);
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
  });

  test('says the skills could not be read, and filters when they can', async () => {
    restore = serve().restore;
    landAt('/capabilities?tab=skills');
    const { findByText, getByRole, container } = mount();
    await findByText('deploy');
    await fireEvent.input(getByRole('searchbox', { name: copy.filterLabel.skills }), {
      target: { value: 'sum' },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="skills-count"]')?.textContent?.trim()).toBe(
        '1 of 2',
      ),
    );
    await fireEvent.input(getByRole('searchbox', { name: copy.filterLabel.skills }), {
      target: { value: 'zzz' },
    });
    await findByText(copy.skill.filtered.title);
  });

  test('says the skills could not be read when the host does not answer', async () => {
    restore = bureau({
      'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
      'bureau.skills.list': () => {
        throw new Error('down');
      },
    }).restore;
    landAt('/capabilities?tab=skills');
    const { findByText } = mount();
    await findByText(copy.skill.loadFailed.title);
  });
});

describe('the tab', () => {
  test('is in the address: Tools is the address with no tab, Skills is ?tab=skills, and an unknown tab is Tools', async () => {
    restore = serve().restore;
    landAt('/capabilities?tab=nonsense');
    const { container, findByText, getByRole } = mount();
    await findByText('read-file');
    expect(container.querySelector('[data-testid="tools-panel"]')).not.toBeNull();

    await fireEvent.click(getByRole('tab', { name: copy.tabs.skills }));
    await findByText('deploy');
    expect(router.pathname).toBe('/capabilities');
    expect(router.search.get('tab')).toBe('skills');

    await fireEvent.click(getByRole('tab', { name: copy.tabs.tools }));
    await findByText('read-file');
    expect(router.search.get('tab')).toBeNull();
    expect(router.search.get('tool')).toBeNull();
  });
});
