/**
 * `/agents/:agent/memories`: what an agent remembers of the caller's chats as a list with the open
 * memory beside it, a search that runs as you type, a kind filter, one memory's facts, forgetting,
 * correcting in place, and the governance actions (share, legal hold, quarantine, export).
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

const MEMORY_PATH = `/agents/${TEXT_ECHO_AGENT_NAME}/memories`;

/** A label no other case stores: it is both what the agent is sent and what it remembers. */
const uniqueLabel = (prefix: string) => `${prefix} ${crypto.randomUUID().slice(0, 8)}`;

const frame = (page: Page) => page.locator('[data-view="agents"]');
const rowOf = (page: Page, text: string) => page.locator('[data-memory]', { hasText: text });
const detailOf = (page: Page) => page.getByRole('region', { name: MEMORY_COPY.detail.heading });
const searchOf = (page: Page) => page.getByRole('searchbox', { name: MEMORY_COPY.searchLabel });

/** Opens the details of the memory whose text is `text`, by clicking its row. */
async function openDetails(page: Page, text: string) {
  await rowOf(page, text).locator('.ib-memory__content').click();
  await expect(detailOf(page).locator('blockquote', { hasText: text })).toBeVisible();
}

/** Forgets the memory whose text is `text` from its details, and confirms the question. */
async function forgetFromDetails(page: Page, text: string) {
  await openDetails(page, text);
  await detailOf(page).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }).click();
  const dialog = page.getByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
  await expect(dialog).toBeVisible();
  // The question names what goes.
  await expect(dialog).toContainText(text.slice(0, 20));
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
    await searchOf(page).fill(label);
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
    await expect(field(MEMORY_COPY.detail.fields.kind)).toHaveText(MEMORY_COPY.kind.episodic.label);
    await expect(field(MEMORY_COPY.detail.fields.session).getByRole('link')).toHaveAttribute(
      'href',
      `/chats/${threadId}`,
    );
    // The run that wrote it is named from the governance ledger.
    await expect(field(MEMORY_COPY.detail.fields.run)).not.toHaveText(
      MEMORY_COPY.detail.notRecorded,
    );
    // Nothing has said whether it is held, so the page does not guess.
    await expect(
      detail.locator('dt', { hasText: MEMORY_COPY.detail.fields.legalHold }),
    ).toHaveCount(0);
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

    await forgetFromDetails(page, label);

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
    await page.goto(`/agents/${TEXT_ECHO_SOLO_AGENT_NAME}/memories`);

    await forgetFromDetails(page, label);

    // The page says nothing is left, and the receipt is still there to read.
    await expect(page.getByRole('heading', { name: MEMORY_COPY.nothingLeft.title })).toBeVisible();
    await expect(
      page.getByText(MEMORY_COPY.forget.outcome.completed.title, { exact: true }),
    ).toBeVisible();
    await expect(frame(page)).toHaveAttribute('data-state', 'ready');
    // Opening the page again asks the Bureau again, and the agent is empty.
    await page.goto(`/agents/${TEXT_ECHO_SOLO_AGENT_NAME}/memories`);
    await expect(frame(page)).toHaveAttribute('data-state', 'empty');
  });

  test('opens a row on click, names its kind in plain words, and keeps the engine’s term for the details', async ({
    page,
    request,
  }) => {
    const label = uniqueLabel('Row opens');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-row'), label);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MEMORY_PATH);
    const row = rowOf(page, label);
    await expect(row).toHaveCount(1);

    // A row has one button: the opener. Correct and Forget are on the open memory.
    await expect(row.locator('xpath=ancestor::li').getByRole('button')).toHaveCount(1);
    await expect(row).toContainText(MEMORY_COPY.plainKind.chats);
    await expect(row).not.toContainText(MEMORY_COPY.kind.episodic.label);

    await row.locator('.ib-memory__content').click();
    await expect(detailOf(page)).toBeVisible();
    await expect(
      detailOf(page).getByText(MEMORY_COPY.kind.episodic.label, { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/[?&]memory=/);
  });

  test('narrows the list to a kind in plain words, over the memories loaded so far', async ({
    page,
    request,
  }) => {
    const label = uniqueLabel('Kind filter');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-kind'), label);
    await page.goto(MEMORY_PATH);
    await expect(rowOf(page, label)).toHaveCount(1);

    // The agent's chat turns are remembered as what it learned in a chat.
    await page.getByLabel(MEMORY_COPY.filter.label).selectOption('chats');
    await expect(rowOf(page, label)).toHaveCount(1);
    await page.getByLabel(MEMORY_COPY.filter.label).selectOption('you');
    await expect(rowOf(page, label)).toHaveCount(0);
  });

  test('places and releases a legal hold, and the fact shows only once it is known', async ({
    page,
    request,
  }) => {
    const label = uniqueLabel('Hold me');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-hold'), label);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MEMORY_PATH);
    await openDetails(page, label);
    const detail = detailOf(page);
    const hold = detail.locator('dt', { hasText: MEMORY_COPY.detail.fields.legalHold });
    await expect(hold).toHaveCount(0);

    await detail.getByRole('button', { name: MEMORY_COPY.govern.hold.place }).click();

    await expect(page.getByText(MEMORY_COPY.govern.hold.outcome.placed.title)).toBeVisible();
    await expect(hold.locator('xpath=following-sibling::dd[1]')).toHaveText(
      MEMORY_COPY.detail.legalHold.held,
    );
    await detail.getByRole('button', { name: MEMORY_COPY.govern.hold.release }).click();
    await expect(page.getByText(MEMORY_COPY.govern.hold.outcome.released.title)).toBeVisible();
    await expect(hold.locator('xpath=following-sibling::dd[1]')).toHaveText(
      MEMORY_COPY.detail.legalHold.free,
    );
  });

  test('shares a memory with another owner and stops sharing', async ({ page, request }) => {
    const label = uniqueLabel('Share me');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-share'), label);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MEMORY_PATH);
    await openDetails(page, label);

    await detailOf(page).getByRole('button', { name: MEMORY_COPY.govern.share.action }).click();
    const dialog = page.getByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
    await dialog.getByLabel(MEMORY_COPY.govern.share.dialog.label).fill('another-owner');
    await dialog.getByRole('button', { name: MEMORY_COPY.govern.share.dialog.submit }).click();
    await expect(page.getByText(MEMORY_COPY.govern.share.outcome.granted.title)).toBeVisible();

    await detailOf(page).getByRole('button', { name: MEMORY_COPY.govern.share.action }).click();
    const again = page.getByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
    await again.getByLabel(MEMORY_COPY.govern.share.dialog.label).fill('another-owner');
    await again.getByRole('button', { name: MEMORY_COPY.govern.share.dialog.revoke }).click();
    await expect(page.getByText(MEMORY_COPY.govern.share.outcome.revoked.title)).toBeVisible();
  });

  test('quarantines a memory after saying it cannot be undone, and no longer lists it', async ({
    page,
    request,
  }) => {
    const label = uniqueLabel('Quarantine me');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-quarantine'), label);
    await runToEnd(
      request,
      TEXT_ECHO_AGENT_NAME,
      newThreadId('memory-quarantine-keep'),
      uniqueLabel('Keep me too'),
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(MEMORY_PATH);
    await openDetails(page, label);

    await detailOf(page)
      .getByRole('button', { name: MEMORY_COPY.govern.quarantine.action })
      .click();
    const dialog = page.getByRole('dialog', { name: MEMORY_COPY.govern.quarantine.dialog.title });
    await expect(dialog).toContainText('This cannot be undone.');
    await expect(dialog).toContainText(label.slice(0, 20));
    await dialog.getByLabel(MEMORY_COPY.govern.quarantine.dialog.reasonLabel).fill('It is wrong.');
    await dialog
      .getByRole('button', { name: MEMORY_COPY.govern.quarantine.dialog.confirm })
      .click();

    await expect(page.getByText(MEMORY_COPY.govern.quarantine.outcome.done.title)).toBeVisible();
    await expect(rowOf(page, label)).toHaveCount(0);
  });

  test('exports the agent’s memories to a file', async ({ page, request }) => {
    const label = uniqueLabel('Export me');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, newThreadId('memory-export'), label);
    await page.goto(MEMORY_PATH);
    await expect(rowOf(page, label)).toHaveCount(1);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: MEMORY_COPY.govern.export.action, exact: true }).click();

    const saved = await download;
    expect(saved.suggestedFilename()).toBe(
      MEMORY_COPY.govern.export.fileName(TEXT_ECHO_AGENT_NAME),
    );
    await expect(page.getByText(MEMORY_COPY.govern.export.outcome.title)).toBeVisible();
  });

  test('is empty for an agent that has remembered nothing', async ({ page }) => {
    // No spec chats with `internal`, so it has remembered nothing. Keep it that way: a spec that
    // does would stop this one from seeing the empty state.
    await page.goto('/agents/internal/memories');

    await expect(frame(page)).toHaveAttribute('data-state', 'empty');
    await expect(frame(page).getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.agents.emptyByPattern?.['/agents/:agent/memories']?.title ?? '',
    );
  });

  test('is not found for an agent the Bureau does not list', async ({ page }) => {
    await page.goto('/agents/nobody/memories');

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

      await searchOf(page).fill(label);

      await expect(page.getByTestId('memory-match-count')).toContainText('match');
      await expect(page.locator('mark').first()).toBeVisible();
      await checkA11y(`a memory search at ${width}px`);

      // A query that shares nothing with any memory matches none, and says so with a way back.
      const nonsense = `qzxv${crypto.randomUUID().replaceAll('-', '')}`;
      await searchOf(page).fill(nonsense);
      await expect(
        page.getByRole('heading', { name: MEMORY_COPY.noMatch.title(nonsense) }),
      ).toBeVisible();
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
      // Correct edits the words in place, with no dialog.
      await detailOf(page).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }).click();
      const field = detailOf(page).getByLabel(MEMORY_COPY.correct.edit.label);
      await expect(field).toHaveValue(original);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await checkA11y(`a memory being corrected at ${width}px`);
      await field.fill(correction);
      await detailOf(page).getByRole('button', { name: MEMORY_COPY.correct.edit.submit }).click();

      // The correction is listed and the original is not, and the page says it was replaced.
      await expect(page.getByText(MEMORY_COPY.correct.saved.title, { exact: true })).toBeVisible();
      // Below the list's breakpoint the open memory replaces the list, so the rows are only there
      // beside it.
      const layout = await page.locator('[data-cinder-layout]').getAttribute('data-cinder-layout');
      if (layout === 'split') {
        await expect(rowOf(page, correction)).toHaveCount(1);
        await expect(rowOf(page, original)).toHaveCount(0);
      }
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
      // The original was kept, and is the correction's history.
      await expect(opened.locator('blockquote', { hasText: original })).toBeVisible();
      await checkA11y(`a corrected memory's original at ${width}px`);
    });
  });
}
