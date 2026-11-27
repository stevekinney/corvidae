/**
 * The states one step from the controls COR-2755 and COR-2776 changed, which no page capture
 * reaches: the Run page's More menu open on "Copy run ID" and the toasts that follow it, the
 * Settings plugin problem card with its development-source "Open the folder" control and its toast,
 * a chat whose title carries inline Markdown (a code span, strong and emphasis) in the chat's list
 * and header, and a Settings description that carries a code span.
 *
 * Everything is the real page. The clipboard is the browser's, which a headless run neither grants
 * nor refuses on its own, so each test stands in for the two places Cinder's `copyToClipboard`
 * writes (the Async Clipboard API and `document.execCommand('copy')`) before the page loads: it
 * accepts, or refuses on both. The plugin problem is the host's answer to `GET /host/plugins`
 * changed to the one `--plugin <folder>` makes, as `settings-plugins.spec.ts` changes it for its
 * problems; the chat's title is the first message it was sent, which is how a title gets Markdown;
 * and the description is the Bureau's own for `engine.retention`, which names `retention.runs`.
 *
 * Captured for the design review (`design-review-capture.ts`); `--grep copy-and-inline-markdown-states`
 * selects every test here. Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'copy-and-inline-markdown-states.spec.ts';
const RUN_WIDTHS = [1280, 375] as const;
const PLUGIN_WIDTHS = [1280, 768, 375] as const;
const MARKDOWN_TITLE = 'Plan **the week** with `refund` and *then* ship';
const FOLDER = '~/code/guardrails-plugin';

type Clipboard = 'accepts' | 'refuses on both paths';

/** Stands in for both clipboard paths before the page loads, so a reload keeps the stand-in. */
async function standInForClipboard(page: Page, clipboard: Clipboard): Promise<void> {
  await page.addInitScript((mode) => {
    const refuses = mode === 'refuses on both paths';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          if (refuses) throw new Error('denied');
        },
      },
    });
    document.execCommand = () => !refuses;
  }, clipboard);
}

/** Runs `capture` at each width, and puts the page back at a desktop. */
async function atEachWidth(
  page: Page,
  widths: readonly number[],
  capture: (page: Page) => Promise<void>,
): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await capture(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

for (const width of RUN_WIDTHS) {
  // The route leads the title, so a design review's route filter (`--grep '/runs/:run'`) runs these.
  test.describe(`copy-and-inline-markdown-states: /runs/:run at ${String(width)} pixels`, () => {
    /** Opens the failed sample run at `width`, and waits until the header says its status. */
    async function openRun(page: Page): Promise<void> {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${E2E_SHOWCASE_URL}/runs/${encodeURIComponent(world.runs.failed)}`);
      await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();
    }

    const copyItem = (page: Page) => page.getByRole('menuitem', { name: 'Copy run ID' });

    /** Opens the More menu when a resize closed it. */
    async function ensureMenuOpen(page: Page): Promise<void> {
      if (!(await copyItem(page).isVisible())) {
        await page.getByRole('button', { name: 'More actions' }).click();
      }
      await expect(copyItem(page)).toBeVisible();
    }

    /** Copies the ID again when the toast of the last copy has gone, so every screenshot holds one. */
    async function ensureToast(page: Page, words: RegExp): Promise<void> {
      if (!(await page.getByText(words).first().isVisible())) {
        await ensureMenuOpen(page);
        await copyItem(page).click();
      }
      await expect(page.getByText(words).first()).toBeVisible();
    }

    test('the More menu is open on Copy run ID, and copying says the ID is copied', async ({
      page,
    }) => {
      await standInForClipboard(page, 'accepts');
      await openRun(page);

      await page.getByRole('button', { name: 'More actions' }).click();
      await expect(copyItem(page)).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'more menu open on copy run id',
        source: SOURCE,
        ready: ensureMenuOpen,
      });

      await copyItem(page).click();
      await expect(page.getByText('Run ID copied').first()).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'run id copied toast',
        source: SOURCE,
        ready: (target) => ensureToast(target, /Run ID copied/),
      });
    });

    test('copying says the ID was not copied when the clipboard and its fallback both refuse', async ({
      page,
    }) => {
      await standInForClipboard(page, 'refuses on both paths');
      await openRun(page);

      await page.getByRole('button', { name: 'More actions' }).click();
      await copyItem(page).click();
      await expect(page.getByText(/The run ID was not copied\.$/).first()).toBeVisible();
      await expect(page.getByText('Run ID copied')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'run id not copied fault',
        source: SOURCE,
        ready: (target) => ensureToast(target, /The run ID was not copied\.$/),
      });
    });
  });
}

test.describe('copy-and-inline-markdown-states: /settings/plugins', () => {
  /** The host's plugins, every one running and clean but Guardrails, which was loaded from a folder. */
  async function answerWithDevelopmentFolder(page: Page): Promise<void> {
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const snapshot = await response.json();
      for (const plugin of snapshot.plugins as {
        descriptor: { name: string };
        status: string;
        problems: unknown[];
      }[]) {
        plugin.status = 'running';
        plugin.problems =
          plugin.descriptor.name === 'guardrails'
            ? [{ code: 'development-source', path: FOLDER }]
            : [];
      }
      return route.fulfill({ response, json: snapshot });
    });
  }

  const card = (page: Page) => page.locator('[data-plugin-problem="development-source"]');

  /** Brings the card into the viewport, which the page's own scroll may have left. */
  async function showCard(page: Page): Promise<void> {
    await expect(card(page)).toBeVisible();
    await card(page).scrollIntoViewIfNeeded();
  }

  test('a plugin loaded from a folder draws its development card with Open the folder, and pressing it says the path is copied', async ({
    page,
  }) => {
    await standInForClipboard(page, 'accepts');
    await answerWithDevelopmentFolder(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}/settings/plugins?plugin=guardrails`);

    await expect(card(page)).toContainText('Loaded from your working copy');
    await expect(card(page)).toContainText(FOLDER);
    await expect(card(page).getByRole('button', { name: 'Open the folder' })).toBeVisible();
    await atEachWidth(page, PLUGIN_WIDTHS, async (target) => {
      await showCard(target);
      await captureForDesignReview(target, {
        route: '/settings/plugins',
        state: 'development source problem card with open the folder',
        source: SOURCE,
        ready: showCard,
      });
    });

    await card(page).getByRole('button', { name: 'Open the folder' }).click();
    await expect(page.getByText('The folder’s path is copied.').first()).toBeVisible();
    // Pressing the button again while a toast is up asks for another, so a screenshot always holds one.
    const ensureToast = async (target: Page) => {
      const copied = target.getByText('The folder’s path is copied.').first();
      if (!(await copied.isVisible())) {
        await card(target).getByRole('button', { name: 'Open the folder' }).click();
      }
      await expect(copied).toBeVisible();
    };
    await atEachWidth(page, [1280, 375], async (target) => {
      await ensureToast(target);
      await captureForDesignReview(target, {
        route: '/settings/plugins',
        state: 'development source path copied toast',
        source: SOURCE,
        ready: ensureToast,
      });
    });
  });
});

test.describe('copy-and-inline-markdown-states: /settings', () => {
  test('a setting whose description names another setting in a code span says it as words, with no backticks', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}/settings`);
    await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: 'Advanced', exact: true }).click();

    const row = page.locator('[data-setting="engine.retention"]');
    await expect(row).toBeVisible();
    // The Bureau's words are "in place of the one window `retention.runs` sets"; the span reads as
    // its text, and no backtick reaches the page.
    await expect(row).toContainText('in place of the one window retention.runs sets');
    expect(await row.textContent()).not.toContain('`');
    const show = async (target: Page) => {
      await target.locator('[data-setting="engine.retention"]').scrollIntoViewIfNeeded();
    };
    await atEachWidth(page, [1280, 375], async (target) => {
      await show(target);
      await captureForDesignReview(target, {
        route: '/settings',
        state: 'description with a code span',
        source: SOURCE,
        ready: show,
      });
    });
  });
});

test.describe('copy-and-inline-markdown-states: /chats/:chat', () => {
  const threads: string[] = [];

  test.afterEach(async () => {
    await deleteChats(threads.splice(0));
  });

  /** A chat whose first message, and so whose title, holds inline Markdown, opened on its page. */
  async function openMarkdownChat(
    page: Page,
    request: Parameters<typeof runToEnd>[0],
    width: number,
  ): Promise<void> {
    const thread = newThreadId('inline-markdown-title');
    threads.push(thread);
    await runToEnd(request, 'demo:model-switcher', thread, MARKDOWN_TITLE);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/chats/${thread}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  }

  /** The header's title, set as elements: strong, emphasis and a code span, the marks gone. */
  async function expectHeaderTitle(page: Page): Promise<void> {
    const heading = page.getByTestId('chat-header').getByRole('heading', { level: 1 });
    await expect(heading.locator('strong')).toHaveText('the week');
    await expect(heading.locator('code')).toHaveText('refund');
    await expect(heading.locator('em')).toHaveText('then');
    await expect(heading).toHaveText('Plan the week with refund and then ship');
  }

  test('the chat header sets the title’s Markdown as strong, emphasis and code, at 1280 pixels, beside the chat list', async ({
    page,
    request,
  }) => {
    await openMarkdownChat(page, request, 1280);

    await expectHeaderTitle(page);
    // The list is the chat list's own row for the chat, which names the chat by the same title.
    await expect(page.locator('[data-chat]').filter({ hasText: 'the week' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'title with inline markdown in header and list',
      source: SOURCE,
    });
  });

  test('the chat header sets the title’s Markdown as strong, emphasis and code, at 375 pixels', async ({
    page,
    request,
  }) => {
    await openMarkdownChat(page, request, 375);

    await expectHeaderTitle(page);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'title with inline markdown in header',
      source: SOURCE,
    });
  });
});
