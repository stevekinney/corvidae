import { expect, test } from '@playwright/test';
import type { Page } from './review-form-and-exports-test-helpers';
import {
  EXPECTED_COMMENTS_MARKDOWN,
  EXPECTED_DIFF,
  EXPECTED_SUMMARY,
  copyAnnouncer,
  copyFromExportMenu,
  defined,
  exportMenu,
  exportTrigger,
  gotoReady,
  valueOf,
} from './review-form-and-exports-test-helpers';

type ExportedReviewState = {
  schemaVersion: number;
  original: string;
  threads: Array<{ anchor: Record<string, unknown>; comments: unknown[] }>;
  frontMatter: unknown;
  frontMatterRaw: unknown;
};

function assertExportedReviewState(value: unknown): asserts value is ExportedReviewState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected exported review state to be an object.');
  }
  const schemaVersion = Reflect.get(value, 'schemaVersion');
  const original = Reflect.get(value, 'original');
  const threads = Reflect.get(value, 'threads');
  if (typeof schemaVersion !== 'number') throw new Error('Expected schemaVersion to be a number.');
  if (typeof original !== 'string') throw new Error('Expected original to be a string.');
  if (!Array.isArray(threads)) throw new Error('Expected threads to be an array.');
  for (const thread of threads) {
    if (typeof thread !== 'object' || thread === null || Array.isArray(thread)) {
      throw new Error('Expected exported thread to be an object.');
    }
    const anchor = Reflect.get(thread, 'anchor');
    const comments = Reflect.get(thread, 'comments');
    if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) {
      throw new Error('Expected exported thread anchor to be an object.');
    }
    if (!Array.isArray(comments)) throw new Error('Expected exported comments to be an array.');
  }
}

test.describe('the export menu', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    // An explicit context: `test.use({ permissions })` configures the `page`
    // FIXTURE, and a describe-shared page built from `browser.newPage()`
    // would not inherit it — clipboard reads would fail on permission.
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
    await gotoReady(page);
  });
  test.afterAll(async () => {
    await page.context().close();
  });
  test('the trigger opens a five-item menu in a fixed order', async () => {
    const trigger = exportTrigger(page);
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await expect(trigger).toHaveAttribute('aria-controls', 'exports-editor-export-menu');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    // `aria-expanded` is driven off the popover's `toggle` event rather than
    // the click, so it lands a tick late — an auto-retrying matcher, not a
    // read-after-click.
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = exportMenu(page);
    await expect(menu).toHaveAttribute('role', 'menu');
    // DOM order is Content, Summary, Git Diff, Comments, JSON — note that
    // JSON is LAST in the DOM even though the format list in the source
    // declares it third.
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Content',
      'Summary (for LLM)',
      'Git Diff',
      'Comments',
      'JSON',
    ]);
    // Close it again: the trigger is a toggle, and every test below opens
    // the menu from a closed state.
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
  });
  test('Content copies the live value verbatim', async () => {
    const copied = await copyFromExportMenu(page, 'Content', 'Copied Content');
    expect(copied).toBe(await valueOf(page.getByTestId('live-value')));
  });
  test('Summary (for LLM) copies generateMarkdownSummary().markdown', async () => {
    const copied = await copyFromExportMenu(
      page,
      /^Summary \(for LLM\)/,
      'Copied Summary (for LLM)',
    );
    expect(copied).toBe(await valueOf(page.getByTestId('module-summary')));
    // RE-2 asks for the UI path and the imperative path to be asserted to
    // agree. For the summary that is three surfaces meeting on one literal:
    // the clipboard here, the `review-summary` hidden input, and
    // `getFormData().summary` — all reading the same `$derived`.
    expect(copied).toBe(EXPECTED_SUMMARY);
    expect(copied).toBe(
      await page.locator('#exports-form input[name="review-summary"]').inputValue(),
    );
    expect(copied.startsWith('## Changes Made')).toBe(true);
    expect(copied).toContain('## Feedback');
    expect(copied).toContain('### On "Release Plan"');
  });
  test('Git Diff copies generateUnifiedDiff().diff', async () => {
    const copied = await copyFromExportMenu(page, /^Git Diff/, 'Copied Git Diff');
    expect(copied).toBe(EXPECTED_DIFF);
    expect(copied).toBe(await valueOf(page.getByTestId('module-diff')));
  });
  test('Comments copies generateCommentsExport().markdown', async () => {
    const copied = await copyFromExportMenu(page, /^Comments/, 'Copied Comments');
    expect(copied).toBe(EXPECTED_COMMENTS_MARKDOWN);
    expect(copied).toBe(await valueOf(page.getByTestId('module-comments-markdown')));
    // Worth stating because the two sibling exports disagree: this one opens
    // `# Review Comments`, while the empty-input path opens `# Comments`.
    expect(copied.startsWith('# Review Comments')).toBe(true);
    expect(copied.endsWith('**Total comments:** 1')).toBe(true);
  });
  test('JSON copies the whole ReviewState — not the comments-only JSON export', async () => {
    const copied = await copyFromExportMenu(page, /^JSON/, 'Copied JSON');
    const state: unknown = JSON.parse(copied);
    assertExportedReviewState(state);
    expect(Object.keys(state)).toEqual([
      'schemaVersion',
      'content',
      'original',
      'threads',
      'frontMatter',
      'frontMatterRaw',
      'updatedAt',
    ]);
    expect(state.schemaVersion).toBe(4);
    // `reviewSession` is set to `undefined` by getState() and therefore never
    // survives serialization — see the imperative test above.
    expect(copied).not.toContain('reviewSession');
    // No front matter in this fixture, and the parser reports that as null
    // rather than as an empty object. (`review-front-matter` owns the
    // populated case.)
    expect(state.frontMatter).toBeNull();
    expect(state.frontMatterRaw).toBeNull();
    // The PERSISTED anchor shape: `from`/`to` are runtime ProseMirror
    // positions and are stripped, and undefined-valued optional fields
    // (`type`, `blockId`, `originalPosition`) vanish with them. This is a
    // different serialization of the same thread from the one the
    // `review-comments` hidden input carries.
    const stateThread = defined(state.threads[0], 'submitted state thread');
    expect(Object.keys(stateThread.anchor)).toEqual([
      'quote',
      'prefix',
      'suffix',
      'status',
      'originalQuote',
      'lastKnownOffset',
    ]);
    // Soft-deleted comments DO survive here — the state is an audit trail,
    // unlike the markdown exports, which filter them.
    expect(stateThread.comments).toHaveLength(2);
    // And the proof that this is not `generateCommentsJSON`: that export
    // produces `{ threads: [{ type, selection, … }] }` with no document
    // content at all.
    const commentsJson = await valueOf(page.getByTestId('module-comments-json'));
    expect(commentsJson).not.toBe(copied);
    expect(JSON.parse(commentsJson)).toEqual({
      threads: [
        {
          id: 'thread-release-plan-title',
          type: 'text',
          comments: [
            {
              id: 'comment-visible',
              body: 'Title reads well — keep it.',
              authorId: 'maya',
              createdAt: '2026-08-11T12:00:00.000Z',
            },
          ],
          // `from`/`to` here are TEXT OFFSETS derived from
          // `lastKnownOffset` and the quote length — a third coordinate
          // space, sharing field names with the ProseMirror positions in
          // the hidden input.
          selection: { text: 'Release Plan', from: 0, to: 12 },
        },
      ],
    });
  });
  test('copy confirmation announces, swaps the icon, and reverts after ~2s', async () => {
    await exportTrigger(page).click();
    await expect(exportMenu(page)).toBeVisible();
    await exportMenu(page)
      .getByRole('menuitem', { name: /^Git Diff/ })
      .click();
    // Selecting an item closes the menu (`closeOnSelect` defaults true), but
    // the popover stays in the DOM, so the confirmation state is still
    // readable — through the DOM, not through role locators, which skip
    // hidden subtrees.
    const menu = exportMenu(page);
    await expect(copyAnnouncer(page)).toHaveText('Copied Git Diff');
    await expect(menu.locator('.copied-label')).toHaveText('Copied!');
    await expect(menu.locator('svg.export-icon-success')).toHaveCount(1);
    // GOTCHA, pinned deliberately: `Copied!` is a sibling span INSIDE the
    // menu item, so for those two seconds the item's accessible name is
    // "Git Diff Copied!" and an exact-name locator stops matching it. Any
    // follow-up interaction in that window has to use a prefix match.
    // (Reopening costs ~25ms against the 2000ms window.)
    await exportTrigger(page).click();
    await expect(
      menu.getByRole('menuitem', { name: 'Git Diff Copied!', exact: true }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Git Diff', exact: true })).toHaveCount(0);
    // After the window the label, the icon, the announcement and the
    // original accessible name all come back. Auto-retry rather than a
    // fixed sleep — the reset is a 2000ms `setTimeout` from the copy, not
    // from here.
    await expect(menu.getByRole('menuitem', { name: 'Git Diff', exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expect(menu.locator('.copied-label')).toHaveCount(0);
    await expect(menu.locator('svg.export-icon-success')).toHaveCount(0);
    await expect(copyAnnouncer(page)).toHaveText('');
  });
});
