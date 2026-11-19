/**
 * The Capabilities page: the tools of the catalog and the executable skills as a list with the open
 * item beside it, their empty states, and the tab in the address.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { flushSync, tick } from 'svelte';

import { breadcrumbTrail } from '../../app/breadcrumbs.svelte.ts';
import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
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
    plugin: null,
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
    plugin: null,
    users: [],
  },
  {
    name: 'gemini:search',
    description: 'Searches with Gemini.',
    shortDescription: 'Searches the web',
    inputSchema: null,
    tier: 'read-only',
    defaultApproval: 'allow',
    source: 'plugin',
    plugin: 'gemini',
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
      card: [],
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
  test('shows each tool’s source in its row: the plugin, built in, or an MCP server', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, findByText } = mount();

    await findByText('Read file');
    const sourceOf = (name: string) =>
      container
        .querySelector(`[data-tool-row="${name}"] [data-testid="tool-row-source"]`)
        ?.textContent?.trim();
    // The row says where a tool comes from in the page's own badge words: the plugin, Built in, or
    // the server (owner report, 2026-11-19: one set, the same words in the row and the page).
    expect(sourceOf('gemini:search')).toBe('From the Gemini plugin');
    expect(sourceOf('run-shell')).toBe('Built in');
    expect(sourceOf('read-file')).toBe('From an MCP server');

    await fireEvent.click(container.querySelector('[data-tool-row="gemini:search"]')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="tool-source"]')?.textContent?.trim()).toBe(
        'From the Gemini plugin',
      ),
    );
  });

  test('lists every tool with its tier, and shows the open tool’s details, inputs and users', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, findByText, getByRole } = mount();

    await findByText('Read file');
    // The list shows no stray count (row 31c): the number is in the tab.
    expect(container.querySelector('[data-testid="tools-count"]')).toBeNull();
    const row = (name: string) => container.querySelector(`[data-tool-row="${name}"]`);
    const part = (name: string, testId: string) =>
      row(name)?.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim();
    // Two lines: the name for a person and the risk badge, then the source badge and the sentence.
    expect(part('read-file', 'tool-row-name')).toBe('Read file');
    expect(part('read-file', 'tool-row-risk')).toBe('Reads');
    expect(part('read-file', 'tool-row-source')).toBe('From an MCP server');
    expect(part('read-file', 'tool-row-summary')).toBe('Reads one file');
    // A tool that declares no tier is not classified, which is never read as read-only.
    expect(part('run-shell', 'tool-row-risk')).toBe('Not classified');
    expect(part('run-shell', 'tool-row-summary')).toBe('Runs a shell command.');
    expect(part('gemini:search', 'tool-row-name')).toBe('Search');
    // Source, then sentence, in that order on the second line.
    const line = row('read-file')?.querySelector('.ib-capabilities__row-line');
    expect([...(line?.children ?? [])].map((child) => child.getAttribute('data-testid'))).toEqual([
      'tool-row-source',
      'tool-row-summary',
    ]);
    // The badges are the page's own neutral chips, so Dangerous is never red, and a row, which is
    // itself the control, holds nothing focusable of its own.
    const variants = [...(row('read-file')?.querySelectorAll('[data-cinder-variant]') ?? [])].map(
      (chip) => chip.getAttribute('data-cinder-variant'),
    );
    expect(variants).toEqual(['neutral', 'neutral']);
    expect(row('read-file')?.querySelector('[tabindex="0"]')).toBeNull();

    await fireEvent.click(row('read-file')!);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="tool-detail"]')).not.toBeNull(),
    );
    const detail = container.querySelector('[data-testid="tool-detail"]')!;
    expect(detail.getAttribute('data-tool')).toBe('read-file');
    // The page says one sentence about the tool: its short description, not the prompt the model reads.
    expect(detail.querySelector('[data-testid="tool-summary"]')?.textContent).toBe(
      'Reads one file',
    );
    expect(detail.querySelector('[data-testid="tool-risk"]')?.textContent?.trim()).toBe('Reads');
    expect(detail.querySelector('[data-testid="tool-approval"]')?.textContent?.trim()).toBe(
      'Asks: Never',
    );
    expect(detail.querySelector('[data-testid="tool-source"]')?.textContent?.trim()).toBe(
      'From an MCP server',
    );
    expect(detail.querySelector('[data-testid="tool-input-schema"]')?.textContent).toContain(
      'Path',
    );
    expect(detail.querySelector('[data-testid="tool-input-schema"]')?.textContent).toContain(
      'Where the file is.',
    );
    expect(getByRole('link', { name: 'Assistant' }).getAttribute('href')).toBe('/agents/assistant');
    // The open tool is in the address, and the router has read it back.
    expect(router.search.get('tool')).toBe('read-file');

    // A user opens its page in the application; a modified click is left to the browser.
    await fireEvent.click(getByRole('link', { name: 'Assistant' }), { ctrlKey: true });
    expect(router.pathname).toBe('/capabilities');
    await fireEvent.click(getByRole('link', { name: 'Assistant' }));
    expect(router.pathname).toBe('/agents/assistant');
  });

  test('says what each agent asks for the tool beside its link, and a blocked agent in words with the Allow all note (rows 30c, 30d, 31j, 31w, 31x)', async () => {
    const tools = TOOLS.map((tool) =>
      tool.name === 'read-file'
        ? {
            ...tool,
            users: ['assistant', 'planner', 'writer'],
            userApprovals: { planner: 'always', writer: 'blocked' },
          }
        : tool,
    );
    restore = serve(tools).restore;
    landAt('/capabilities?tool=read-file');
    const { container } = mount();

    const detail = await waitFor(() => {
      const found = container.querySelector('[data-testid="tool-detail"]');
      if (found === null) throw new Error('the tool is not open yet');
      return found;
    });
    const notes = [...detail.querySelectorAll('[data-testid="capability-user-note"]')].map(
      (note) => note.textContent,
    );
    // Sorted as the host sends them: a default is marked as one, a stated level is not, Blocked is
    // said as belonging to that agent.
    expect(notes).toEqual(['Asks: Never (default)', 'Asks: Always', 'Blocked on this agent']);
    // Each agent is a Cinder Link named as the Agents list names it, never by its identifier.
    const links = [...detail.querySelectorAll<HTMLElement>('[data-testid="capability-users"] a')];
    expect(links.map((link) => link.dataset['agent'])).toEqual(['assistant', 'planner', 'writer']);
    expect(links[0]?.textContent?.trim()).toBe(AGENT.displayName);
    expect(links[1]?.textContent?.trim()).toBe('Planner');
    expect(links.every((link) => link.className.includes('cinder-link'))).toBe(true);
    // The note is about the one blocked agent and names it; the agents that are not blocked get none.
    const blockedNotes = [...detail.querySelectorAll('[data-testid="tool-blocked-note"]')];
    expect(blockedNotes.map((note) => note.textContent?.trim())).toEqual([
      copy.tool.blockedNote('Writer'),
    ]);
    // Blocked is never a property of the tool: the chip still says its default.
    expect(detail.querySelector('[data-testid="tool-approval"]')?.textContent?.trim()).toBe(
      'Asks: Never',
    );
  });

  test('draws no Blocked note when no agent has the tool blocked', async () => {
    restore = serve().restore;
    landAt('/capabilities?tool=read-file');
    const { container } = mount();
    const detail = await waitFor(() => {
      const found = container.querySelector('[data-testid="tool-detail"]');
      if (found === null) throw new Error('the tool is not open yet');
      return found;
    });
    expect(detail.querySelector('[data-testid="tool-blocked-note"]')).toBeNull();
  });

  test('says a tool no agent uses in one line, with Add to an agent as the header’s button, and a tool without a described input in words', async () => {
    restore = serve().restore;
    landAt('/capabilities?tool=run-shell');
    const { container, findByText } = mount();

    const detail = await waitFor(() => {
      const found = container.querySelector('[data-testid="tool-detail"]');
      if (found === null) throw new Error('the tool is not open yet');
      return found;
    });
    await findByText(copy.tool.noUsers.line, { exact: false });
    // One muted line, never a centred empty state (rows 30e and 32j), and no link in it: the
    // action is the header's button (owner report, 2026-11-19).
    expect(detail.querySelector('[data-testid="capability-users"] [data-cinder-kind]')).toBeNull();
    const line = detail.querySelector('[data-testid="capability-users-empty"]');
    expect(line?.textContent?.trim()).toBe('No agent uses this tool yet.');
    expect(line?.querySelector('a')).toBeNull();
    const add = detail.querySelector('header [data-testid="tool-add-to-agent"]');
    expect(add?.tagName).toBe('A');
    expect(add?.getAttribute('href')).toBe(copy.tool.addToAgent.href);
    expect(add?.textContent?.trim()).toBe(copy.tool.addToAgent.label);
    expect(add?.classList.contains('cinder-button')).toBe(true);
    // Without a described input there are no fields and no document to show.
    expect(detail.querySelector('[data-testid="tool-input-schema"]')?.textContent).toContain(
      copy.tool.noSchema,
    );
    expect(detail.querySelector('[data-testid="tool-input-schema"]')?.textContent).not.toContain(
      'JSON schema',
    );
    // A tool that declares no tier asks On changes by default, and its risk is not classified.
    expect(detail.querySelector('[data-testid="tool-risk"]')?.textContent?.trim()).toBe(
      'Not classified',
    );
    expect(detail.querySelector('[data-testid="tool-approval"]')?.textContent?.trim()).toBe(
      'Asks: On changes',
    );
    expect(detail.textContent).not.toMatch(/\bNone\b/);
  });

  test('filters by name, says so when nothing matches, and clears the filter', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, findByText, getByRole, findByRole } = mount();
    await findByText('Read file');

    await fireEvent.input(getByRole('searchbox', { name: copy.filterLabel.tools }), {
      target: { value: 'nothing-like-this' },
    });
    await findByText(copy.tool.filtered.title);
    const empty = container.querySelector('[data-cinder-kind="filtered"]');
    expect(empty).not.toBeNull();
    // The field stays, with what was typed, and the count reads at its right (row 32b); the tabs keep theirs.
    expect(
      (getByRole('searchbox', { name: copy.filterLabel.tools }) as HTMLInputElement).value,
    ).toBe('nothing-like-this');
    expect(container.querySelector('[data-testid="tools-count"]')?.textContent?.trim()).toBe(
      '0 of 3 tools',
    );
    expect(container.querySelector('[data-testid="tab-count-tools"]')?.textContent?.trim()).toBe(
      '3',
    );
    expect(container.querySelector('[data-testid="tab-count-skills"]')?.textContent?.trim()).toBe(
      '2',
    );

    await fireEvent.click(await findByRole('button', { name: copy.tool.filtered.clear }));
    await findByText('Read file');
    expect(container.querySelector('[data-testid="tools-count"]')).toBeNull();
  });

  test('filters by the name for a person as well as by the identifier', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, findByText, getByRole } = mount();
    await findByText('Read file');

    await fireEvent.input(getByRole('searchbox', { name: copy.filterLabel.tools }), {
      target: { value: 'run shell' },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="tools-count"]')?.textContent?.trim()).toBe(
        '1 of 3 tools',
      ),
    );
    expect(container.querySelector('[data-tool-row="run-shell"]')).not.toBeNull();
    expect(container.querySelector('[data-tool-row="read-file"]')).toBeNull();
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
    await findByText('Read file');
  });
});

/** A tool of an MCP server that deletes things, which has a title of its own and no user. */
const DELETE_BRANCH = {
  name: 'github__delete_branch',
  title: 'Delete branch',
  description: 'Deletes a branch from a GitHub repository.\nThe rest is for the model.',
  shortDescription: 'Deletes a branch from a GitHub repository.',
  inputSchema: {
    type: 'object',
    properties: { branch: { type: 'string', description: 'The branch to delete.' } },
    required: ['branch'],
  },
  tier: 'dangerous',
  defaultApproval: 'ask',
  source: 'host',
  plugin: null,
  users: [],
};

const openTool = async (path: string) => {
  landAt(path);
  const view = mount();
  const detail = await waitFor(() => {
    const found = view.container.querySelector('[data-testid="tool-detail"]');
    if (found === null) throw new Error('the tool is not open yet');
    return found;
  });
  return { ...view, detail };
};

describe('a tool’s page', () => {
  test('opens with what it does, then who can use it and whether it asks, then its inputs beside the open schema', async () => {
    restore = serve([...TOOLS, DELETE_BRANCH]).restore;
    const { detail } = await openTool('/capabilities?tool=github__delete_branch');

    expect(detail.querySelector('h3')?.textContent).toBe('Delete branch');
    // No raw identifier beside the name: Copy tool ID holds it (owner report, 2026-11-19).
    expect(detail.querySelector('header')?.textContent).not.toContain('github__delete_branch');
    expect(detail.querySelector('[data-testid="tool-identifier"]')).toBeNull();
    const copyIdentifier = detail.querySelector('header [data-testid="tool-copy-identifier"]');
    expect(copyIdentifier?.getAttribute('aria-label')).toBe(copy.tool.copyIdentifier.label);
    // The sentence is said once, under the name.
    expect(detail.querySelector('[data-testid="tool-summary"]')?.textContent).toBe(
      'Deletes a branch from a GitHub repository.',
    );
    expect(detail.textContent?.split('Deletes a branch from a GitHub repository.').length).toBe(2);
    // A dangerous tool defaults to Always, and says so in words rather than in red.
    expect(detail.querySelector('[data-testid="tool-risk"]')?.textContent?.trim()).toBe(
      'Dangerous',
    );
    expect(detail.querySelector('[data-testid="tool-approval"]')?.textContent?.trim()).toBe(
      'Asks: Always',
    );
    expect(detail.querySelector('[data-testid="tool-source"]')?.textContent?.trim()).toBe(
      'From Github',
    );
    // One set: each badge the same neutral chip with a glyph, so all three share one baseline.
    for (const testId of ['tool-risk', 'tool-approval', 'tool-source']) {
      const chip = detail.querySelector(`[data-testid="${testId}"]`);
      expect(chip?.getAttribute('data-cinder-variant')).toBe('neutral');
      expect(chip?.getAttribute('data-cinder-size')).toBe('sm');
      expect(chip?.querySelectorAll('svg')).toHaveLength(1);
    }
    // Only the dangerous chip has a shield: the risk chip carries the one icon that means risk.
    expect(detail.querySelectorAll('.lucide-shield')).toHaveLength(1);

    const order = [
      detail.querySelector('h3'),
      detail.querySelector('[data-testid="tool-summary"]'),
      detail.querySelector('header [data-testid="tool-copy-identifier"]'),
      detail.querySelector('ul[aria-label="About this tool"]'),
      detail.querySelector('[data-testid="capability-users"]'),
      detail.querySelector('[data-testid="tool-input-schema"]'),
    ];
    for (const [index, element] of order.entries()) {
      expect(element).not.toBeNull();
      const next = order[index + 1];
      if (element !== null && next !== null && next !== undefined) {
        expect(
          element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    }
    // The inputs are unframed rows: the name, the word Required, the type in words, and the
    // document is open in a code block beside them, never behind a disclosure.
    const inputs = detail.querySelector('[data-testid="tool-input-schema"]')!;
    expect(inputs.getAttribute('data-cinder-layout')).toBe('rows');
    expect(inputs.getAttribute('data-cinder-raw')).toBe('beside');
    expect(inputs.querySelector('[role="table"]')).toBeNull();
    expect(inputs.querySelector('.cinder-schema-view__required-word')?.textContent).toBe(
      'Required',
    );
    expect(inputs.querySelector('.cinder-schema-view__source')?.textContent).toContain(
      'JSON schema',
    );
    expect(inputs.querySelector('.cinder-schema-view__source code')?.textContent).toContain(
      '"branch"',
    );
    expect(inputs.querySelector('.cinder-schema-view__raw')).toBeNull();
  });

  test('reads a tool with no title of its own by its identifier as words, and ends the breadcrumb with it', async () => {
    restore = serve().restore;
    const { detail } = await openTool('/capabilities?tool=read-file');

    expect(detail.querySelector('h3')?.textContent).toBe('Read file');
    await waitFor(() =>
      expect(breadcrumbTrail('/capabilities')).toEqual([
        { label: 'Capabilities', href: '/capabilities' },
        { label: 'Read file' },
      ]),
    );
  });

  test('gives each chip a focusable anchor and a tooltip that says what it means', async () => {
    restore = serve([...TOOLS, DELETE_BRANCH]).restore;
    const { detail, findByRole } = await openTool('/capabilities?tool=github__delete_branch');

    for (const testId of ['tool-risk', 'tool-approval', 'tool-source']) {
      expect(detail.querySelector(`[data-testid="${testId}"]`)?.getAttribute('tabindex')).toBe('0');
    }
    await fireEvent.focusIn(detail.querySelector('[data-testid="tool-approval"]')!);
    const tooltip = await findByRole('tooltip');
    expect(tooltip.textContent).toContain('Asks before every call.');
    expect(tooltip.textContent).toContain(
      'The values are Never, On changes, Always and Blocked. A chat’s permission mode never overrides Always or Blocked.',
    );
  });

  test('says a missing tool is missing, ends the breadcrumb with Not found, and leads back to the list', async () => {
    restore = serve().restore;
    landAt('/capabilities?tool=no-such-tool');
    const { container, findByRole, findByText } = mount();

    await findByText(copy.tool.page.notFound.title);
    expect(container.querySelector('[data-testid="tool-not-found"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tool-detail"]')).toBeNull();
    await waitFor(() =>
      expect(breadcrumbTrail('/capabilities')).toEqual([
        { label: 'Capabilities', href: '/capabilities' },
        { label: 'Not found' },
      ]),
    );

    await fireEvent.click(await findByRole('link', { name: copy.tool.page.notFound.back }));
    expect(router.pathname).toBe('/capabilities');
    expect(router.search.get('tool')).toBeNull();
  });

  test('says a missing tool is missing on a narrow page too, where the list is the only pane', async () => {
    restore = serve().restore;
    const measure = Element.prototype.getBoundingClientRect;
    // A phone's width: ListDetail shows one pane at a time and its empty pane is never reached.
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const rect = measure.call(this);
      return this.classList.contains('ib-capabilities__frame')
        ? new DOMRect(rect.x, rect.y, 400, rect.height)
        : rect;
    };
    try {
      landAt('/capabilities?tool=no-such-tool');
      const { container, findByRole, findByText } = mount();

      await findByText(copy.tool.page.notFound.title);
      expect(container.querySelector('[data-testid="tool-not-found"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="tool-detail"]')).toBeNull();
      await fireEvent.click(await findByRole('link', { name: copy.tool.page.notFound.back }));
      expect(router.search.get('tool')).toBeNull();
      // With nothing missing the list is back.
      await waitFor(() => expect(container.querySelector('[data-tool-row]')).not.toBeNull());
    } finally {
      Element.prototype.getBoundingClientRect = measure;
    }
  });

  test('Cancel on the slow-loading line leaves the catalog loading, so the list still arrives', async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = serve();
    const answer = globalThis.fetch;
    const holdBack = installFetchImplementation(async (input, init) => {
      await released;
      return answer(input, init);
    });
    restore = () => {
      holdBack();
      served.restore();
    };
    jest.useFakeTimers();
    landAt('/capabilities?tool=read-file');
    const { container, getByRole } = mount();
    try {
      flushSync();
      jest.advanceTimersByTime(10_000);
      flushSync();
      await fireEvent.click(getByRole('button', { name: 'Cancel' }));
      expect(router.search.get('tool')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
    release();
    await waitFor(() => expect(container.querySelector('[data-tool-row]')).not.toBeNull());
    expect(container.querySelector('[data-testid="tool-loading"]')).toBeNull();
  });

  test('is the full error state, with a primary Try again, when the tool cannot be loaded', async () => {
    let fail = true;
    restore = bureau({
      'bureau.agents.catalog': () => {
        if (fail) throw new Error('down');
        return { models: [], tools: TOOLS };
      },
    }).restore;
    landAt('/capabilities?tool=read-file');
    const { container, findByRole, findByText } = mount();

    await findByText(copy.tool.page.failed.title);
    expect(container.querySelector('[data-testid="tool-load-failed"]')).not.toBeNull();
    expect(container.textContent).toContain(copy.tool.page.failed.description);
    fail = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="tool-detail"]')).not.toBeNull(),
    );
  });
});

describe('the Skills tab', () => {
  test('marks a skill whose source is not trusted, in its row and its details, and says why it is refused', async () => {
    restore = serve().restore;
    landAt('/capabilities?tab=skills&skill=workspace%2Fdeploy');
    const { container, findByText } = mount();

    await findByText('Summarize');
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

    const link = await findByRole('link', { name: 'Assistant' });
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
    await findByText('Broken');
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
    const { container, findByRole } = mount();
    await waitFor(() =>
      expect(container.querySelector('[data-testid="skill-detail"]')).not.toBeNull(),
    );
    expect(container.textContent).not.toContain(copy.skill.noUsers.title);
    release?.();
    await findByRole('link', { name: 'Assistant' });

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
    await findByText('Read file');
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
    const { container, findByText, getByRole } = mount();
    await findByText(copy.skill.empty.title);
    expect(container.querySelector('[data-cinder-kind="first-use"]')).not.toBeNull();
    expect(container.textContent).toContain(copy.skill.empty.description);
    // No filter row; the one primary button adds a plugin (row 31y), and the tab says 0.
    expect(container.querySelector('input[type="search"]')).toBeNull();
    const add = getByRole('link', { name: copy.skill.empty.action.label });
    expect(add.getAttribute('href')).toBe('/settings/plugins');
    expect(add.getAttribute('data-cinder-variant')).toBe('primary');
    expect(container.querySelector('[data-testid="tab-count-skills"]')?.textContent?.trim()).toBe(
      '0',
    );
    await fireEvent.click(add);
    expect(router.pathname).toBe('/settings/plugins');
  });

  test('says the skills could not be read, and filters when they can', async () => {
    restore = serve().restore;
    landAt('/capabilities?tab=skills');
    const { findByText, getByRole, container } = mount();
    await findByText('Deploy');
    // The list shows no stray count until something is typed.
    expect(container.querySelector('[data-testid="skills-count"]')).toBeNull();
    await fireEvent.input(getByRole('searchbox', { name: copy.filterLabel.skills }), {
      target: { value: 'sum' },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="skills-count"]')?.textContent?.trim()).toBe(
        '1 of 2 skills',
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
    await findByText('Read file');
    expect(container.querySelector('[data-testid="tools-panel"]')).not.toBeNull();

    // A tab's name carries its count, so it is found by the words that lead it.
    await fireEvent.click(getByRole('tab', { name: /^Skills\b/ }));
    await findByText('Deploy');
    expect(router.pathname).toBe('/capabilities');
    expect(router.search.get('tab')).toBe('skills');

    await fireEvent.click(getByRole('tab', { name: /^Tools\b/ }));
    await findByText('Read file');
    expect(router.search.get('tab')).toBeNull();
    expect(router.search.get('tool')).toBeNull();
  });
});

describe('the tab counts and loading', () => {
  test('carries the count of what each tab holds, and a dash for the one that did not arrive', async () => {
    restore = serve().restore;
    landAt('/capabilities');
    const { container, getByRole } = mount();

    await waitFor(() => {
      expect(container.querySelector('[data-testid="tab-count-tools"]')?.textContent?.trim()).toBe(
        '3',
      );
    });
    expect(container.querySelector('[data-testid="tab-count-skills"]')?.textContent?.trim()).toBe(
      '2',
    );
    // This host answers no tool-source request, so the Sources tab has no count to give: a dash, never a zero.
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="tab-count-sources"]')?.textContent?.trim(),
      ).toBe(copy.tabCountPending);
    });
    expect(getByRole('tab', { name: 'Tools 3' })).not.toBeNull();
    expect(getByRole('tab', { name: 'Skills 2' })).not.toBeNull();
  });

  test('shows dashes while the lists load, skeleton rows after 300 ms, and the slow line after 10 s', async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const served = serve();
    const answer = globalThis.fetch;
    const holdBack = installFetchImplementation(async (input, init) => {
      await released;
      return answer(input, init);
    });
    restore = () => {
      holdBack();
      served.restore();
    };
    jest.useFakeTimers();
    landAt('/capabilities');
    const { container } = mount();
    const count = (id: string) =>
      container.querySelector(`[data-testid="tab-count-${id}"]`)?.textContent?.trim();
    try {
      flushSync();
      expect([count('tools'), count('skills'), count('sources')]).toEqual(['–', '–', '–']);
      // The header and the tabs are there at once; the placeholders wait 300 ms.
      expect(container.querySelector('[role="tablist"]')).not.toBeNull();
      expect(container.querySelector('.ib-capabilities__loading')).toBeNull();
      jest.advanceTimersByTime(300);
      flushSync();
      expect(container.querySelectorAll('.ib-capabilities__loading-row')).toHaveLength(3);
      expect(container.querySelector('.ib-capabilities__loading-detail')).not.toBeNull();
      expect(container.textContent).not.toContain('Still loading');
      jest.advanceTimersByTime(10_000);
      flushSync();
      expect(container.textContent).toContain('Still loading. This is taking longer than usual.');
    } finally {
      jest.useRealTimers();
    }
    release();
    await waitFor(() => expect(count('tools')).toBe('3'));
  });
});

/** A tool the catalog lists: Bureau's own, or an MCP server's. */
function listedTool(name: string, source: 'bureau' | 'host'): Record<string, unknown> {
  return {
    name,
    description: `Does ${name}.`,
    shortDescription: `Does ${name}.`,
    inputSchema: null,
    tier: 'read-only',
    defaultApproval: 'allow',
    source,
    plugin: null,
    users: [],
  };
}

describe('grouping the tools', () => {
  const labels = (container: HTMLElement) =>
    [...container.querySelectorAll('.cinder-data-list-group__label')].map((label) =>
      label.textContent?.trim(),
    );

  test('groups the rows by source from 40 tools, Built in first, each row keeping its two lines', async () => {
    // The server's tools come first in the catalog, so the order is the list's own.
    const tools = [
      ...Array.from({ length: 34 }, (_, index) => listedTool(`github__tool_${index}`, 'host')),
      ...Array.from({ length: 6 }, (_, index) => listedTool(`built_in_${index}`, 'bureau')),
    ];
    restore = serve(tools).restore;
    landAt('/capabilities');
    const { container } = mount();

    await waitFor(() => expect(labels(container)).toEqual(['Built in', 'Github']));
    const row = container.querySelector('[data-tool-row="built_in_0"]')!;
    expect(row.querySelector('[data-testid="tool-row-name"]')?.textContent?.trim()).toBe(
      'Built in 0',
    );
    expect(row.querySelector('[data-testid="tool-row-source"]')?.textContent?.trim()).toBe(
      'Built in',
    );
    expect(row.querySelector('[data-testid="tool-row-risk"]')?.textContent?.trim()).toBe('Reads');
  });

  test('keeps one flat list below 40 tools', async () => {
    const tools = Array.from({ length: 39 }, (_, index) =>
      listedTool(`built_in_${index}`, 'bureau'),
    );
    restore = serve(tools).restore;
    landAt('/capabilities');
    const { container } = mount();

    await waitFor(() => expect(container.querySelector('[data-tool-row]')).not.toBeNull());
    expect(labels(container)).toEqual([]);
  });
});

/** A skill that ships two tools, and the catalog entries those tools have. */
const CUSTOMER_LOOKUP = {
  name: 'customer-lookup',
  description: 'Finds a customer and merges duplicates.',
  source: { id: 'built-in', kind: 'built-in', location: '/skills/built-in', plugin: null },
  trust: 'trusted',
  trustReason: 'Built in.',
  available: true,
  unavailableReason: null,
  allowedTools: [],
  tools: ['find_customer', 'merge_customers'],
};
const CUSTOMER_TOOLS = [
  {
    name: 'find_customer',
    title: 'Find customer',
    description: 'Finds a customer.',
    shortDescription: 'Finds a customer.',
    inputSchema: null,
    tier: 'read-only',
    defaultApproval: 'allow',
    source: 'skill',
    plugin: null,
    skill: 'customer-lookup',
    users: [],
  },
  {
    name: 'merge_customers',
    title: 'Merge customers',
    description: 'Merges two customers.',
    shortDescription: 'Merges two customers.',
    inputSchema: null,
    tier: 'dangerous',
    defaultApproval: 'ask',
    source: 'skill',
    plugin: null,
    skill: 'customer-lookup',
    users: [],
  },
];

const openSkill = async (path: string) => {
  landAt(path);
  const view = mount();
  const detail = await waitFor(() => {
    const found = view.container.querySelector('[data-testid="skill-detail"]');
    if (found === null) throw new Error('the skill is not open yet');
    return found;
  });
  return { ...view, detail };
};

const metaOf = (detail: Element) =>
  [...detail.querySelectorAll('[data-testid="skill-meta"] li')].map((item) =>
    item.textContent?.trim(),
  );

describe('a skill’s page', () => {
  test('shows what it tells the agent: the SKILL.md rendered in a card with its size, Show all, and the raw file last (rows 31m, 31n)', async () => {
    const file = [
      '---',
      'name: summarize',
      'description: Summarizes a document.',
      '---',
      '',
      'Group the merged pull requests by what changed for a customer.',
      '',
      '- Lead with the change, not the pull request number.',
      '- Keep each entry to one sentence.',
      '',
      '<script>window.injected = true</script>',
      '',
    ].join('\n');
    const calls = bureau({
      'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
      'bureau.skills.list': () => ({ revision: 1, skills: SKILLS, sources: [], trustLocked: null }),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.get': (params) => codeDetail(String(params['id']), ['summarize']),
      'bureau.skills.get': (params) => ({
        name: String(params['name']),
        instructions: { text: file, size: 1229, truncated: false },
        unavailableReason: null,
      }),
    });
    restore = calls.restore;
    const { detail } = await openSkill('/capabilities?tab=skills&skill=home%2Fsummarize');

    const section = await waitFor(() => {
      const found = detail.querySelector('[data-testid="skill-instructions-body"]');
      if (found === null) throw new Error('the instructions are not read yet');
      return found;
    });
    expect(calls.calls.find((call) => call.method === 'bureau.skills.get')?.params).toEqual({
      name: 'summarize',
    });
    expect(
      detail.querySelector('[data-testid="skill-instructions-title"]')?.textContent?.trim(),
    ).toMatch(/^Instructions\s+SKILL\.md 1\.2 KB$/);
    // The body, not the frontmatter, is rendered; the file is untrusted, so no script survives.
    expect(section.querySelector('p')?.textContent).toBe(
      'Group the merged pull requests by what changed for a customer.',
    );
    expect([...section.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Lead with the change, not the pull request number.',
      'Keep each entry to one sentence.',
    ]);
    expect(section.textContent).not.toContain('name: summarize');
    expect(section.querySelector('script')).toBeNull();
    // Show all opens the rest of the rendered file.
    const toggle = detail.querySelector<HTMLElement>('[data-testid="skill-instructions-toggle"]')!;
    expect(toggle.textContent?.trim()).toBe(copy.skill.instructions.showAll);
    expect(section.hasAttribute('data-clamped')).toBe(true);
    await fireEvent.click(toggle);
    expect(section.hasAttribute('data-clamped')).toBe(false);
    // The raw file is a disclosure, last in the section.
    expect(detail.querySelector('[data-testid="skill-instructions-raw"]')).not.toBeNull();
    // A flat disclosure, as SchemaView's is, not a bordered box inside the detail.
    expect(
      detail
        .querySelector('[data-testid="skill-instructions-raw"]')
        ?.closest('[data-cinder-variant]')
        ?.getAttribute('data-cinder-variant') ??
        detail
          .querySelector('[data-testid="skill-instructions-raw"]')
          ?.getAttribute('data-cinder-variant'),
    ).toBe('flat');
    // Used by says when the agent loads it, in the skill's own words.
    await waitFor(() =>
      expect(
        detail.querySelector('[data-testid="capability-user-note"]')?.textContent?.trim(),
      ).toBe(copy.skill.loadsWhen('Summarizes a document.')),
    );
  });

  test('says why a skill’s SKILL.md is not shown when the host does not serve it', async () => {
    restore = bureau({
      'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
      'bureau.skills.list': () => ({ revision: 1, skills: SKILLS, sources: [], trustLocked: null }),
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.definitions.get': (params) => codeDetail(String(params['id']), ['summarize']),
      'bureau.skills.get': () => ({
        name: 'summarize',
        instructions: null,
        unavailableReason: 'changed',
      }),
    }).restore;
    const { detail } = await openSkill('/capabilities?tab=skills&skill=home%2Fsummarize');

    await waitFor(() =>
      expect(
        detail.querySelector('[data-testid="skill-instructions-unavailable"]')?.textContent?.trim(),
      ).toBe(copy.skill.instructions.unavailable['changed']),
    );
    expect(detail.querySelector('[data-testid="skill-instructions-toggle"]')).toBeNull();
  });

  test('opens with its name for a person, its identifier beside it, the sentence and the muted line', async () => {
    restore = serve().restore;
    const { detail } = await openSkill('/capabilities?tab=skills&skill=home%2Fsummarize');

    expect(detail.querySelector('h3')?.textContent).toBe('Summarize');
    expect(detail.querySelector('[data-testid="skill-identifier"]')?.textContent).toBe('summarize');
    expect(detail.querySelector('[data-testid="skill-summary"]')?.textContent).toBe(
      'Summarizes a document.',
    );
    // A skill of instructions only says so, then where it is from and when it loads.
    expect(metaOf(detail)).toEqual(['Instructions only', 'User', 'Loaded when relevant']);
    expect(detail.querySelector('[data-testid="skill-brings"]')).toBeNull();
    // No separator dot stands between the words of the line.
    expect(detail.querySelector('[data-testid="skill-meta"]')?.textContent).not.toContain(
      String.fromCodePoint(0xb7),
    );
  });

  test('lists the tools a skill brings with what each may do and when it asks, and counts them in the line', async () => {
    restore = serve([...TOOLS, ...CUSTOMER_TOOLS], [...SKILLS, CUSTOMER_LOOKUP]).restore;
    const { detail } = await openSkill('/capabilities?tab=skills&skill=built-in%2Fcustomer-lookup');

    expect(detail.querySelector('h3')?.textContent).toBe('Customer lookup');
    expect(detail.querySelector('[data-testid="skill-identifier"]')?.textContent).toBe(
      'customer-lookup',
    );
    expect(metaOf(detail)).toEqual([
      'Instructions and 2 tools',
      'Built in',
      'Loaded when relevant',
    ]);

    const cells = (name: string) =>
      [...detail.querySelectorAll(`[data-brought-tool="${name}"] td`)].map((cell) =>
        cell.textContent?.replaceAll(/\s+/g, ' ').trim(),
      );
    await waitFor(() =>
      expect(cells('find_customer')).toEqual(['Find customer find_customer', 'Reads', 'Never']),
    );
    expect(cells('merge_customers')).toEqual([
      'Merge customers merge_customers',
      'Dangerous',
      'Always',
    ]);
    expect(detail.querySelector('[data-testid="skill-brings"] h4')?.textContent).toBe(
      copy.skill.brings.heading,
    );
  });

  test('lists a disconnected source’s tool from its last listing, with the warning, Reconnect and Used by keeping the asks level (rows 30n, 30o)', async () => {
    const createIssue = {
      name: 'github__create_issue',
      tool: 'create_issue',
      acceptsSecrets: false,
      savedAcceptsSecrets: false,
      enabled: true,
      savedEnabled: true,
      tier: 'mutating',
      approval: 'on-changes',
      approvalSaved: false,
      title: 'Create issue',
      description: 'Opens an issue in a GitHub repository.',
      shortDescription: null,
      inputSchema: null,
    };
    const github = {
      id: 'github',
      kind: 'mcp',
      name: 'GitHub',
      localCommand: false,
      state: 'failed',
      message: 'The source could not be reached.',
      tools: [],
      skipped: [],
      unmatchedSettings: [],
      credentials: [],
      lastListing: { listedAt: '2026-11-16T08:00:00.000Z', truncated: false, tools: [createIssue] },
    };
    restore = bureau(
      {
        'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
        'bureau.skills.list': () => ({ revision: 1, skills: [], sources: [], trustLocked: null }),
      },
      (url) =>
        new URL(url, 'http://localhost').pathname === '/host/tool-sources'
          ? Response.json({ configurationRevision: null, sources: [github] })
          : undefined,
    ).restore;
    landAt('/capabilities?tool=github__create_issue');
    const { container } = mount();

    const detail = await waitFor(() => {
      const found = container.querySelector('[data-testid="tool-detail"]');
      if (found === null) throw new Error('the tool is not open yet');
      return found;
    });
    expect(detail.querySelector('h3')?.textContent?.trim()).toBe('Create issue');
    // Every chip stays, the asks level among them.
    expect(detail.querySelector('[data-testid="tool-approval"]')?.textContent?.trim()).toBe(
      'Asks: On changes',
    );
    expect(detail.querySelector('[data-testid="tool-lost-text"]')?.textContent).toBe(
      'GitHub is disconnected. Agents can’t use this tool until it is reconnected.',
    );
    const reconnect = detail.querySelector('[data-testid="tool-lost-reconnect"]');
    expect(reconnect?.textContent?.trim()).toBe('Reconnect');
    expect(
      detail.querySelector('[data-testid="capability-users-empty"]')?.textContent?.trim(),
    ).toBe(copy.tool.lost.noUsers);
    // The count rule: the Tools tab lists the catalog's tools and then the lost ones, each once,
    // and its count is that many. A lost row is marked, and is never one the catalog holds.
    const rows = [...container.querySelectorAll<HTMLElement>('[data-tool-row]')];
    const lostRows = rows.filter((row) => row.hasAttribute('data-lost'));
    expect(lostRows.map((row) => row.dataset['toolRow'])).toEqual(['github__create_issue']);
    expect(rows.length - lostRows.length).toBe(TOOLS.length);
    // A lost row says so in its own muted word; a tool that runs does not.
    expect(lostRows[0]?.querySelector('[data-testid="tool-row-paused"]')?.textContent?.trim()).toBe(
      copy.tool.lost.paused,
    );
    expect(
      rows.filter((row) => row.querySelector('[data-testid="tool-row-paused"]') !== null),
    ).toHaveLength(1);
    // And its chip names the source as a person does.
    expect(container.querySelector('[data-testid="tool-source"]')?.textContent?.trim()).toBe(
      'From GitHub',
    );
    expect(container.querySelector('[data-testid="tab-count-tools"]')?.textContent?.trim()).toBe(
      String(TOOLS.length + lostRows.length),
    );
    await fireEvent.click(reconnect!);
    expect(router.search.get('tab')).toBe('sources');
    expect(router.search.get('source')).toBe('github');
  });

  test('lists a disabled plugin’s tool from its last listing, with Enable and restart behind the shared restart question (row 30p)', async () => {
    const demo = {
      descriptor: {
        name: 'demo',
        title: 'Demo',
        version: '1.0.0',
        description: 'Drafts release notes.',
        required: false,
        enabledByDefault: true,
      },
      source: 'package',
      location: '@fixture/demo',
      status: 'disabled',
      problems: [],
      contributions: [],
      enabled: false,
      configuration: {},
      configurationSchema: null,
      running: { enabled: false, configuration: {} },
      secrets: [],
      restartRequired: false,
      lastListing: {
        listedAt: '2026-11-16T08:00:00.000Z',
        truncated: false,
        tools: [
          {
            name: 'draft-release-notes',
            tool: 'draft-release-notes',
            title: 'Draft release notes',
            description: 'Writes release notes from merged changes.',
            shortDescription: null,
            tier: 'mutating',
            inputSchema: null,
          },
        ],
      },
    };
    restore = bureau(
      {
        'bureau.agents.catalog': () => ({ models: [], tools: TOOLS }),
        'bureau.skills.list': () => ({ revision: 1, skills: [], sources: [], trustLocked: null }),
      },
      (url) =>
        new URL(url, 'http://localhost').pathname === '/host/plugins'
          ? Response.json({
              configurationRevision: null,
              plugins: [demo],
              unloaded: [],
            })
          : undefined,
    ).restore;
    landAt('/capabilities?tool=draft-release-notes');
    const { container, getByRole } = mount();

    const detail = await waitFor(() => {
      const found = container.querySelector('[data-testid="tool-detail"]');
      if (found === null) throw new Error('the tool is not open yet');
      return found;
    });
    expect(detail.querySelector('[data-testid="tool-source"]')?.textContent?.trim()).toBe(
      'From the Demo plugin',
    );
    expect(detail.querySelector('[data-testid="tool-lost-text"]')?.textContent).toBe(
      'The Demo plugin is disabled. Enabling it restarts the server.',
    );
    await fireEvent.click(detail.querySelector('[data-testid="tool-lost-enable"]')!);
    // The shared restart question names the effect on running work before anything is written.
    await waitFor(() => expect(getByRole('dialog')).not.toBeNull());
    // The tab count holds the tools that cannot run too.
    expect(container.querySelector('[data-testid="tab-count-tools"]')?.textContent).toBe('4');
  });

  test('shows a tool a skill brings on the Tools tab with the skill as its source', async () => {
    restore = serve([...TOOLS, ...CUSTOMER_TOOLS], [...SKILLS, CUSTOMER_LOOKUP]).restore;
    landAt('/capabilities');
    const { container } = mount();

    await waitFor(() =>
      expect(container.querySelector('[data-tool-row="find_customer"]')).not.toBeNull(),
    );
    const row = container.querySelector('[data-tool-row="find_customer"]')!;
    expect(row.querySelector('[data-testid="tool-row-source"]')?.textContent?.trim()).toBe(
      'From the Customer lookup skill',
    );
    expect(row.querySelector('[data-testid="tool-row-name"]')?.textContent?.trim()).toBe(
      'Find customer',
    );
  });
});
