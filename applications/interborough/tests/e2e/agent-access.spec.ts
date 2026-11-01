/**
 * An agent's Access tab against the real host: set when a tool asks first and a budget in the
 * tab, save, and see the file hold it, then chat with the agent as another client would and see the
 * setting enforced. `demo:lookup-order` only reads, so under the default (`on-changes`) a chat runs it;
 * the ask in the second case is the tab's doing alone. The chats are scripted by markers
 * (`access-provider.ts`). A skill from a trusted source can be granted; one from a source the host
 * does not trust has its box disabled with the reason, and the Bureau refuses the write too.
 */
import type { Page } from '@playwright/test';

import { AGENT_PAGE_COPY } from '../../src/app/copy.ts';
import { ACCESS_LOOKUP_MARKER, ACCESS_LOOP_MARKER } from './access-provider.ts';
import { bureau, createAgentFile, readAgent, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { E2E_SKILLS } from './skills-support.ts';

const copy = AGENT_PAGE_COPY.access;

const agents = new Set<string>();
const threads: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of agents) await removeAgent(request, id);
  agents.clear();
  await deleteChats(threads.splice(0));
});

async function agentWithLookup(request: Parameters<typeof createAgentFile>[0], id: string) {
  agents.add(id);
  await createAgentFile(request, id, { tools: ['demo:lookup-order'] });
}

/** The definition the Bureau holds for the agent now. */
async function definitionOf(request: Parameters<typeof readAgent>[0], id: string) {
  const detail = await readAgent(request, id);
  return detail.definition;
}

/** Saves the form on the Access tab and waits for the Bureau to take it. */
async function save(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: copy.saveAction });
  await expect(button).toBeEnabled();
  // The button is disabled while the save is in flight as well as after it, so it cannot say that
  // the Bureau took the form; the answer to the update can.
  const answered = page.waitForResponse(
    (response) =>
      response.request().postData()?.includes('bureau.agents.definitions.update') === true,
  );
  await button.click();
  const response = await answered;
  expect(response.ok()).toBe(true);
  await expect(button).toBeDisabled();
}

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

    await page.goto(`/agents/${id}?tab=access`);
    await page
      .getByRole('combobox', { name: copy.asksFirstLabel('demo:lookup-order') })
      .selectOption('always');
    await save(page);
    expect(await definitionOf(request, id)).toMatchObject({
      toolApproval: { 'demo:lookup-order': 'always' },
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

  test('a budget set in the tab stops a run, and the run says which limit it reached', async ({
    page,
    request,
  }) => {
    const id = 'e2e-access-budget';
    await agentWithLookup(request, id);

    await page.goto(`/agents/${id}?tab=access`);
    await page.getByLabel('Tool calls per run').fill('1');
    await save(page);
    expect(await definitionOf(request, id)).toMatchObject({
      toolBudget: { maxCalls: 1 },
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

    await page.goto(`/agents/${id}?tab=access`);
    await page
      .getByRole('combobox', { name: copy.asksFirstLabel('demo:lookup-order') })
      .selectOption('never');
    await save(page);
    await page.getByRole('checkbox', { name: 'demo:lookup-order' }).uncheck();
    await save(page);

    const definition = await definitionOf(request, id);
    expect(definition?.tools).toEqual([]);
    expect(definition).not.toHaveProperty('toolApproval.demo:lookup-order');
  });

  test('grants a trusted skill, and cannot grant an untrusted one', async ({ page, request }) => {
    const id = 'e2e-access-skills';
    await agentWithLookup(request, id);

    await page.goto(`/agents/${id}?tab=access`);
    const skills = page.getByTestId('agent-access-skills');
    const untrusted = skills.locator(`[data-skill="${E2E_SKILLS.deploy.name}"]`);
    await expect(untrusted).toHaveAttribute('data-trust', 'untrusted');
    await expect(untrusted.getByRole('checkbox')).toBeDisabled();
    await expect(untrusted).toContainText('source is not trusted');

    await skills.getByRole('checkbox', { name: E2E_SKILLS.summarize.name }).check();
    await save(page);
    const granted = await definitionOf(request, id);
    expect(granted?.allowedSkills).toEqual([E2E_SKILLS.summarize.name]);

    await page.reload();
    await expect(skills.getByRole('checkbox', { name: E2E_SKILLS.summarize.name })).toBeChecked();
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
        allowedSkills: [E2E_SKILLS.deploy.name],
      },
    });

    expect(refused.fault?.code).toBe('Unprocessable');
    const unchanged = await definitionOf(request, id);
    expect(unchanged?.allowedSkills).toBeNull();
  });
});

for (const width of [375, 768, 1280] as const) {
  test(`the Access tab passes axe at ${width} pixels`, async ({ page, request, checkA11y }) => {
    await page.setViewportSize({ width, height: 900 });
    const id = 'e2e-access-axe';
    await agentWithLookup(request, id);
    await page.goto(`/agents/${id}?tab=access`);
    await expect(page.getByTestId('agent-access-skills')).toBeVisible();
    await checkA11y(`the Access tab of an agent at ${width}px`);
  });
}
