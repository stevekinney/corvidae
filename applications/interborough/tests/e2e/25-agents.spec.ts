/**
 * `/agents` and `/agents/:agent`: the agents the Bureau tells the caller of, each a compact row with
 * how much it has been used (a count that opens the agent's page), Memory and New chat as buttons
 * for each, and on the agent's page what it is made of (its model when the Bureau can tell, its
 * tools) and the chats had with it.
 */
import type { Page } from '@playwright/test';

import { VIEW_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 1280] as const;

const row = (page: Page, agent: string) => page.locator(`[data-agent="${agent}"]`);
const chatCount = (page: Page, agent: string) => row(page, agent).getByTestId('agent-chat-count');

/** How many chats the list says an agent has had: "No chats yet" is none. */
async function chatsOf(page: Page, agent: string): Promise<number> {
  const text = (await chatCount(page, agent).textContent()) ?? '';
  return Number.parseInt(/^(\d+) chats?$/.exec(text)?.[1] ?? '0', 10);
}

test.describe('the list of agents', () => {
  test('shows each agent as a compact row without a tool count, and offers New chat for every agent', async ({
    page,
  }) => {
    await page.goto('/agents');

    const frame = page.locator('[data-view="agents"]');
    await expect(frame).toHaveAttribute('data-state', 'ready');
    // An absence proves nothing until the rows it is about have rendered.
    await expect(row(page, 'assistant')).toBeVisible();
    await expect(row(page, 'internal')).toBeVisible();
    // Where an agent is defined is for the developer, so it is not said.
    await expect(frame).not.toContainText('Defined in');
    // Its generator is opaque to the Bureau, which cannot say whether it is a script: no model line.
    await expect(row(page, 'assistant')).not.toContainText('Scripted');
    // The row is compact: what an agent is made of is on its page, so no tool count is here.
    await expect(row(page, 'tool-runner')).not.toContainText(/\d+ tools?/);
    await expect(row(page, 'assistant')).not.toContainText('No tools');
    await expect(row(page, 'assistant').getByRole('link', { name: 'New chat' })).toBeVisible();
    await expect(row(page, 'assistant').getByRole('link', { name: 'Memory' })).toBeVisible();
    // The seeded agent the host once kept private takes a chat as the others do.
    await expect(row(page, 'internal').getByRole('link', { name: 'New chat' })).toBeVisible();
  });

  test('counts each agent’s chats and dates the last, and shows a chat had since on the next visit', async ({
    page,
    request,
  }) => {
    await page.goto('/agents');
    await expect(row(page, TEXT_ECHO_AGENT_NAME)).toBeVisible();
    const before = await chatsOf(page, TEXT_ECHO_AGENT_NAME);

    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('usage'), 'A chat for the list');
    await page.goto('/agents');

    await expect(chatCount(page, TEXT_ECHO_AGENT_NAME)).toHaveText(
      `${before + 1} ${before + 1 === 1 ? 'chat' : 'chats'}`,
    );
    await expect(row(page, TEXT_ECHO_AGENT_NAME).getByTestId('agent-last-chat')).toHaveText(
      /^Last chat (just now|\d+[smhd] ago)$/,
    );
    // An agent nobody has chatted with says so, and has no last chat to date.
    await expect(chatCount(page, 'internal')).toHaveText('No chats yet');
    await expect(row(page, 'internal').getByTestId('agent-last-chat')).toHaveCount(0);
  });

  test('opens an agent’s memory from its row', async ({ page }) => {
    await page.goto('/agents');

    await row(page, 'tool-runner').getByRole('link', { name: 'Memory' }).click();

    await expect(page).toHaveURL(/\/agents\/tool-runner\/memories$/);
  });

  test('New chat opens a working new chat with that agent', async ({ page }) => {
    await page.goto('/agents');

    await row(page, 'tool-runner').getByRole('link', { name: 'New chat' }).click();

    await expect(page).toHaveURL(/\/chats\/new\?agent=tool-runner$/);
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue(/tool-runner/i);
  });
});

test.describe('one agent', () => {
  test('shows its name once, its model, and a memory count that opens its memory', async ({
    page,
    request,
  }) => {
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('page'), 'A memory for the page');

    await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}`);

    const frame = page.locator('[data-view="agents"]');
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(TEXT_ECHO_AGENT_NAME);
    // The name is the heading and appears nowhere else in the header: no subtitle repeats it.
    await expect(
      page.getByTestId('agent-header').getByText(TEXT_ECHO_AGENT_NAME, { exact: true }),
    ).toHaveCount(1);
    await expect(frame).not.toContainText('Scripted');
    await expect(frame).not.toContainText('Model');
    await expect(frame).not.toContainText('Defined in');
    await expect(frame).not.toContainText('Revision');
    const memory = frame.getByRole('link', { name: /^Memory \(\d+\+?\)$/ });
    await expect(memory).toHaveCount(1);
    await memory.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${TEXT_ECHO_AGENT_NAME}/memories$`));
  });

  test('lists the chats had with it, and no other agent’s, and New chat opens a new chat with it', async ({
    page,
    request,
  }) => {
    const label = crypto.randomUUID().slice(0, 8);
    await runToEnd(request, 'tool-runner', newThreadId('mine'), `${label} refund for the runner`);
    await runToEnd(request, 'assistant', newThreadId('theirs'), `${label} hello for the assistant`);

    await page.goto('/agents/tool-runner');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('tool-runner');
    // Its tools are named, each as code.
    const tools = page.getByRole('list', { name: 'Tools' });
    await expect(tools.locator('li')).toHaveText(['lookup-order', 'issue-refund']);
    const chats = page.getByRole('navigation', { name: 'Chats with this agent' });
    await expect(chats.getByRole('button', { name: new RegExp(label) })).toHaveCount(1);
    await expect(chats).toContainText('refund for the runner');
    await expect(chats).not.toContainText('hello for the assistant');
    await page.getByRole('link', { name: 'New chat' }).first().click();
    await expect(page).toHaveURL(/\/chats\/new\?agent=tool-runner$/);
  });

  test('opens a chat from its list', async ({ page, request }) => {
    const threadId = newThreadId('open');
    await runToEnd(request, 'tool-runner', threadId, 'Open this one from the agent page');
    await page.goto('/agents/tool-runner');

    await page
      .getByRole('navigation', { name: 'Chats with this agent' })
      .getByRole('button', { name: /Open this one from the agent page/ })
      .click();

    await expect(page).toHaveURL(new RegExp(`/chats/${threadId}$`));
  });

  test('offers a chat with the agent the host once kept private', async ({ page }) => {
    await page.goto('/agents/internal');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('internal');
    await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible();
  });

  test('is not found for an identifier the Bureau does not list', async ({ page }) => {
    await page.goto('/agents/nobody');

    const frame = page.locator('[data-view="agents"]');
    await expect(frame).toHaveAttribute('data-state', 'not-found');
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.agents.notFound?.title ?? '',
    );
  });
});

for (const width of WIDTHS) {
  test.describe(`at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('the list of agents passes axe, with a chat count and a model', async ({
      page,
      request,
      checkA11y,
    }) => {
      await runToEnd(request, 'tool-runner', newThreadId('listaxe'), 'A chat for the agents list');
      await page.goto('/agents');
      await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
      await expect(chatCount(page, 'tool-runner')).toHaveText(/^\d+ chats?$/);
      await checkA11y(`the list of agents at ${width}px`);
      // No row makes the page scroll sideways.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    });

    test('an agent’s page passes axe', async ({ page, request, checkA11y }) => {
      await runToEnd(request, 'tool-runner', newThreadId('axe'), 'A chat for the agent page');
      await page.goto('/agents/tool-runner');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('tool-runner');
      await checkA11y(`an agent's page at ${width}px`);
    });

    test('a maximum-length identifier breaks inside the outlet, in the list and on the page', async ({
      page,
    }) => {
      const identifier = `long-${'x'.repeat(59)}`;
      expect(identifier).toHaveLength(64);
      // A tool or a skill is as long as an identifier may be, and a chip never wraps by itself.
      const longTool = `tool-${'t'.repeat(59)}`;
      const longSkill = `skill-${'s'.repeat(58)}`;
      expect(longTool).toHaveLength(64);
      expect(longSkill).toHaveLength(64);
      const withChips = `chips-${'c'.repeat(58)}`;
      const withSkills = `skills-${'k'.repeat(57)}`;
      expect(withSkills).toHaveLength(64);
      // The Bureau answers as it does, with more agents in the list: one named by its identifier
      // alone, one with a short display name beside the long identifier, one defined in code with
      // the long tool listed twice (a toolbox may hold two tools under one name), and one file
      // agent with the long tool and the long skill.
      await page.route('**/bureau/jsonrpc', async (route) => {
        const posted = route.request().postData() ?? '';
        if (posted.includes('"bureau.agents.definitions.get"') && posted.includes(withSkills)) {
          const { id } = JSON.parse(posted) as { id: unknown };
          await route.fulfill({
            json: {
              jsonrpc: '2.0',
              id,
              result: {
                id: withSkills,
                source: 'file',
                state: 'ready',
                name: withSkills,
                description: null,
                a2a: false,
                hash: 'a'.repeat(64),
                problem: null,
                definition: {
                  name: withSkills,
                  description: null,
                  a2a: false,
                  model: `provider/${'m'.repeat(55)}`,
                  tools: [longTool, longTool],
                  skillDescriptors: [
                    { id: 'skill-a', name: longSkill, description: '', tags: [] },
                    { id: 'skill-b', name: longSkill, description: '', tags: [] },
                  ],
                  instructions: '',
                },
              },
            },
          });
          return;
        }
        if (!posted.includes('"bureau.agents.list"')) {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        const body = (await response.json()) as { result: { agents: unknown[] } };
        const agent = (
          name: string,
          displayName: string,
          extra: { kind?: string; tools?: string[] } = {},
        ) => ({
          name,
          displayName,
          description: null,
          definitionRevision: 1,
          kind: 'code',
          a2a: false,
          media: null,
          tools: [],
          ...extra,
        });
        body.result.agents.push(
          agent(identifier, identifier),
          agent(`named-${identifier.slice(6)}`, 'Short'),
          agent(withChips, withChips, { tools: [longTool, longTool] }),
          agent(withSkills, withSkills, { kind: 'file', tools: [longTool, longTool] }),
        );
        await route.fulfill({ response, json: body });
      });
      // The outlet is what scrolls sideways when a row is wider than it, not the document.
      const fits = () =>
        page.evaluate(() => {
          const outlet = document.querySelector('.weft-shell-outlet');
          return (
            outlet !== null &&
            outlet.scrollWidth <= outlet.clientWidth &&
            document.documentElement.scrollWidth <= document.documentElement.clientWidth
          );
        });

      await page.goto('/agents');
      await expect(row(page, identifier)).toBeVisible();
      await expect(row(page, `named-${identifier.slice(6)}`)).toBeVisible();
      expect(await fits()).toBe(true);

      for (const name of [identifier, `named-${identifier.slice(6)}`, withChips, withSkills]) {
        await page.goto(`/agents/${name}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await fits()).toBe(true);
      }
      // The same tool listed twice shows twice, without the page failing on a repeated key, and so
      // do two skills that share a name.
      await expect(page.getByRole('list', { name: 'Tools' }).getByRole('listitem')).toHaveCount(2);
      await expect(page.getByRole('list', { name: 'Skills' }).getByRole('listitem')).toHaveCount(2);
      expect(await fits()).toBe(true);
    });

    test('the page of the agent the host once kept private passes axe', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/agents/internal');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('internal');
      await checkA11y(`the internal agent's page at ${width}px`);
    });

    test('a missing agent is not found, and passes axe', async ({ page, checkA11y }) => {
      await page.goto('/agents/nobody');
      await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'not-found');
      await checkA11y(`a missing agent at ${width}px`);
    });

    test('a new chat passes axe, and so does an unknown agent’s', async ({ page, checkA11y }) => {
      await page.goto('/chats/new');
      await expect(page.getByRole('combobox', { name: 'Agent' })).toBeVisible();
      await checkA11y(`a new chat at ${width}px`);

      await page.goto('/chats/new?agent=no-such-agent');
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'not-found');
      await checkA11y(`a new chat with an unknown agent at ${width}px`);
    });

    test('the list of chats passes axe', async ({ page, request, checkA11y }) => {
      await runToEnd(request, 'assistant', newThreadId('listaxe'), 'A chat for the list');
      await page.goto('/chats');
      await expect(page.getByRole('navigation', { name: 'Chats' })).toBeVisible();
      await checkA11y(`the list of chats at ${width}px`);
    });
  });
}
