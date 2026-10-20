/**
 * `/agents/:id/memory`: what an agent remembers of the caller's chats, a search over it, one
 * memory's lineage, and forgetting and correcting.
 *
 * Every case seeds its memory with a scripted chat turn. The host has one memory writer, the
 * persist hook of a run, so a memory comes from an agent answering in a chat; the `echo-text` agent
 * (`text-echo-agent.ts`) answers with what it was sent, so a case that sends a unique label stores a
 * memory that is its own, whatever the seeded agents' fixed replies have stored in the same run.
 */
import type { Page } from '@playwright/test';

import { MEMORY_COPY, VIEW_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { TEXT_ECHO_AGENT_NAME, TEXT_ECHO_SOLO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 1280] as const;

const MEMORY_PATH = `/agents/${TEXT_ECHO_AGENT_NAME}/memory`;

/** A label no other case stores: it is both what the agent is sent and what it remembers. */
const uniqueLabel = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 8)}`;

const frame = (page: Page) => page.locator('[data-view="agents"]');
const rowOf = (page: Page, text: string) => page.locator('[data-memory]', { hasText: text });
const detailOf = (page: Page) => page.getByRole('region', { name: MEMORY_COPY.detail.heading });

/** Opens the details of the memory whose text is `text`. */
async function openDetails(page: Page, text: string) {
  await rowOf(page, text)
    .getByRole('button', { name: new RegExp(MEMORY_COPY.openDetails) })
    .click();
  await expect(detailOf(page)).toBeVisible();
}

test.describe('the memory page', () => {
  test('lists a memory a chat stored, searches it, and shows where it came from', async ({
    page,
    request,
  }) => {
    const label = uniqueLabel('Window seat');
    const threadId = newThreadId('memory');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, threadId, label);
    await runToEnd(
      request,
      TEXT_ECHO_AGENT_NAME,
      newThreadId('memory-other'),
      uniqueLabel('Aisle'),
    );

    await page.goto(MEMORY_PATH);

    await expect(frame(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(MEMORY_COPY.heading);
    await expect(rowOf(page, label)).toHaveCount(1);

    // A search ranks every memory the agent has, best first, and says how relevant each is.
    await page.getByRole('searchbox', { name: MEMORY_COPY.searchLabel }).fill(label);
    await page.getByRole('button', { name: MEMORY_COPY.searchAction, exact: true }).click();
    await expect(page.locator('[data-memory]').first()).toContainText(label);
    await expect(page.locator('[data-memory]').first()).toContainText(MEMORY_COPY.relevance);

    await openDetails(page, label);
    const detail = detailOf(page);
    const field = (name: string) =>
      detail.locator('dt', { hasText: name }).locator('xpath=following-sibling::dd[1]');
    await expect(field(MEMORY_COPY.detail.fields.source)).toHaveText(
      MEMORY_COPY.source.conversation,
    );
    await expect(field(MEMORY_COPY.detail.fields.trust)).toHaveText(MEMORY_COPY.trust.untrusted);
    await expect(field(MEMORY_COPY.detail.fields.memoryClass)).toHaveText(
      MEMORY_COPY.memoryClass.episodic,
    );
    await expect(field(MEMORY_COPY.detail.fields.session).getByRole('link')).toHaveAttribute(
      'href',
      `/chat/${threadId}`,
    );
    // The run that wrote it is named from the governance ledger.
    await expect(field(MEMORY_COPY.detail.fields.run)).not.toHaveText(
      MEMORY_COPY.detail.notRecorded,
    );
    await expect(field(MEMORY_COPY.detail.fields.legalHold)).toHaveText(
      MEMORY_COPY.detail.legalHold.unknown,
    );
  });

  test('forgets a memory and no longer lists it', async ({ page, request }) => {
    const label = uniqueLabel('Forget me');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-forget'), label);
    // A second memory keeps the agent from being empty when this one goes.
    await runToEnd(
      request,
      TEXT_ECHO_AGENT_NAME,
      newThreadId('memory-keep'),
      uniqueLabel('Keep me'),
    );
    await page.goto(MEMORY_PATH);
    await openDetails(page, label);

    await detailOf(page).getByRole('button', { name: MEMORY_COPY.forget.action }).click();
    const dialog = page.getByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }).click();

    await expect(
      page.getByText(MEMORY_COPY.forget.outcome.completed.title, { exact: true }),
    ).toBeVisible();
    await expect(rowOf(page, label)).toHaveCount(0);
  });

  test('keeps the deletion’s receipt on screen when the agent’s only memory is forgotten', async ({
    page,
    request,
  }) => {
    const label = uniqueLabel('Only memory');
    await runToEnd(request, TEXT_ECHO_SOLO_AGENT_NAME, newThreadId('memory-solo'), label);
    await page.goto(`/agents/${TEXT_ECHO_SOLO_AGENT_NAME}/memory`);
    await openDetails(page, label);

    await detailOf(page).getByRole('button', { name: MEMORY_COPY.forget.action }).click();
    const dialog = page.getByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await dialog.getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }).click();

    // The page says nothing is left, and the receipt is still there to read.
    await expect(page.getByText(MEMORY_COPY.nothingLeft)).toBeVisible();
    await expect(
      page.getByText(MEMORY_COPY.forget.outcome.completed.title, { exact: true }),
    ).toBeVisible();
    await expect(frame(page)).toHaveAttribute('data-state', 'ready');
    // Opening the page again asks the Bureau again, and the agent is empty.
    await page.goto(`/agents/${TEXT_ECHO_SOLO_AGENT_NAME}/memory`);
    await expect(frame(page)).toHaveAttribute('data-state', 'empty');
  });

  test('is empty for an agent that has remembered nothing', async ({ page }) => {
    // `internal` is never published, so no chat can reach it.
    await page.goto('/agents/internal/memory');

    await expect(frame(page)).toHaveAttribute('data-state', 'empty');
    await expect(frame(page).getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.agents.emptyByPattern?.['/agents/:id/memory']?.title ?? '',
    );
  });

  test('is not found for an agent the Bureau does not list', async ({ page }) => {
    await page.goto('/agents/nobody/memory');

    await expect(frame(page)).toHaveAttribute('data-state', 'not-found');
    await expect(frame(page).getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.agents.notFound?.title ?? '',
    );
  });

  test('is reached from the agent’s own page', async ({ page }) => {
    await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}`);

    await page.getByRole('link', { name: MEMORY_COPY.link }).click();

    await expect(page).toHaveURL(new RegExp(`${MEMORY_PATH}$`));
    await expect(frame(page)).toHaveAttribute('data-view', 'agents');
  });
});

for (const width of WIDTHS) {
  test.describe(`at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('corrects a memory and the list shows the correction in its place', async ({
      page,
      request,
      checkA11y,
    }) => {
      const original = uniqueLabel(`Original at ${width}`);
      const correction = uniqueLabel(`Correction at ${width}`);
      await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-correct'), original);
      await page.goto(MEMORY_PATH);
      await expect(frame(page)).toHaveAttribute('data-state', 'ready');
      await expect(rowOf(page, original)).toHaveCount(1);
      await checkA11y(`an agent's memory at ${width}px`);

      await openDetails(page, original);
      await checkA11y(`a memory's details at ${width}px`);
      await detailOf(page).getByRole('button', { name: MEMORY_COPY.correct.action }).click();
      const dialog = page.getByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel(MEMORY_COPY.correct.dialog.label)).toHaveValue(original);
      await checkA11y(`the correction dialog at ${width}px`);
      await dialog.getByLabel(MEMORY_COPY.correct.dialog.label).fill(correction);
      await dialog.getByRole('button', { name: MEMORY_COPY.correct.dialog.submit }).click();

      // The correction is listed and the original is not, and the page says it was replaced.
      await expect(page.getByText(MEMORY_COPY.correct.saved.title, { exact: true })).toBeVisible();
      await expect(rowOf(page, correction)).toHaveCount(1);
      await expect(rowOf(page, original)).toHaveCount(0);
      // The page opened the correction, whose lineage links back to the memory it replaced.
      const opened = detailOf(page);
      await expect(opened.locator('blockquote', { hasText: correction })).toBeVisible();
      await expect(
        opened
          .locator('dt', { hasText: MEMORY_COPY.detail.fields.source })
          .locator('xpath=following-sibling::dd[1]'),
      ).toHaveText(MEMORY_COPY.source.operator);
      await opened
        .locator('dt', { hasText: MEMORY_COPY.detail.fields.corrects })
        .locator('xpath=following-sibling::dd[1]')
        .getByRole('button', { name: MEMORY_COPY.detail.openMemory })
        .click();
      await expect(opened.locator('blockquote', { hasText: original })).toBeVisible();
      await checkA11y(`a corrected memory's original at ${width}px`);
    });
  });
}
