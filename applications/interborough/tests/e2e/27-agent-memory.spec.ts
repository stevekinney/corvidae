/**
 * `/agents/:id/memory`: what an agent remembers of the caller's chats, a search over it, one
 * memory's lineage, and forgetting and correcting.
 *
 * Every case seeds its memory with a scripted chat turn. The host has one memory writer, the
 * persist hook of a run, so a memory comes from an agent answering in a chat; the `echo-text` agent
 * (`text-echo-agent.ts`) answers with what it was sent, so a case that sends a unique label stores a
 * memory that is its own, whatever the seeded agents' fixed replies have stored in the same run.
 */
import type { Locator, Page } from '@playwright/test';

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

/** Opens the details of the memory whose text is `text`, by clicking its row. */
async function openDetails(page: Page, text: string) {
  await rowOf(page, text).locator('.weft-memory__content').click();
  await expect(detailOf(page)).toBeVisible();
}

/** A row's Forget or Correct: named for the memory (`Forget: <text>`), so a memory whose own words say "forget" is not mistaken for it. */
const rowAction = (row: Locator, action: string) =>
  row.getByRole('button', { name: new RegExp(`^${action}:`) });

/** Forgets the memory whose text is `text` from its row, and confirms the question. */
async function forgetFromRow(page: Page, text: string) {
  const row = rowOf(page, text);
  await row.hover();
  await rowAction(row, MEMORY_COPY.forget.action).click();
  const dialog = page.getByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }).click();
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

    // A search lists the memories that match, best first, says how relevant each is and how many
    // of the agent's memories match, and marks the words it was given.
    await page.getByRole('searchbox', { name: MEMORY_COPY.searchLabel }).fill(label);
    await page.getByRole('button', { name: MEMORY_COPY.searchAction, exact: true }).click();
    // The memory with the unique label matches, and shows its relevance; which row ranks first
    // is the Bureau's business and is not asserted.
    await expect(rowOf(page, label)).toHaveCount(1);
    await expect(rowOf(page, label)).toContainText(MEMORY_COPY.relevance);
    await expect(page.getByTestId('memory-match-count')).toHaveText(
      /^\d+\+? (of \d+ )?memor(y matches|ies match)$/,
    );
    await expect(rowOf(page, label).locator('mark').first()).toHaveText(label.split(' ')[0] ?? '');
    // A memory that holds none of the words searched for is not a match, whatever it scored.
    await expect(page.locator('[data-memory]', { hasText: 'Aisle' })).toHaveCount(0);

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

    await forgetFromRow(page, label);

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

    await forgetFromRow(page, label);

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

  test('opens a row on click, shows its actions on hover, and has no Details button', async ({
    page,
    request,
  }) => {
    const label = uniqueLabel('Row opens');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-row'), label);
    await page.goto(MEMORY_PATH);
    const row = rowOf(page, label);
    const actions = row.locator('.weft-memory__actions');
    await expect(row).toHaveCount(1);

    await expect(page.getByRole('button', { name: /^Details/ })).toHaveCount(0);
    // Hovering the row shows Forget and Correct, and so does holding focus in it.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(actions).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(rowAction(row, MEMORY_COPY.forget.action)).toBeVisible();
    await expect(rowAction(row, MEMORY_COPY.correct.action)).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS('opacity', '0');
    await rowAction(row, MEMORY_COPY.correct.action).focus();
    await expect(actions).toHaveCSS('opacity', '1');

    // The kind reads in plain words, is part of the opener, and says what it means to a screen
    // reader; a keyboard user who focuses the row sees the same sentence.
    const opener = row.locator('.cinder-selectable-row__primary');
    await expect(opener).toContainText(MEMORY_COPY.kind.episodic.label);
    await expect(opener).toHaveAccessibleDescription(MEMORY_COPY.kind.episodic.description);
    await opener.focus();
    await expect(
      page.getByRole('tooltip', { name: MEMORY_COPY.kind.episodic.description }),
    ).toBeVisible();

    await row.locator('.weft-memory__content').click();
    await expect(detailOf(page)).toBeVisible();
    await expect(row).toHaveAttribute('data-selected', 'true');
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

    test('shows how many memories a search ranked, with the words marked', async ({
      page,
      request,
      checkA11y,
    }) => {
      const label = uniqueLabel(`Searched at ${width}`);
      await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-search'), label);
      await page.goto(MEMORY_PATH);
      await expect(rowOf(page, label)).toHaveCount(1);

      await page.getByRole('searchbox', { name: MEMORY_COPY.searchLabel }).fill(label);
      await page.getByRole('button', { name: MEMORY_COPY.searchAction, exact: true }).click();

      await expect(page.getByTestId('memory-match-count')).toContainText('match');
      await expect(page.locator('mark').first()).toBeVisible();
      await checkA11y(`a memory search at ${width}px`);

      // A query that shares nothing with any memory matches none, and says so with a way back.
      const nonsense = `qzxv${crypto.randomUUID().replaceAll('-', '')}`;
      await page.getByRole('searchbox', { name: MEMORY_COPY.searchLabel }).fill(nonsense);
      await page.getByRole('button', { name: MEMORY_COPY.searchAction, exact: true }).click();
      await expect(page.getByTestId('memory-match-count')).toHaveText(
        MEMORY_COPY.noMatch(nonsense),
      );
      await expect(page.locator('[data-memory]')).toHaveCount(0);
      await checkA11y(`an empty memory search at ${width}px`);
      await page.getByRole('button', { name: MEMORY_COPY.clearMatch }).click();
      await expect(rowOf(page, label)).toHaveCount(1);
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
      // A correction starts from the row itself, with no need to open the details first.
      const row = rowOf(page, original);
      await row.hover();
      await checkA11y(`a memory's row with its actions at ${width}px`);
      await rowAction(row, MEMORY_COPY.correct.action).click();
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
