/**
 * An agent's Access tab against the real host: set when a tool asks first in the tab, which saves
 * at once, and see the file hold it, then chat with the agent as another client would and see the
 * setting enforced. `demo:lookup-order` only reads, so under its default (Never) a chat runs it;
 * the ask in the second case is the tab's doing alone. A budget the tab does not show (tool calls
 * per run) survives the tab's write and stops a run. The chats are scripted by markers
 * (`access-provider.ts`). A skill from a trusted source can be granted; one from a source the host
 * does not trust has its box disabled with the reason, and the Bureau refuses the write too.
 */
import type { Page } from '@playwright/test';

import { ACCESS_LOOKUP_MARKER, ACCESS_LOOP_MARKER } from './access-provider.ts';
import { bureau, createAgentFile, readAgent, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { E2E_SKILLS } from './skills-support.ts';

const agents = new Set<string>();
const threads: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of agents) await removeAgent(request, id);
  agents.clear();
  await deleteChats(threads.splice(0));
});

async function agentWithLookup(
  request: Parameters<typeof createAgentFile>[0],
  id: string,
  definition: Record<string, unknown> = {},
) {
  agents.add(id);
  await createAgentFile(request, id, { tools: ['demo:lookup-order'], ...definition });
}

/** The definition the Bureau holds for the agent now. */
async function definitionOf(request: Parameters<typeof readAgent>[0], id: string) {
  const detail = await readAgent(request, id);
  return detail.definition;
}

/** Makes one change on the Access tab, which saves at once, and waits for the Bureau to take it. */
async function saved(page: Page, change: () => Promise<void>): Promise<void> {
  // The answer to the update says the Bureau took the change; the row's spinner only says it was sent.
  const answered = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes('bureau.agents.definitions.update') === true,
  );
  await change();
  const response = await answered;
  expect(response.ok()).toBe(true);
  await expect(page.getByTestId('agent-access-saved')).toBeVisible();
}

/** The Asks select of the Lookup order row. */
const lookupAsks = (page: Page) => page.locator('[data-tool="demo:lookup-order"] select');

/** The tool approvals the Bureau holds, waiting on a run's tool call. */
async function pendingApprovals(request: Parameters<typeof bureau>[0], threadId: string) {
  const answer = await bureau(request, 'bureau.reviews.list', {});
  expect(answer.fault).toBeUndefined();
  const reviews = (answer.result as { reviews: { kind: string; sessionId?: string }[] }).reviews;
  return reviews.filter(
    (review) => review.kind === 'tool-approval' && review.sessionId === threadId,
  );
}

test.describe('the Access tab', () => {
  test('a per-tool Always set in the tab holds a chat on an approval before the tool runs', async ({
    page,
    request,
  }) => {
    const id = 'e2e-access-always';
    await agentWithLookup(request, id);

    // Before: a read runs without asking.
    const before = newThreadId('access-before');
    threads.push(before);
    const first = await runToEnd(request, id, before, `${ACCESS_LOOKUP_MARKER} Find order-1001`);
    expect(first).toContain('The order was looked up.');
    expect(first).not.toContain('"type":"interrupt"');

    await page.goto(`/agents/${id}/access`);
    await saved(page, () =>
      lookupAsks(page)
        .selectOption('always')
        .then(() => undefined),
    );
    expect(await definitionOf(request, id)).toMatchObject({
      approvals: { 'demo:lookup-order': 'always' },
    });

    // After: the same chat is held on an approval, and the tool has not run.
    const after = newThreadId('access-after');
    threads.push(after);
    const second = await runToEnd(request, id, after, `${ACCESS_LOOKUP_MARKER} Find order-1001`);
    expect(second).toContain('"type":"interrupt"');
    expect(second).not.toContain('The order was looked up.');
    await expect
      .poll(async () => {
        const approvals = await pendingApprovals(request, after);
        return approvals.length;
      })
      .toBe(1);
  });

  test('a budget the tab does not show survives its write, stops a run, and says which limit it reached', async ({
    page,
    request,
  }) => {
    const id = 'e2e-access-budget';
    await agentWithLookup(request, id, { limits: { tools: { calls: 1 } } });

    await page.goto(`/agents/${id}/access`);
    await saved(page, () =>
      lookupAsks(page)
        .selectOption('blocked')
        .then(() => undefined),
    );
    await saved(page, () =>
      lookupAsks(page)
        .selectOption('never')
        .then(() => undefined),
    );
    expect(await definitionOf(request, id)).toMatchObject({
      limits: { tools: { calls: 1 } },
    });

    const thread = newThreadId('access-budget');
    threads.push(thread);
    const stream = await runToEnd(request, id, thread, `${ACCESS_LOOP_MARKER} Keep looking`);
    expect(stream).toContain('"code":"BUDGET_EXCEEDED"');
    expect(stream).toContain('Budget exceeded: max calls 1');

    // A person chatting with the agent is told too.
    await page.goto(`/chats/new?agent=${id}`);
    const composer = page.getByRole('textbox');
    await composer.fill(`${ACCESS_LOOP_MARKER} Keep looking`);
    await composer.press('Enter');
    await expect(page.getByText('Budget exceeded: max calls 1').first()).toBeVisible();
    // The chat this made is not one of the spec's threads, so it is found by its address and removed.
    await expect(page).toHaveURL(/\/chats\/(?!new(?:$|\?))[^/?]+$/);
    // The reason is not only for the page that watched the run: the chat says it again once reloaded.
    await page.reload();
    await expect(page.getByText('Budget exceeded: max calls 1').first()).toBeVisible();
    threads.push(decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? ''));
  });

  test('withdrawing a tool drops its approval from the file in the same write', async ({
    page,
    request,
  }) => {
    const id = 'e2e-access-withdraw';
    await agentWithLookup(request, id);

    await page.goto(`/agents/${id}/access`);
    await saved(page, () =>
      lookupAsks(page)
        .selectOption('always')
        .then(() => undefined),
    );
    await saved(page, () =>
      page.locator('[data-tool="demo:lookup-order"] input[type="checkbox"]').uncheck(),
    );

    const definition = await definitionOf(request, id);
    expect(definition?.tools).toEqual([]);
    expect(definition).not.toHaveProperty('approvals.demo:lookup-order');
  });

  test('grants a trusted skill, and cannot grant an untrusted one', async ({ page, request }) => {
    const id = 'e2e-access-skills';
    await agentWithLookup(request, id);

    await page.goto(`/agents/${id}/access`);
    const skills = page.getByTestId('agent-access-skills');
    const untrusted = skills.locator(`[data-skill="${E2E_SKILLS.deploy.name}"]`);
    await expect(untrusted).toHaveAttribute('data-trust', 'untrusted');
    await expect(untrusted.getByRole('checkbox')).toBeDisabled();
    await expect(untrusted).toContainText('source is not trusted');

    const summarize = skills.locator(
      `[data-skill="${E2E_SKILLS.summarize.name}"] input[type="checkbox"]`,
    );
    await saved(page, () => summarize.check());
    const granted = await definitionOf(request, id);
    expect(granted?.skills).toEqual([E2E_SKILLS.summarize.name]);

    await page.reload();
    await expect(summarize).toBeChecked();
  });

  test('the write operation refuses an untrusted skill', async ({ request }) => {
    const id = 'e2e-access-skill-refused';
    await agentWithLookup(request, id);
    const before = await readAgent(request, id);
    const definition = before.definition;
    if (definition === null) throw new Error('expected a definition');

    const refused = await bureau(request, 'bureau.agents.definitions.update', {
      id,
      expectedHash: before.hash,
      definition: {
        model: definition.model,
        instructions: definition.instructions,
        skills: [E2E_SKILLS.deploy.name],
      },
    });

    expect(refused.fault?.code).toBe('Unprocessable');
    const unchanged = await definitionOf(request, id);
    expect(unchanged?.skills).toBeNull();
  });
});

for (const width of [375, 768, 1280] as const) {
  test(`the Access tab passes axe at ${width} pixels`, async ({ page, request, checkA11y }) => {
    await page.setViewportSize({ width, height: 900 });
    const id = 'e2e-access-axe';
    await agentWithLookup(request, id);
    await page.goto(`/agents/${id}/access`);
    await expect(page.getByTestId('agent-access-skills')).toBeVisible();
    await checkA11y(`the Access tab of an agent at ${width}px`);
  });
}
