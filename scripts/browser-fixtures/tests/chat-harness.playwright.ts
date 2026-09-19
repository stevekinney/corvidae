import { FIXTURE_ORIGIN } from '../scripts/fixture-port.ts';
/**
 * Comprehensive browser coverage for the Chat interactive harness example
 * (`playground/src/examples/chat/interactive-harness.example.svelte`).
 *
 * The harness mounts <Chat> alongside a control panel that drives every lever:
 * reply as the other side (instant / typing / streaming, imperative +
 * content-mutation), inject tool calls (all outcomes), toggle features, and an
 * event log that records every callback as
 * `<div data-testid="event-log-entry" data-event=… data-payload=…>`.
 *
 * Everything is scoped to `#example-mount-interactive-harness` so the other
 * chat examples on `/page/chat` never interfere. `?snapshot=1` zeroes CSS
 * animation durations (JS timers are untouched), which makes the deterministic
 * streaming cadence reliably observable.
 */
import { loadManifest, runAxe, THEME_STORAGE_KEY } from '@corvidae/testing';
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type ElementHandle,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { PNG } from 'pngjs';
import { environmentConfiguration } from '../environment-configuration.ts';
import { fixtureRoute } from './overlay-fixture.ts';

const HARNESS = '[data-testid="chat-private-harness"]';
const chatEntry = loadManifest().find((entry) => entry.slug === 'chat');
if (chatEntry === undefined) throw new Error('Chat manifest entry is missing.');
const privateHarnessFixture = chatEntry.fixtures?.find(
  (fixture) => fixture.name === 'private-harness',
);
const privateHistoryPrependStressFixture = chatEntry.fixtures?.find(
  (fixture) => fixture.name === 'private-history-prepend-stress',
);
if (privateHarnessFixture === undefined || privateHistoryPrependStressFixture === undefined) {
  throw new Error('Chat private fixtures are missing from the application manifest.');
}
/** Opens /page/chat and returns a Locator scoped to the harness mount. */
async function openHarness(
  browser: Browser,
  options?: {
    reducedMotion?: 'reduce' | 'no-preference';
    colorScheme?: 'dark' | 'light';
    viewport?: { width: number; height: number };
    hasTouch?: boolean;
    locale?: string;
    timezoneId?: string;
  },
): Promise<{ page: Page; harness: Locator; dispose: () => Promise<void> }> {
  const colorScheme = options?.colorScheme ?? 'dark';
  const contextOptions: BrowserContextOptions = {
    baseURL: environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
    colorScheme,
    reducedMotion: options?.reducedMotion ?? 'reduce',
    viewport: options?.viewport ?? { width: 1280, height: 900 },
    hasTouch: options?.hasTouch ?? false,
  };
  if (options?.locale !== undefined) contextOptions.locale = options.locale;
  if (options?.timezoneId !== undefined) contextOptions.timezoneId = options.timezoneId;
  const context = await browser.newContext(contextOptions);
  // A failure below (bad route, load regression, the harness never becoming
  // visible) would otherwise leak this context: nothing else here closes a
  // context whose owning `openHarness` call never returned. Close it on any
  // failure and rethrow.
  try {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [THEME_STORAGE_KEY, colorScheme] as const,
    );
    const page = await context.newPage();
    const diagnostics: string[] = [];
    page.on('pageerror', (error) => diagnostics.push(error.stack ?? error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    await page.goto(fixtureRoute('chat', { fixtureName: 'private-harness' }), {
      waitUntil: 'load',
    });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
    const harness = page.locator(HARNESS);
    await harness.waitFor({ state: 'visible', timeout: 20_000 });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          theme: document.documentElement.dataset['theme'],
          cinderTheme: document.documentElement.dataset['cinderTheme'],
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
        })),
      )
      .toEqual({ theme: colorScheme, cinderTheme: colorScheme, colorScheme });
    return {
      page,
      harness,
      async dispose() {
        try {
          expect(diagnostics, 'Chat harness must not emit browser errors or warnings').toEqual([]);
        } finally {
          await context.close();
        }
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/**
 * Asserts the event log eventually contains an entry for the given callback.
 * Uses an auto-retrying `toBeAttached` so it tolerates the async microtask
 * between a click and Svelte flushing the log mutation (a bare `.count()`
 * after `.click()` can read 0 before the flush and fail spuriously).
 */
async function expectLoggedEvent(harness: Locator, event: string): Promise<void> {
  await expect(
    harness.locator(`[data-testid="event-log-entry"][data-event="${event}"]`).first(),
  ).toBeAttached();
}

/** Trimmed length of a locator's text content (0 when empty/absent). */
async function trimmedLength(locator: Locator): Promise<number> {
  const text = await locator.textContent();
  return text?.trim().length ?? 0;
}

async function messageBodyText(locator: Locator): Promise<string> {
  const text = await locator.locator('.chat-message-body').textContent();
  return text?.trim() ?? '';
}

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function svgMarkup(width: number, height: number, fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`;
}

function svgDataUrl(width: number, height: number, fill: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svgMarkup(width, height, fill))}`;
}

type HarnessImageContent = {
  type: 'image';
  url: string;
  mimeType: string;
  text: string;
  width?: number;
  height?: number;
};

async function appendHarnessImages(page: Page, images: HarnessImageContent[]): Promise<void> {
  await page.evaluate((nextImages) => {
    const harnessWindow = window as Window & {
      corvidaeChatHarnessAppendImages?: (images: HarnessImageContent[]) => void;
    };
    if (harnessWindow.corvidaeChatHarnessAppendImages === undefined) {
      throw new Error('Chat harness image append hook is unavailable.');
    }
    harnessWindow.corvidaeChatHarnessAppendImages(nextImages);
  }, images);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => Math.ceil(document.documentElement.scrollWidth - window.innerWidth)),
    )
    .toBeLessThanOrEqual(1);
}

async function expectNoInternalHorizontalOverflow(locator: Locator, label: string): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((element) =>
          Math.ceil(element.scrollWidth - (element as HTMLElement).clientWidth),
        ),
      { message: `${label} must not hide horizontal overflow` },
    )
    .toBeLessThanOrEqual(1);
}

async function useHarnessAdapter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harnessWindow = window as Window & {
      corvidaeChatHarnessUseAdapter?: () => void;
    };
    harnessWindow.corvidaeChatHarnessUseAdapter?.();
  });
}

async function holdNextFirstStreamToken(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harnessWindow = window as Window & {
      corvidaeChatHarnessHoldNextFirstStreamToken?: () => void;
    };
    if (harnessWindow.corvidaeChatHarnessHoldNextFirstStreamToken === undefined) {
      throw new Error('Chat harness first-token hold hook is unavailable.');
    }
    harnessWindow.corvidaeChatHarnessHoldNextFirstStreamToken();
  });
}

async function captureHarnessScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function openChatFixture(
  browser: Browser,
  options: {
    colorScheme: 'dark' | 'light';
    viewport: { width: number; height: number };
  },
): Promise<{ page: Page; dispose: () => Promise<void> }> {
  const context = await browser.newContext({
    baseURL: environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
    colorScheme: options.colorScheme,
    reducedMotion: 'reduce',
    viewport: options.viewport,
  });
  const diagnostics: string[] = [];
  try {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [THEME_STORAGE_KEY, options.colorScheme] as const,
    );
    const page = await context.newPage();
    page.on('pageerror', (error) => diagnostics.push(error.stack ?? error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.push(`${message.type()}: ${message.text()}`);
      }
    });
    await page.goto(fixtureRoute('chat'), { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          theme: document.documentElement.dataset['theme'],
          cinderTheme: document.documentElement.dataset['cinderTheme'],
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
        })),
      )
      .toEqual({
        theme: options.colorScheme,
        cinderTheme: options.colorScheme,
        colorScheme: options.colorScheme,
      });
    return {
      page,
      async dispose() {
        try {
          expect(diagnostics, 'Chat fixture must not emit browser errors or warnings').toEqual([]);
        } finally {
          await context.close();
        }
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function borderBottomWidth(locator: Locator): Promise<number> {
  return locator.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).borderBottomWidth),
  );
}

async function pushHarnessTypingSnapshot(
  page: Page,
  participants: Array<{ id: string; name: string }>,
): Promise<void> {
  await page.evaluate((nextParticipants) => {
    const harnessWindow = window as Window & {
      corvidaeChatHarnessPushTypingSnapshot?: (
        participants: Array<{ id: string; name: string }>,
      ) => void;
    };
    if (harnessWindow.corvidaeChatHarnessPushTypingSnapshot === undefined) {
      throw new Error('Chat harness typing push hook is unavailable.');
    }
    harnessWindow.corvidaeChatHarnessPushTypingSnapshot(nextParticipants);
  }, participants);
}

async function setHarnessDirectTypingParticipants(
  page: Page,
  participants: Array<{ id: string; name: string }> | undefined,
): Promise<void> {
  await page.evaluate((nextParticipants) => {
    const harnessWindow = window as Window & {
      corvidaeChatHarnessSetDirectTypingParticipants?: (
        participants: Array<{ id: string; name: string }> | undefined,
      ) => void;
    };
    if (harnessWindow.corvidaeChatHarnessSetDirectTypingParticipants === undefined) {
      throw new Error('Chat harness direct typing hook is unavailable.');
    }
    harnessWindow.corvidaeChatHarnessSetDirectTypingParticipants(nextParticipants);
  }, participants);
}

async function computedOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity));
}

async function renderedBox(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} must have a rendered box`).not.toBeNull();
  if (box === null) throw new Error(`${label} did not render.`);
  return box;
}

function expectContainedWithin(
  child: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>,
  parent: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>,
  label: string,
): void {
  expect(child.x, `${label} left edge must stay inside its parent`).toBeGreaterThanOrEqual(
    parent.x - 1,
  );
  expect(child.y, `${label} top edge must stay inside its parent`).toBeGreaterThanOrEqual(
    parent.y - 1,
  );
  expect(
    child.x + child.width,
    `${label} right edge must stay inside its parent`,
  ).toBeLessThanOrEqual(parent.x + parent.width + 1);
  expect(
    child.y + child.height,
    `${label} bottom edge must stay inside its parent`,
  ).toBeLessThanOrEqual(parent.y + parent.height + 1);
}

async function expectNarrowConversationLayoutStacks(layout: Locator): Promise<void> {
  const metrics = await layout.evaluate((element) => {
    const sidebar = element.querySelector<HTMLElement>('.chat-layout-fixture__sidebar');
    const main = element.querySelector<HTMLElement>('.chat-layout-fixture__main');
    if (!sidebar || !main) throw new Error('Missing conversation layout regions');

    const style = getComputedStyle(element);
    const layoutBox = element.getBoundingClientRect();
    const sidebarBox = sidebar.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    const borderInlineStart = Number.parseFloat(style.borderInlineStartWidth);
    const borderInlineEnd = Number.parseFloat(style.borderInlineEndWidth);

    return {
      contentX: layoutBox.x + borderInlineStart,
      contentWidth: layoutBox.width - borderInlineStart - borderInlineEnd,
      sidebar: {
        bottom: sidebarBox.bottom,
      },
      main: {
        x: mainBox.x,
        y: mainBox.y,
        width: mainBox.width,
      },
    };
  });

  expect(
    metrics.main.y,
    'narrow conversation main pane should stack below the sidebar',
  ).toBeGreaterThanOrEqual(metrics.sidebar.bottom - 1);
  expect(metrics.main.x, 'narrow conversation main pane should start at content edge').toBeCloseTo(
    metrics.contentX,
    1,
  );
  expect(
    metrics.main.width,
    'narrow conversation main pane should fill available width',
  ).toBeCloseTo(metrics.contentWidth, 1);
}

test('selected conversations and transcript boundaries use one flat divider system', async ({
  browser,
}, testInfo) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [320, 512, 848]) {
      const { page, dispose } = await openChatFixture(browser, {
        colorScheme,
        viewport: { width, height: 760 },
      });
      try {
        const layout = page.getByTestId('chat-conversation-layout');
        if (width === 320) await expectNarrowConversationLayoutStacks(layout);
        const selectedConversation = layout.locator('[data-cinder-conversation-selected]').first();
        const inactiveConversation = layout
          .locator('[data-cinder-conversation-item]:not([data-cinder-conversation-selected])')
          .first();
        await expect(selectedConversation).toHaveAttribute('aria-current', 'page');
        await expect(selectedConversation).toBeVisible();
        await expect(inactiveConversation).toBeVisible();

        const selectedBoxBefore = await renderedBox(selectedConversation, 'selected conversation');
        const selectedStyle = await selectedConversation.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            borderBlockStartWidth: style.borderBlockStartWidth,
            borderColor: style.borderColor,
            borderRadius: style.borderRadius,
          };
        });
        expect(selectedStyle.borderBlockStartWidth).toBe('1px');
        expect(selectedStyle.borderColor).toBe('rgba(0, 0, 0, 0)');
        expect(selectedStyle.borderRadius).toBe('0px');

        await inactiveConversation.click();
        const selectedBoxAfter = await renderedBox(
          layout.locator('[data-cinder-conversation-selected]').first(),
          'next selected conversation',
        );
        expect(selectedBoxAfter.width).toBeCloseTo(selectedBoxBefore.width, 1);
        expect(selectedBoxAfter.height).toBeCloseTo(selectedBoxBefore.height, 1);

        const chatHeaderWrapper = layout.locator('.chat-header').first();
        const conversationHeader = layout.locator('.cinder-chat-conversation-header').first();
        await expect(chatHeaderWrapper).toBeVisible();
        await expect(conversationHeader).toBeVisible();
        const dividerWidth =
          (await borderBottomWidth(chatHeaderWrapper)) +
          (await borderBottomWidth(conversationHeader));
        expect(dividerWidth).toBe(1);

        await captureHarnessScreenshot(
          page,
          testInfo,
          `chat-layout-boundary-${colorScheme}-${width}`,
        );
      } finally {
        await dispose();
      }
    }
  }
});

test('artifact actions remain visible and panel headers stay compact', async ({
  browser,
}, testInfo) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [320, 512, 848]) {
      const { page, dispose } = await openChatFixture(browser, {
        colorScheme,
        viewport: { width, height: 820 },
      });
      try {
        const defaultLayout = page.getByTestId('chat-default-artifact-layout');
        const firstArtifact = defaultLayout.getByRole('button', {
          name: 'Open artifact: Exports report',
          exact: true,
        });
        await expect(firstArtifact).toBeVisible();
        await expect(firstArtifact).toHaveAttribute('title', 'Exports report');
        await page.mouse.move(1, 1);
        await expect(firstArtifact).toBeVisible();

        await expect(
          defaultLayout.getByRole('button', {
            name: 'Open artifact: Duplicate report',
            exact: true,
          }),
        ).toHaveCount(2);
        await expect(
          defaultLayout.getByRole('button', { name: 'Open artifact: Artifact', exact: true }),
        ).toBeVisible();
        const longTitleButton = defaultLayout.getByRole('button', {
          name: 'Open artifact: Exports report with a long generated title that should truncate visually while retaining the full accessible name',
        });
        await expect(longTitleButton).toBeVisible();
        await expect(longTitleButton).toHaveAttribute(
          'title',
          'Exports report with a long generated title that should truncate visually while retaining the full accessible name',
        );
        await expect(defaultLayout.getByTestId('custom-artifact-action')).toHaveCount(0);

        await firstArtifact.focus();
        await page.keyboard.press('Enter');
        const panel = defaultLayout.locator('.artifact-panel').first();
        await expect(panel).toBeVisible();
        await expect(panel.locator('.artifact-panel-title')).toHaveText('Exports report');
        const layoutRoot = defaultLayout.locator('.chat-artifact-layout').first();
        const layoutGrid = defaultLayout.locator('.chat-artifact-grid').first();
        const layoutRootBox = await renderedBox(layoutRoot, 'artifact layout root');
        const layoutGridBox = await renderedBox(layoutGrid, 'artifact layout grid');
        const mainBox = await renderedBox(
          defaultLayout.locator('.chat-artifact-main').first(),
          'artifact layout main',
        );
        const panelBox = await renderedBox(panel, 'artifact panel');
        const ancestorContainer = await layoutRoot.evaluate((element) => {
          let parent = element.parentElement;
          while (parent) {
            const containerType = getComputedStyle(parent).containerType;
            if (containerType !== 'normal') return containerType;
            parent = parent.parentElement;
          }
          return null;
        });
        expect(
          ancestorContainer,
          'responsive layout must not depend on an ancestor container',
        ).toBe(null);
        expect(
          layoutRootBox.width,
          'layout root should reflect the actual embedded fixture width',
        ).toBeGreaterThan(0);
        expect(layoutRootBox.width).toBeLessThanOrEqual(width);
        expectContainedWithin(layoutGridBox, layoutRootBox, 'artifact layout grid');
        if (layoutRootBox.width <= 768) {
          expect(
            panelBox.y,
            'narrow artifact panel should stack below the chat area',
          ).toBeGreaterThanOrEqual(mainBox.y + mainBox.height - 1);
          expect(panelBox.width).toBeCloseTo(layoutRootBox.width, 1);
        } else {
          expect(
            panelBox.x,
            'wide artifact panel should sit beside the chat area',
          ).toBeGreaterThanOrEqual(mainBox.x + mainBox.width - 1);
          expect(panelBox.height).toBeCloseTo(mainBox.height, 1);
        }
        const headerBox = await renderedBox(
          panel.locator('.artifact-panel-header'),
          'artifact header',
        );
        expect(headerBox.height).toBe(48);
        const titleBox = await renderedBox(
          panel.locator('.artifact-panel-title'),
          'artifact header title',
        );
        expect(
          titleBox.x + titleBox.width / 2,
          'artifact title center must align with the full header center',
        ).toBeCloseTo(headerBox.x + headerBox.width / 2, 1);
        const close = panel.getByRole('button', { name: 'Close artifact panel' });
        const closeBox = await renderedBox(close, 'artifact close button');
        expect(closeBox.width).toBe(44);
        expect(closeBox.height).toBe(44);
        expectContainedWithin(closeBox, headerBox, 'artifact close button');

        await close.click();
        await expect(panel).toBeHidden();
        await expect(firstArtifact).toBeFocused();

        const fallbackTitle = defaultLayout.getByRole('button', {
          name: 'Open artifact: Artifact',
          exact: true,
        });
        await fallbackTitle.focus();
        await page.keyboard.press(' ');
        await expect(defaultLayout.locator('.artifact-panel-title').first()).toHaveText('Artifact');
        await defaultLayout.getByRole('button', { name: 'Close artifact panel' }).click();

        const secondDuplicate = defaultLayout
          .getByRole('button', { name: 'Open artifact: Duplicate report', exact: true })
          .nth(1);
        await secondDuplicate.click();
        await expect(defaultLayout.locator('.artifact-panel-content').first()).toContainText(
          'const duplicate = 2;',
        );

        const groupedOne = defaultLayout.getByRole('button', {
          name: 'Open artifact: Grouped artifact one',
        });
        const groupedTwo = defaultLayout.getByRole('button', {
          name: 'Open artifact: Grouped artifact two',
        });
        await expect(groupedOne).toBeVisible();
        await expect(groupedTwo).toBeVisible();

        const externalLayout = page.getByTestId('chat-external-artifact-layout');
        await expect(externalLayout.getByTestId('custom-artifact-action').first()).toBeVisible();
        await externalLayout
          .getByRole('button', { name: 'Open artifact: Exports report', exact: true })
          .click();
        await expect(externalLayout.locator('.artifact-panel')).toHaveCount(1);
        await expect(externalLayout.locator('.artifact-panel-title')).toHaveText('Exports report');

        await captureHarnessScreenshot(
          page,
          testInfo,
          `chat-artifact-layout-${colorScheme}-${width}`,
        );
      } finally {
        await dispose();
      }
    }
  }
});

async function expectDocumentedChatSizing(
  shell: Locator,
  publicClassNames: readonly string[],
  label: string,
): Promise<void> {
  const layoutRoot = shell.locator('.chat-artifact-layout').first();
  const chatContainer = shell.locator('.chat-container').first();
  const timeline = shell.locator('.chat-timeline').first();

  for (const publicClassName of publicClassNames) {
    await expect(layoutRoot).toHaveClass(new RegExp(`\\b${publicClassName}\\b`));
    await expect(chatContainer).not.toHaveClass(new RegExp(`\\b${publicClassName}\\b`));
  }

  const [metrics, chatContainerBox, timelineBox] = await Promise.all([
    shell.evaluate((element) => {
      const header = element.querySelector<HTMLElement>('.chat-public-sizing-header');
      const layoutRoot = element.querySelector<HTMLElement>('.chat-artifact-layout');
      if (!layoutRoot) throw new Error('Missing artifact layout root');
      const shellBox = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const borderBlock =
        Number.parseFloat(style.borderBlockStartWidth) +
        Number.parseFloat(style.borderBlockEndWidth);
      const borderInline =
        Number.parseFloat(style.borderInlineStartWidth) +
        Number.parseFloat(style.borderInlineEndWidth);
      const paddingBlock =
        Number.parseFloat(style.paddingBlockStart) + Number.parseFloat(style.paddingBlockEnd);
      const paddingInline =
        Number.parseFloat(style.paddingInlineStart) + Number.parseFloat(style.paddingInlineEnd);
      const headerBox = header?.getBoundingClientRect() ?? {
        bottom: shellBox.top,
        height: 0,
        y: shellBox.top,
      };
      const layoutBox = layoutRoot.getBoundingClientRect();
      return {
        availableHeight: shellBox.height - borderBlock - paddingBlock - headerBox.height,
        availableWidth: shellBox.width - borderInline - paddingInline,
        contentTop: headerBox.bottom,
        layout: {
          x: layoutBox.x,
          y: layoutBox.y,
          width: layoutBox.width,
          height: layoutBox.height,
          bottom: layoutBox.bottom,
        },
        shell: {
          x: shellBox.x,
          y: shellBox.y,
          width: shellBox.width,
          height: shellBox.height,
          bottom: shellBox.bottom,
        },
      };
    }),
    renderedBox(chatContainer, `${label} chat container`),
    renderedBox(timeline, `${label} timeline`),
  ]);
  const layoutRootBox = metrics.layout;

  expect(layoutRootBox.y).toBeCloseTo(metrics.contentTop, 1);
  expect(layoutRootBox.height).toBeCloseTo(metrics.availableHeight, 1);
  expect(layoutRootBox.bottom).toBeLessThanOrEqual(metrics.shell.bottom);
  expect(layoutRootBox.width).toBeCloseTo(metrics.availableWidth, 1);
  expectContainedWithin(chatContainerBox, layoutRootBox, `${label} chat container`);
  expectContainedWithin(timelineBox, chatContainerBox, `${label} timeline`);
  expect(timelineBox.height).toBeGreaterThan(80);
}

async function expectSameDomNode(
  locator: Locator,
  original: ElementHandle<HTMLElement | SVGElement>,
  label: string,
): Promise<void> {
  await expect(locator).toBeAttached();
  const isSameNode = await locator.evaluate(
    (element, originalElement) => element.isSameNode(originalElement),
    original,
  );
  expect(isSameNode, `${label} should keep the same DOM node`).toBe(true);
}

async function expectFixedChatSizing(shell: Locator, label: string): Promise<void> {
  const layoutRoot = shell.locator('.chat-artifact-layout').first();
  const chatContainer = shell.locator('.chat-container').first();
  const timeline = shell.locator('.chat-timeline').first();

  await expect(layoutRoot).toHaveClass(/\bchat-public-theme-surface\b/);
  await expect(chatContainer).not.toHaveClass(/\bchat-public-theme-surface\b/);
  await expect(layoutRoot).toHaveJSProperty('style.blockSize', '100%');
  await expect(layoutRoot).toHaveJSProperty('style.minBlockSize', '0px');

  const [shellBox, layoutRootBox, chatContainerBox, timelineBox] = await Promise.all([
    renderedBox(shell, `${label} shell`),
    renderedBox(layoutRoot, `${label} layout root`),
    renderedBox(chatContainer, `${label} chat container`),
    renderedBox(timeline, `${label} timeline`),
  ]);
  expectContainedWithin(layoutRootBox, shellBox, `${label} layout root`);
  expect(layoutRootBox.height).toBeCloseTo(shellBox.height, 1);
  expect(layoutRootBox.width).toBeCloseTo(shellBox.width, 1);
  expectContainedWithin(chatContainerBox, layoutRootBox, `${label} chat container`);
  expectContainedWithin(timelineBox, chatContainerBox, `${label} timeline`);
  expect(timelineBox.height).toBeGreaterThan(80);
}

test('public Chat class sizes documented flex and grid shells with artifact panel open and closed', async ({
  browser,
}, testInfo) => {
  const { page, dispose } = await openChatFixture(browser, {
    colorScheme: 'light',
    viewport: { width: 848, height: 900 },
  });
  try {
    for (const { testId, classNames, label } of [
      {
        testId: 'chat-public-flex-shell',
        classNames: ['chat-public-flex-surface', 'chat-public-theme-surface'],
        label: 'documented flex consumer',
      },
      {
        testId: 'chat-public-grid-shell',
        classNames: ['chat-public-grid-surface'],
        label: 'documented grid consumer',
      },
    ]) {
      const shell = page.getByTestId(testId);
      const composer = shell.locator('.chat-input-area').first();
      const transcript = shell.locator('.chat-timeline').first();
      const composerElement = await composer.elementHandle();
      const transcriptElement = await transcript.elementHandle();
      if (composerElement === null) throw new Error(`${label} composer was not rendered`);
      if (transcriptElement === null) throw new Error(`${label} transcript was not rendered`);
      await expectDocumentedChatSizing(shell, classNames, `${label} closed`);

      await shell
        .getByRole('button', { name: 'Open artifact: Exports report', exact: true })
        .click();
      await expect(shell.locator('.artifact-panel')).toBeVisible();
      await expectDocumentedChatSizing(shell, classNames, `${label} open`);
      await expectSameDomNode(composer, composerElement, `${label} composer after open`);
      await expectSameDomNode(transcript, transcriptElement, `${label} transcript after open`);

      await shell.getByRole('button', { name: 'Close artifact panel' }).click();
      await expect(shell.locator('.artifact-panel')).toHaveCount(0);
      await expectDocumentedChatSizing(shell, classNames, `${label} closed after close`);
      await expectSameDomNode(composer, composerElement, `${label} composer after close`);
      await expectSameDomNode(transcript, transcriptElement, `${label} transcript after close`);
    }

    const fixedShell = page.getByTestId('chat-public-fixed-shell');
    await expectFixedChatSizing(fixedShell, 'fixed-height inline-style consumer');
    await fixedShell
      .getByRole('button', { name: 'Open artifact: Exports report', exact: true })
      .click();
    await expect(fixedShell.locator('.artifact-panel')).toBeVisible();
    await expectFixedChatSizing(fixedShell, 'fixed-height inline-style consumer open');

    await captureHarnessScreenshot(page, testInfo, 'chat-public-sizing-artifact-layout');
  } finally {
    await dispose();
  }
});

async function expectSingleImageGeometry(
  locators: {
    bubble: Locator;
    attachments: Locator;
    figure: Locator;
    button: Locator;
    image: Locator;
  },
  expected: { maxWidth: number; maxHeight: number; ratio: number },
): Promise<void> {
  const [bubbleBox, attachmentsBox, figureBox, buttonBox, imageBox] = await Promise.all([
    locators.bubble.boundingBox(),
    locators.attachments.boundingBox(),
    locators.figure.boundingBox(),
    locators.button.boundingBox(),
    locators.image.boundingBox(),
  ]);
  expect(bubbleBox, 'message bubble must have a rendered box').not.toBeNull();
  expect(attachmentsBox, 'attachment group must have a rendered box').not.toBeNull();
  expect(figureBox, 'single image figure must have a rendered box').not.toBeNull();
  expect(buttonBox, 'single image lightbox button must have a rendered box').not.toBeNull();
  expect(imageBox, 'single image must have a rendered box').not.toBeNull();
  if (
    bubbleBox === null ||
    attachmentsBox === null ||
    figureBox === null ||
    buttonBox === null ||
    imageBox === null
  ) {
    return;
  }

  expect(figureBox.width).toBeGreaterThan(0);
  expect(figureBox.height).toBeGreaterThan(0);
  expect(figureBox.width).toBeLessThanOrEqual(expected.maxWidth);
  expect(figureBox.height).toBeLessThanOrEqual(expected.maxHeight);
  expect(Math.abs(figureBox.width / figureBox.height - expected.ratio)).toBeLessThan(0.06);

  expectContainedWithin(attachmentsBox, bubbleBox, 'attachment group');
  expectContainedWithin(figureBox, attachmentsBox, 'single image figure');
  expectContainedWithin(buttonBox, figureBox, 'single image button');
  expectContainedWithin(imageBox, buttonBox, 'single image');

  await Promise.all([
    expectNoInternalHorizontalOverflow(locators.bubble, 'message bubble'),
    expectNoInternalHorizontalOverflow(locators.attachments, 'attachment group'),
    expectNoInternalHorizontalOverflow(locators.figure, 'single image figure'),
    expectNoInternalHorizontalOverflow(locators.button, 'single image button'),
  ]);

  await expect
    .poll(() =>
      locators.image.evaluate((node) => {
        const image = node as HTMLImageElement;
        return image.naturalWidth > 0 && image.naturalHeight > 0;
      }),
    )
    .toBe(true);
  const naturalSize = await locators.image.evaluate((node) => ({
    naturalWidth: (node as HTMLImageElement).naturalWidth,
    naturalHeight: (node as HTMLImageElement).naturalHeight,
  }));
  expect(naturalSize.naturalWidth).toBeGreaterThan(0);
  expect(naturalSize.naturalHeight).toBeGreaterThan(0);
}

test.describe('chat harness — mounts cleanly', () => {
  test('renders the control panel and the chat under test with a quiet event log', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await expect(harness.locator('[data-testid="harness-controls"]')).toBeVisible();
      await expect(harness.locator('#harness-chat')).toBeVisible();
      // The unread-indicator de-dupe keeps the mount burst out of the log: at
      // rest there is at most one entry.
      const entries = await harness.locator('[data-testid="event-log-entry"]').count();
      expect(entries).toBeLessThanOrEqual(1);
    } finally {
      await dispose();
    }
  });

  test('Chat tool approvals use the shared Cinder approval surface', async ({ browser }) => {
    const cinderCardCounts: number[] = [];
    for (const colorScheme of ['dark', 'light'] as const) {
      const context = await browser.newContext({
        baseURL: environmentConfiguration().browserFixtureUrl ?? 'http://127.0.0.1:5577',
        colorScheme,
        reducedMotion: 'reduce',
        viewport: { width: 1280, height: 900 },
      });
      const diagnostics: string[] = [];
      try {
        await context.addInitScript(
          ([key, value]) => {
            localStorage.setItem(key, value);
          },
          [THEME_STORAGE_KEY, colorScheme] as const,
        );
        const page = await context.newPage();
        page.on('pageerror', (error) => diagnostics.push(error.stack ?? error.message));
        page.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            diagnostics.push(`${message.type()}: ${message.text()}`);
          }
        });
        await page.goto(fixtureRoute('chat'), { waitUntil: 'load' });
        await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
        const approvalChat = page.locator('#fixture-tool-approval-chat');
        await expect(approvalChat).toBeVisible();
        await expect(
          approvalChat
            .locator('.chat-tool-approval-message')
            .getByText('Approve running this tool before it executes?', { exact: true }),
        ).toBeVisible();
        await expect(
          approvalChat.locator('.chat-tool-approval-name').getByText('deploy_to_production', {
            exact: true,
          }),
        ).toBeVisible();
        cinderCardCounts.push(await approvalChat.locator('.cinder-approval-card').count());
        expect(
          diagnostics,
          'Chat approval fixture must not emit browser errors or warnings',
        ).toEqual([]);
      } finally {
        await context.close();
      }
    }

    expect(cinderCardCounts).toEqual([1, 1]);
  });
});

test.describe('chat harness — submit and reply', () => {
  test('a composer submit appends a user message and an auto-reply lands', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      const composer = harness.locator('textarea.chat-input-editor').first();
      await composer.fill('What is alpha?');
      await harness.locator('.chat-input-send').click();

      await expect(harness.locator('[data-role="user"]')).toContainText('What is alpha?');
      await expectLoggedEvent(harness, 'onsubmit');
      // Auto-reply (default on) eventually lands an assistant message.
      await expect(harness.locator('[data-role="assistant"]')).toBeVisible({ timeout: 5_000 });
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — typing indicator', () => {
  test('typing reply shows the indicator, then clears and the message appears', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      // The typing indicator renders only inside a NON-empty transcript (Chat
      // gates it behind the {:else} of `messages.length === 0`), so seed a
      // thread first. Default reply mode is "typing".
      await harness.locator('[data-testid="seed-thread"]').click();
      await expect(harness.locator('[data-role="assistant"]').first()).toBeVisible();

      await harness.locator('[data-testid="send-reply"]').click();
      // The indicator's enter animation animates opacity 0→1; under ?snapshot=1
      // (animation-duration: 0s, no fill-mode) it holds at opacity 0, so assert
      // it is ATTACHED (rendered in the DOM) rather than "visible" — being in
      // the DOM is what proves the typing state. Its accessible name carries the
      // streamingStatus.
      const indicator = harness.locator('.chat-typing-indicator');
      await expect(indicator).toBeAttached();
      await expect(indicator).toHaveAttribute('aria-label', 'Assistant is typing…');
      // Then it clears and a new assistant message lands.
      await expect(indicator).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await dispose();
    }
  });

  test('adapter typing identity replaces the empty transcript state', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser, {
      colorScheme: 'light',
      viewport: { width: 512, height: 900 },
    });
    try {
      await useHarnessAdapter(page);
      await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');
      await harness.locator('[data-testid="clear"]').click();
      await expect(harness.locator('.chat-empty')).toBeVisible();

      await pushHarnessTypingSnapshot(page, [
        { id: 'p1', name: 'Old name' },
        { id: 'p1', name: 'Avery' },
      ]);
      const typingLabel = harness.locator('.chat-participant-typing-label');
      await expect(typingLabel).toHaveText('Avery is typing…');
      await expect(harness.locator('.chat-empty')).toHaveCount(0);
      await expect(harness.locator('#harness-chat')).not.toContainText('Someone');

      await pushHarnessTypingSnapshot(page, [
        { id: 'p1', name: 'Avery' },
        { id: 'p2', name: 'Blake' },
      ]);
      await expect(typingLabel).toHaveText('Avery and Blake are typing…');

      await pushHarnessTypingSnapshot(page, [
        { id: 'p2', name: 'Blake' },
        { id: 'p3', name: 'Casey' },
        { id: 'p4', name: 'Devon' },
      ]);
      await expect(typingLabel).toHaveText('3 people are typing…');

      await pushHarnessTypingSnapshot(page, [{ id: 'p2', name: 'Blake' }]);
      await expect(typingLabel).toHaveText('Blake is typing…');
      await expect(harness.locator('#harness-chat')).not.toContainText('Avery is typing');

      await setHarnessDirectTypingParticipants(page, [{ id: 'direct', name: 'Dana' }]);
      await expect(typingLabel).toHaveText('Dana is typing…');
      await pushHarnessTypingSnapshot(page, [{ id: 'adapter', name: 'Elliot' }]);
      await expect(typingLabel).toHaveText('Dana is typing…');

      await setHarnessDirectTypingParticipants(page, undefined);
      await expect(typingLabel).toHaveText('Elliot is typing…');
      await pushHarnessTypingSnapshot(page, []);
      await expect(harness.locator('.chat-participant-typing-indicator')).toHaveCount(0);
      await expect(harness.locator('.chat-empty')).toBeVisible();
    } finally {
      await dispose();
    }
  });
});

for (const mechanism of ['imperative', 'content-mutation'] as const) {
  test.describe(`chat harness — streaming (${mechanism})`, () => {
    test('streams an intermediate partial, then Stop preserves it', async ({ browser }) => {
      const { harness, dispose } = await openHarness(browser);
      try {
        // Switch to streaming, then pick the mechanism.
        await harness
          .locator('#harness-reply-mode')
          .getByText('Streaming', { exact: true })
          .click();
        const label = mechanism === 'imperative' ? 'Imperative' : 'Content';
        await harness
          .locator('#harness-stream-mechanism')
          .getByText(label, { exact: true })
          .click();

        await harness.locator('[data-testid="send-reply"]').click();

        // The composer shows the Stop affordance while streaming.
        const stop = harness.locator('.chat-input-send[data-stop]');
        await expect(stop).toBeVisible();

        // The assistant message text grows across the deterministic cadence:
        // observe an intermediate partial that is non-empty but not yet final.
        const assistant = harness.locator('[data-role="assistant"]').last();
        await expect.poll(() => messageBodyText(assistant), { timeout: 3_000 }).not.toBe('');
        await expect(harness.locator('.chat-typing-indicator')).toHaveCount(0);
        await expect(assistant.locator('.chat-message')).toHaveAttribute('aria-busy', 'true');
        await expect(assistant.locator('.chat-message-streaming-progress')).toBeVisible();
        const partialText = await messageBodyText(assistant);

        // Click Stop: it preserves the partial content and fires onstopgenerating.
        await stop.click();
        await expectLoggedEvent(harness, 'onstopgenerating');
        await expect(harness.locator('.chat-input-send[data-stop]')).toHaveCount(0);
        // Exactly one assistant message remains (no stray blank/duplicate).
        await expect(harness.locator('[data-role="assistant"]')).toHaveCount(1);
        const afterStopText = await messageBodyText(assistant);
        expect(afterStopText.length).toBeGreaterThanOrEqual(partialText.length);
        expect(partialText.startsWith(afterStopText) || afterStopText.startsWith(partialText)).toBe(
          true,
        );
      } finally {
        await dispose();
      }
    });
  });
}

test.describe('chat harness — streaming presentation', () => {
  test('beginStreaming keeps the separate typing indicator until the first non-empty token', async ({
    browser,
  }, testInfo) => {
    const { page, harness, dispose } = await openHarness(browser, {
      colorScheme: 'light',
      viewport: { width: 512, height: 900 },
    });
    try {
      await harness.locator('#harness-reply-mode').getByText('Streaming', { exact: true }).click();
      await harness
        .locator('#harness-stream-mechanism')
        .getByText('Imperative', { exact: true })
        .click();
      await holdNextFirstStreamToken(page);
      await harness.locator('[data-testid="send-reply"]').click();

      const assistant = harness.locator('[data-role="assistant"]').last();
      const message = assistant.locator('.chat-message');
      const externalTyping = harness.locator('.chat-typing-indicator');
      const progress = assistant.locator('.chat-message-streaming-progress');

      await expect(externalTyping).toBeVisible();
      await expect(message).not.toHaveAttribute('aria-busy', 'true');
      await expect(progress).toHaveCount(0);
      await captureHarnessScreenshot(page, testInfo, 'held-first-token-before');

      await expect.poll(() => trimmedLength(assistant), { timeout: 3_000 }).toBeGreaterThan(0);
      await expect(externalTyping).toHaveCount(0);
      await expect(message).toHaveAttribute('aria-busy', 'true');
      await expect(progress).toBeVisible();
      await captureHarnessScreenshot(page, testInfo, 'held-first-token-after');
    } finally {
      await dispose();
    }
  });

  for (const width of [320, 512, 848] as const) {
    test(`partial streaming uses one stable in-message progress surface at ${width}px`, async ({
      browser,
    }, testInfo) => {
      const { page, harness, dispose } = await openHarness(browser, {
        colorScheme: width === 512 ? 'dark' : 'light',
        viewport: { width, height: 1100 },
      });
      try {
        await harness
          .locator('#harness-reply-mode')
          .getByText('Streaming', { exact: true })
          .click();
        await harness
          .locator('#harness-stream-mechanism')
          .getByText('Imperative', { exact: true })
          .click();
        await harness.locator('[data-testid="send-reply"]').click();

        const assistant = harness.locator('[data-role="assistant"]').last();
        const message = assistant.locator('.chat-message');
        await expect.poll(() => trimmedLength(assistant), { timeout: 3_000 }).toBeGreaterThan(0);
        await expect(harness.locator('.chat-typing-indicator')).toHaveCount(0);
        await expect(message).toHaveAttribute('aria-busy', 'true');
        const progress = assistant.locator('.chat-message-streaming-progress');
        await expect(progress).toBeVisible();
        await expect(progress).toHaveAttribute('aria-hidden', 'true');
        await captureHarnessScreenshot(page, testInfo, `streaming-progress-${width}`);
        const partialBox = await renderedBox(message, 'streaming assistant message');
        const partialWidth = partialBox.width;

        await expect(harness.locator('.chat-input-send[data-stop]')).toHaveCount(0, {
          timeout: 5_000,
        });
        await expect(progress).toHaveCount(0);
        await expect(message).not.toHaveAttribute('aria-busy', 'true');
        const finalBox = await renderedBox(message, 'final assistant message');
        const finalWidth = finalBox.width;
        expect(Math.abs(partialWidth - finalWidth)).toBeLessThanOrEqual(1);
        await expect
          .poll(() =>
            page.evaluate(() =>
              Math.ceil(document.documentElement.scrollWidth - window.innerWidth),
            ),
          )
          .toBeLessThanOrEqual(1);
      } finally {
        await dispose();
      }
    });
  }
});

test.describe('chat harness — tool calls', () => {
  async function appendToolScenario(page: Page, scenario: string): Promise<void> {
    await page.evaluate((name) => {
      const appendScenario = (
        window as typeof window & {
          corvidaeChatHarnessAppendToolScenario?: (scenario: string) => void;
        }
      ).corvidaeChatHarnessAppendToolScenario;
      if (!appendScenario) throw new Error('Chat harness tool scenario hook is unavailable.');
      appendScenario(name);
    }, scenario);
  }

  async function setHarnessCustomMessageSnippets(page: Page, enabled: boolean): Promise<void> {
    await page.evaluate((nextEnabled) => {
      const setCustomMessageSnippets = (
        window as typeof window & {
          corvidaeChatHarnessSetCustomMessageSnippets?: (enabled: boolean) => void;
        }
      ).corvidaeChatHarnessSetCustomMessageSnippets;
      if (!setCustomMessageSnippets) {
        throw new Error('Chat harness custom message snippet hook is unavailable.');
      }
      setCustomMessageSnippets(nextEnabled);
    }, enabled);
  }

  async function enableHarnessAdapter(page: Page): Promise<void> {
    await page.evaluate(() => {
      const useAdapter = (
        window as typeof window & {
          corvidaeChatHarnessUseAdapter?: () => void;
        }
      ).corvidaeChatHarnessUseAdapter;
      if (!useAdapter) throw new Error('Chat harness adapter hook is unavailable.');
      useAdapter();
    });
  }

  async function activeNavigationRow(page: Page): Promise<{
    id: string;
    role: string | null;
    toolCallCount: string | null;
    text: string;
    isTimeline: boolean;
  } | null> {
    return page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      return {
        id: active.id,
        role: active.dataset['messageRole'] ?? null,
        toolCallCount: active.dataset['cinderToolCallCount'] ?? null,
        text: active.textContent?.trim() ?? '',
        isTimeline: active.classList.contains('chat-tool-call-timeline'),
      };
    });
  }

  async function expectNoPageOverflow(page: Page): Promise<void> {
    await expect
      .poll(() =>
        page.evaluate(() => Math.ceil(document.documentElement.scrollWidth - window.innerWidth)),
      )
      .toBeLessThanOrEqual(1);
  }

  async function expectHeaderCentersAligned(step: Locator): Promise<void> {
    const centers = await step.locator('.cinder-run-step-timeline__header').evaluate((header) => {
      const icon = header.querySelector<HTMLElement>('.cinder-run-step-timeline__icon');
      const label = header.querySelector<HTMLElement>('.cinder-run-step-timeline__label');
      const status = header.querySelector<HTMLElement>('.cinder-run-step-timeline__status');
      if (!label || !status) throw new Error('Header label/status missing.');
      const center = (element: Element) => {
        const box = element.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      return {
        icon: icon ? center(icon) : null,
        label: center(label),
        status: center(status),
      };
    });
    expect(Math.abs(centers.label - centers.status)).toBeLessThanOrEqual(2);
    if (centers.icon !== null)
      expect(Math.abs(centers.icon - centers.label)).toBeLessThanOrEqual(2);
  }

  async function expectContainerThreshold(activity: Locator, width: number): Promise<void> {
    const metrics = await activity.evaluate((element) => {
      let current: HTMLElement | null = element.parentElement;
      while (current) {
        const style = getComputedStyle(current);
        if (style.containerType !== 'normal') {
          const box = current.getBoundingClientRect();
          return {
            containerWidth: box.width,
            containerType: style.containerType,
            minInlineSize: getComputedStyle(element).minInlineSize,
          };
        }
        current = current.parentElement;
      }
      return {
        containerWidth: null,
        containerType: 'none',
        minInlineSize: getComputedStyle(element).minInlineSize,
      };
    });
    expect(metrics.containerType).not.toBe('none');
    if (width === 320) {
      expect(metrics.containerWidth ?? 0).toBeLessThan(352);
      expect(metrics.minInlineSize).toBe('0px');
    } else {
      expect(metrics.containerWidth ?? 0).toBeGreaterThanOrEqual(352);
      expect(metrics.minInlineSize).toBe('320px');
    }
  }

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [320, 512, 848] as const) {
      test(`tool activity uses one compact syntax-highlighted detail surface (${colorScheme}, ${width}px)`, async ({
        browser,
      }, testInfo) => {
        const { page, harness, dispose } = await openHarness(browser, {
          colorScheme,
          viewport: { width, height: 1000 },
        });
        try {
          for (const { outcome, argumentsText, status, expectedText } of [
            {
              outcome: 'success',
              argumentsText:
                '{"package":"@corvidae/cinder","checks":["exports","types"],"long":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
              status: 'succeeded',
              expectedText: '@corvidae/cinder',
            },
            {
              outcome: 'error',
              argumentsText: '["exports","runtime",null]',
              status: 'failed',
              expectedText: 'exports',
            },
            {
              outcome: 'action_required',
              argumentsText: 'null',
              status: 'waiting_approval',
              expectedText: 'null',
            },
          ] as const) {
            await harness.locator('[data-testid="tool-arguments"]').fill(argumentsText);
            await harness.locator('#harness-tool-outcome').selectOption(outcome);
            await harness.locator('[data-testid="inject-tool"]').click();

            const activity = harness.locator('.chat-tool-call-timeline').last();
            await expect(activity).toBeVisible();
            await expect(activity.locator('.tool-call-group')).toHaveCount(0);
            await expect(activity).toHaveAttribute('data-cinder-tool-call-count', '1');
            await expect(activity).toContainText('exports_check');
            await expectContainerThreshold(activity, width);

            const step = activity.locator('.cinder-run-step-timeline__item').last();
            await expect(step).toHaveAttribute('data-cinder-status', status);
            await expect(step.locator('.cinder-run-step-timeline__header')).toBeVisible();
            await expectHeaderCentersAligned(step);

            const disclosure = step.getByRole('button', { name: 'Arguments' });
            await disclosure.focus();
            await expect(disclosure).toBeFocused();
            await page.keyboard.press('Enter');

            const details = step.locator('.cinder-run-step-timeline__details');
            await expect(details).toBeVisible();
            await expect(details.locator('.tool-call-section-title')).toHaveCount(0);

            const codeBlock = details.locator('.cinder-code-block').first();
            await expect(codeBlock).toBeVisible();
            await expect(codeBlock.locator('.cinder-code-block__language')).toHaveCount(0);
            const codePre = codeBlock.locator('pre').first();
            await expect(codePre).toContainText(expectedText);
            const codePadding = await codeBlock.evaluate((element) => {
              const probe = document.createElement('div');
              probe.style.padding = 'var(--cinder-code-block-padding)';
              element.append(probe);
              const style = getComputedStyle(probe);
              const padding = Math.max(
                Number.parseFloat(style.paddingTop),
                Number.parseFloat(style.paddingRight),
                Number.parseFloat(style.paddingBottom),
                Number.parseFloat(style.paddingLeft),
              );
              probe.remove();
              return padding;
            });
            expect(codePadding).toBeLessThanOrEqual(12);

            await expectNoPageOverflow(page);
          }

          await appendToolScenario(page, 'pending');
          const pending = harness.locator('.chat-tool-call-timeline').last();
          await expect(pending).toBeVisible();
          await expect(pending.locator('.cinder-run-step-timeline__item')).toHaveAttribute(
            'data-cinder-status',
            'pending',
          );
          await expect(pending.locator('.cinder-run-step-timeline__icon')).toHaveCount(0);
          await expectHeaderCentersAligned(pending.locator('.cinder-run-step-timeline__item'));

          await appendToolScenario(page, 'text-success');
          const textActivity = harness.locator('.chat-tool-call-timeline').last();
          await expect(textActivity).toBeVisible();
          await textActivity.getByRole('button', { name: 'Result' }).click();
          await expect(
            textActivity.locator('.cinder-run-step-timeline__detail-content'),
          ).toContainText('plain text result from the tool');
          await expect(textActivity.locator('.cinder-code-block')).toHaveCount(1);

          await enableHarnessAdapter(page);
          await appendToolScenario(page, 'json-success');
          const presentationActivity = harness.locator('.chat-tool-call-timeline').last();
          await expect(presentationActivity).toBeVisible();
          await expect(
            presentationActivity.locator('.cinder-run-step-timeline__icon'),
          ).toBeVisible();
          await expect(
            presentationActivity.locator('[data-cinder-tool-activity-active]'),
          ).toHaveCount(0);
          await expect(
            presentationActivity.locator('.cinder-run-step-timeline__label'),
          ).toContainText('Checked exports_check');
          await expectHeaderCentersAligned(
            presentationActivity.locator('.cinder-run-step-timeline__item'),
          );

          await setHarnessCustomMessageSnippets(page, false);
          await harness.locator('[data-testid="clear"]').click();
          await expect(harness.locator('.chat-tool-call-timeline')).toHaveCount(0);
          await appendToolScenario(page, 'grouped');
          const grouped = harness.locator('.chat-tool-call-timeline').last();
          await expect(grouped).toBeVisible();
          await expect(harness.locator('[data-testid="harness-message-action"]')).toHaveCount(0);
          await expect(harness.locator('[data-testid="harness-message-status"]')).toHaveCount(0);
          await expect(grouped).toHaveAttribute('data-cinder-tool-call-count', '2');
          await expect(grouped.locator('.cinder-run-step-timeline__item')).toHaveCount(2);
          await grouped.getByRole('button', { name: 'Error' }).click();
          await expect(grouped).toContainText('Type check failed for the chat package.');

          await captureHarnessScreenshot(
            page,
            testInfo,
            `chat-tool-activity-detail-surface-${colorScheme}-${width}`,
          );
        } finally {
          await dispose();
        }
      });
    }
  }

  for (const { outcome, status } of [
    { outcome: 'success', status: 'succeeded' },
    { outcome: 'error', status: 'failed' },
    { outcome: 'action_required', status: 'waiting_approval' },
  ] as const) {
    test(`injects a ${outcome} tool call rendering data-cinder-status="${status}"`, async ({
      browser,
    }) => {
      const { harness, dispose } = await openHarness(browser);
      try {
        await harness.locator('#harness-tool-outcome').selectOption(outcome);
        await harness.locator('[data-testid="inject-tool"]').click();

        const activity = harness.locator('.chat-tool-call-timeline').last();
        await expect(activity).toBeVisible();
        await expect(activity.locator('.cinder-run-step-timeline__item')).toHaveAttribute(
          'data-cinder-status',
          status,
        );
        await expect(activity.locator('.cinder-run-step-timeline__label')).toContainText(
          'exports_check',
        );
        await expect(harness.locator('#harness-chat')).not.toContainText('[object Object]');
      } finally {
        await dispose();
      }
    });
  }

  test('invalid JSON arguments disables Inject and shows an error hint', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      const args = harness.locator('[data-testid="tool-arguments"]');
      await args.fill('{ not valid json');
      await expect(harness.locator('[data-testid="tool-arguments-error"]')).toBeVisible();
      await expect(harness.locator('[data-testid="inject-tool"]')).toBeDisabled();
    } finally {
      await dispose();
    }
  });

  test('a completed tool activity row is keyboard reachable and discloses its payload', async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="inject-tool"]').click();

      const activity = harness.locator('.chat-tool-call-timeline').last();
      await expect(activity).toBeVisible();
      await expect(activity.locator('.cinder-run-step-timeline__item')).toHaveAttribute(
        'data-cinder-status',
        'succeeded',
      );
      await expect(activity.locator('.cinder-run-step-timeline__label')).toContainText(
        'exports_check',
      );

      const disclosure = activity.getByRole('button', { name: 'Arguments' });
      await expect(disclosure).toBeVisible();
      await disclosure.focus();
      await expect(disclosure).toBeFocused();
      await page.keyboard.press('Enter');
      const argumentsPanel = activity.getByRole('region', { name: 'Arguments' });
      await expect(argumentsPanel).toBeVisible();
      await expect(argumentsPanel).toContainText('@corvidae/cinder');
      await page.keyboard.press('Enter');
      await expect(argumentsPanel).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('keeps standalone tool activity IDs unique and preserves one keyboard stop per row', async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await appendToolScenario(page, 'duplicate-call-id');

      const standaloneTimelines = harness.locator('.chat-message .chat-tool-call-timeline');
      await expect(standaloneTimelines).toHaveCount(2);
      const timelineIdentities = await standaloneTimelines.evaluateAll((elements) =>
        elements.map((element) => ({
          id: element.id,
          labelledBy: element.getAttribute('aria-labelledby'),
          headingId: element.querySelector('h3')?.id ?? '',
        })),
      );
      expect(new Set(timelineIdentities.map(({ id }) => id)).size).toBe(timelineIdentities.length);
      expect(new Set(timelineIdentities.map(({ headingId }) => headingId)).size).toBe(
        timelineIdentities.length,
      );
      for (const identity of timelineIdentities) {
        expect(identity.id).toContain('duplicate-occurrence-');
        expect(identity.labelledBy).toBe(identity.headingId);
      }

      await appendToolScenario(page, 'standalone-navigation');
      const beforeStandalone = harness
        .locator('.chat-message')
        .filter({ hasText: 'Before standalone tool activity.' });
      await beforeStandalone.focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => activeNavigationRow(page))
        .toMatchObject({
          role: 'tool-call',
          isTimeline: false,
        });
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => activeNavigationRow(page))
        .toMatchObject({
          role: 'assistant',
        });

      await setHarnessCustomMessageSnippets(page, false);
      await appendToolScenario(page, 'grouped-navigation');
      const beforeGrouped = harness
        .locator('.chat-message')
        .filter({ hasText: 'Before grouped tool activity.' });
      await beforeGrouped.focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => activeNavigationRow(page))
        .toMatchObject({
          isTimeline: true,
          toolCallCount: '2',
        });
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => activeNavigationRow(page))
        .toMatchObject({
          role: 'assistant',
        });
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — empty state and prompts', () => {
  test('clearing shows empty prompts; clicking one submits it', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="clear"]').click();
      const prompts = harness.locator('.chat-empty-prompt');
      await expect(prompts.first()).toBeVisible();
      await prompts.first().click();
      await expect(harness.locator('[data-role="user"]')).toBeVisible();
    } finally {
      await dispose();
    }
  });

  test('toggling emptyPrompts off removes the starter prompts from the empty state', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="clear"]').click();
      // Prompts on (default): the empty state shows starter prompt buttons.
      await expect(harness.locator('.chat-empty-prompt').first()).toBeVisible();
      // Toggle off: the empty state remains but the prompts are gone.
      await harness.locator('#t-prompts').click();
      await expect(harness.locator('.chat-empty')).toBeVisible();
      await expect(harness.locator('.chat-empty-prompt')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — feature toggles', () => {
  test('allowCopy toggles the per-message copy button', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="send-reply"]').click();
      await expect(harness.locator('.chat-message-copy').first()).toBeVisible({ timeout: 5_000 });
      await harness.locator('#t-copy').click();
      await expect(harness.locator('.chat-message-copy')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('allowSearch gates the in-app search bar', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      // Search on (default): Ctrl/Cmd+F over the timeline opens the search bar.
      await harness.locator('.chat-timeline').click();
      await page.keyboard.press('ControlOrMeta+f');
      await expect(harness.locator('.chat-search-input')).toBeVisible();

      // Toggle search off, reload state by closing, and confirm the bar no
      // longer opens.
      await page.keyboard.press('Escape');
      await harness.locator('#t-search').click();
      await expect(harness.locator('#t-search')).toHaveAttribute('aria-checked', 'false');
      await harness.locator('.chat-timeline').click();
      await page.keyboard.press('ControlOrMeta+f');
      await expect(harness.locator('.chat-search-input')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('surfaceMode toggle flips the container surface attribute', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      const container = harness.locator('.chat-container');
      const before = await container.getAttribute('data-surface-mode');
      await harness.locator('#t-surface').click();
      await expect.poll(async () => container.getAttribute('data-surface-mode')).not.toBe(before);
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — snippets', () => {
  test('header / messageActions / messageStatus snippets render', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await expect(harness.locator('[data-testid="harness-header"]')).toBeVisible();
      await harness.locator('[data-testid="send-reply"]').click();
      await expect(harness.locator('[data-testid="harness-message-action"]').first()).toBeVisible({
        timeout: 5_000,
      });
      await expect(harness.locator('[data-testid="harness-message-status"]').first()).toBeVisible();
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — message metadata', () => {
  test('message metadata reveals timestamps without receipt overlap', async ({
    browser,
  }, testInfo) => {
    for (const { colorScheme, hasTouch } of [
      { colorScheme: 'light' as const, hasTouch: false },
      { colorScheme: 'dark' as const, hasTouch: true },
    ]) {
      const { page, harness, dispose } = await openHarness(browser, {
        colorScheme,
        hasTouch,
        locale: 'en-US',
        timezoneId: 'UTC',
        viewport: { width: hasTouch ? 320 : 848, height: 900 },
      });
      try {
        await harness.locator('[data-testid="seed-metadata"]').click();
        const wrapper = harness.locator('[data-role="user"]').filter({
          hasText: 'Timestamped message with enough text',
        });
        await expect(wrapper).toHaveCount(1);
        const metadata = wrapper.locator('.chat-message-metadata');
        const timestamp = metadata.locator('time');
        const receipt = metadata.locator('.chat-read-receipt');
        await expect(timestamp).toHaveAttribute('datetime', '2026-01-01T12:34:00Z');
        await expect(timestamp).toHaveText('12:34 PM');
        await expect(receipt).toHaveAccessibleName('Read by Avery');

        if (!hasTouch) {
          await expect.poll(() => computedOpacity(timestamp)).toBe(0);
          await wrapper.locator('.chat-message').hover();
          await expect.poll(() => computedOpacity(timestamp)).toBe(1);
          await page.mouse.move(0, 0);
          await expect.poll(() => computedOpacity(timestamp)).toBe(0);
          await wrapper.locator('.chat-message').focus();
          await expect.poll(() => computedOpacity(timestamp)).toBe(1);
        } else {
          await expect.poll(() => computedOpacity(timestamp)).toBe(1);
        }
        await expect(timestamp).toBeVisible();
        await captureHarnessScreenshot(page, testInfo, `metadata-${colorScheme}`);

        const [messageBox, metadataBox, receiptBox, bodyBox] = await Promise.all([
          renderedBox(wrapper.locator('.chat-message'), 'metadata message bubble'),
          renderedBox(metadata, 'metadata row'),
          renderedBox(receipt, 'read receipt'),
          renderedBox(wrapper.locator('.chat-message-body'), 'message body'),
        ]);
        expect(metadataBox.y).toBeGreaterThanOrEqual(messageBox.y + messageBox.height - 1);
        expect(receiptBox.y).toBeGreaterThanOrEqual(messageBox.y + messageBox.height - 1);
        expect(receiptBox.y).toBeGreaterThanOrEqual(metadataBox.y - 1);
        expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(metadataBox.y + 1);
      } finally {
        await dispose();
      }
    }
  });
});

test.describe('chat harness — search', () => {
  test('searching a known repeated token reports the match count and navigates', async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      // The seeded thread repeats "alpha". Open search and query it.
      await harness.locator('.chat-timeline').click();
      await page.keyboard.press('ControlOrMeta+f');
      const search = harness.locator('.chat-search-input');
      await expect(search).toBeVisible();
      await search.fill('alpha');
      await expect(harness.locator('.chat-search-match-count')).toContainText(/\d+/);
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — copy, edit, retry', () => {
  test('messages expose a copy affordance', async ({ browser }) => {
    // The copied-state transition (data-cinder-copied) and its mechanics are
    // already covered against the default chat example in
    // editors-complex-residual.playwright.ts. Here we just confirm the harness's
    // messages carry the copy affordance (gated by allowCopy, which the feature-
    // toggle test exercises).
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      await expect(harness.locator('[data-role="assistant"]').first()).toBeVisible();
      // The copy button lives in each message's actions group.
      await expect(harness.locator('.chat-message-copy').first()).toBeAttached();
      await expect(harness.getByRole('button', { name: /copy message/i }).first()).toBeAttached();
    } finally {
      await dispose();
    }
  });

  test('retry appears on a failed message and fires onretry', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-failed"]').click();
      const retry = harness.locator('.chat-message-retry').first();
      await expect(retry).toBeVisible();
      await retry.click();
      await expectLoggedEvent(harness, 'onretry');
    } finally {
      await dispose();
    }
  });

  test('message retry and edit actions stay reachable and compact', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser, {
      colorScheme: 'dark',
      viewport: { width: 512, height: 900 },
    });
    try {
      await harness.locator('[data-testid="seed-failed"]').click();
      const failed = harness.locator('[data-role="user"]').filter({
        hasText: 'This message failed to send.',
      });
      const retry = failed.getByRole('button', { name: 'Retry' });
      await expect(retry).toBeVisible();
      await retry.hover();
      const retryBox = await renderedBox(retry, 'retry action');
      expect(retryBox.width).toBeLessThanOrEqual(36);
      expect(retryBox.height).toBeLessThanOrEqual(36);
      await retry.focus();
      await page.keyboard.press('Enter');
      await expectLoggedEvent(harness, 'onretry');

      await harness.locator('[data-testid="seed-thread"]').click();
      const userMessage = harness.locator('[data-role="user"]').filter({
        hasText: 'Tell me about alpha.',
      });
      const userMessageId = await userMessage.locator('.chat-message').getAttribute('id');
      expect(userMessageId).not.toBeNull();
      const stableUserMessage = harness.locator(`#${userMessageId}`);
      const stableUserWrapper = stableUserMessage.locator('xpath=..');
      await stableUserMessage.hover();
      const edit = stableUserWrapper.getByRole('button', { name: 'Edit message' });
      await expect(edit).toBeVisible();
      await edit.click();

      await expect(stableUserMessage.locator('.chat-message-edit-textarea')).toBeVisible();
      await expect(stableUserMessage.locator('.chat-message-copy')).toHaveCount(0);
      await expect(stableUserMessage.locator('.chat-message-edit-button')).toHaveCount(0);
      const [textareaBox, bubbleBox] = await Promise.all([
        renderedBox(stableUserMessage.locator('.chat-message-edit-textarea'), 'edit textarea'),
        renderedBox(stableUserMessage, 'editing message bubble'),
      ]);
      expect(textareaBox.width).toBeGreaterThanOrEqual(bubbleBox.width - 32);

      for (const button of [
        stableUserMessage.getByRole('button', { name: 'Save' }),
        stableUserMessage.getByRole('button', { name: 'Cancel' }),
      ]) {
        await expect(button).toBeVisible();
        const buttonBox = await renderedBox(button, 'edit action');
        expect(buttonBox.height).toBeLessThanOrEqual(36);
      }
      await page.keyboard.press('Escape');
      await expect(stableUserMessage.locator('.chat-message-edit-textarea')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — scroll, unread, jump', () => {
  test('scrolling a long thread up reveals jump-to-latest and fires scroll state', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      const timeline = harness.locator('.chat-timeline');
      await expect(timeline).toBeVisible();
      await timeline.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect.poll(async () => timeline.evaluate((element) => element.scrollTop)).toBe(0);
      await expect(harness.locator('.chat-jump-button')).toBeVisible({ timeout: 5_000 });
      await expectLoggedEvent(harness, 'onscrollstatechange');
    } finally {
      await dispose();
    }
  });

  test('jump-to-latest scrolls back to the bottom and fires onjumptolatest', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      const timeline = harness.locator('.chat-timeline');
      await timeline.evaluate((element) => {
        element.scrollTop = 0;
      });
      const jump = harness.locator('.chat-jump-button');
      await expect(jump).toBeVisible({ timeout: 5_000 });
      await jump.click();
      await expectLoggedEvent(harness, 'onjumptolatest');
    } finally {
      await dispose();
    }
  });

  test('virtualized history loading preserves the visible scroll anchor', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-virtualized').click();
      await harness.locator('#t-history').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      const anchor = timeline
        .locator('.chat-message')
        .filter({ hasText: 'Tell me about alpha.' })
        .first();
      await expect(anchor).toBeVisible();
      await expect
        .poll(async () => {
          const [anchorBox, timelineBox] = await Promise.all([
            anchor.boundingBox(),
            timeline.boundingBox(),
          ]);
          return anchorBox !== null && timelineBox !== null;
        })
        .toBe(true);
      const before = await anchor.boundingBox();
      const beforeTimeline = await timeline.boundingBox();
      expect(before).not.toBeNull();
      expect(beforeTimeline).not.toBeNull();
      const beforeOffset = (before?.y ?? 0) - (beforeTimeline?.y ?? 0);

      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(anchor).toBeVisible();
      await expect
        .poll(async () => {
          const after = await anchor.boundingBox();
          const afterTimeline = await timeline.boundingBox();
          return Math.abs((after?.y ?? 0) - (afterTimeline?.y ?? 0) - beforeOffset);
        })
        .toBeLessThan(48);
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  // Regression test for #1237: ask for older history while a smooth
  // scroll-to-top glide is still in flight — the natural flow, since the top
  // of the transcript is where the load-earlier trigger lives. The capture
  // used to snapshot the still-moving viewport, and the glide's smooth-scroll
  // animation (absolute target 0, where browsers also suppress native scroll
  // anchoring) then raced Chat's instant restore corrections: whichever
  // landed last won, either stranding the viewport mid-transcript or letting
  // the glide finish at 0 so the transcript shifted by exactly the prepended
  // height. Fixed by finishing the guarded scroll instantly at its
  // destination before capturing, which makes the outcome deterministic: the
  // viewport parks at the old top and the prepend leaves that content
  // exactly where it was.
  test('history prepend keeps the anchored message stable when parked at the top', async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openHarness(browser, {
      reducedMotion: 'no-preference',
    });
    try {
      await harness.locator('#t-history').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      const anchor = timeline
        .locator('.chat-message')
        .filter({ hasText: 'Tell me about alpha.' })
        .first();

      // Pre-pass: measure the anchor's viewport-relative offset with the
      // viewport genuinely parked at the top. This is the deterministic
      // oracle the racy pass below must land on.
      await harness.locator('[data-testid="scroll-top"]').click();
      await expect.poll(async () => timeline.evaluate((element) => element.scrollTop)).toBe(0);
      await page.waitForTimeout(150);
      const parked = await anchor.boundingBox();
      const parkedTimeline = await timeline.boundingBox();
      expect(parked).not.toBeNull();
      expect(parkedTimeline).not.toBeNull();
      const parkedOffset = (parked?.y ?? 0) - (parkedTimeline?.y ?? 0);

      // Back to the bottom, fully settled, so the next scroll-to-top is a
      // real multi-hundred-millisecond glide.
      await harness.locator('[data-testid="scroll-bottom"]').click();
      await expect
        .poll(async () =>
          timeline.evaluate((element) =>
            Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
          ),
        )
        .toBeLessThan(2);
      await page.waitForTimeout(150);

      // Racy pass: start the glide and ask for older history mid-flight.
      // dispatchEvent rather than .click(): the trigger sits at the top of
      // the transcript and Playwright's click would wait for stability and
      // scroll on its own, destroying the mid-glide timing this regression
      // depends on.
      await harness.locator('[data-testid="scroll-top"]').click();
      await timeline.getByRole('button', { name: /load earlier messages/i }).dispatchEvent('click');
      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(timeline.getByText('Earlier context 1.1')).toBeAttached();

      // Wait for restoration (and any leftover animation) to fully settle
      // before measuring. Settling first — rather than polling for a
      // momentarily-close position — matters because the failure mode is a
      // race: a transiently correct position could still be shifted by
      // whichever correction lands last.
      await expect(timeline).not.toHaveAttribute('data-cinder-history-restoring');
      await expect
        .poll(async () =>
          timeline.evaluate(
            (element) =>
              new Promise<boolean>((resolve) => {
                const startTop = element.scrollTop;
                let frames = 0;
                const wait = () => {
                  frames += 1;
                  if (element.scrollTop !== startTop) resolve(false);
                  else if (frames >= 8) resolve(true);
                  else requestAnimationFrame(wait);
                };
                requestAnimationFrame(wait);
              }),
          ),
        )
        .toBe(true);

      // The transcript parked at the old top: the content that was visible
      // there is exactly where it was, with the prepended block above it.
      const after = await anchor.boundingBox();
      const afterTimeline = await timeline.boundingBox();
      expect(after).not.toBeNull();
      expect(afterTimeline).not.toBeNull();
      expect(Math.abs((after?.y ?? 0) - (afterTimeline?.y ?? 0) - parkedOffset)).toBeLessThan(3);
      // Position is held by scroll compensation, not by the prepend failing.
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  test('user input before a prepend retains the non-virtualized history anchor', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      const anchor = timeline.getByText('Tell me about alpha.').first();
      await expect(anchor).toBeVisible();
      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      const resolveHistory = harness.locator('[data-testid="resolve-history"]');
      await expect(resolveHistory).toBeEnabled();
      await timeline.dispatchEvent('pointerdown');
      await timeline.evaluate(async (element) => {
        for (const scrollTop of [40, 80, 120]) {
          element.scrollTop = scrollTop;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      const moved = await anchor.boundingBox();
      const movedTimeline = await timeline.boundingBox();
      expect(moved).not.toBeNull();
      expect(movedTimeline).not.toBeNull();
      const movedOffset = (moved?.y ?? 0) - (movedTimeline?.y ?? 0);

      await resolveHistory.dispatchEvent('click');
      await expectLoggedEvent(harness, 'onloadhistory');
      await expect
        .poll(async () => {
          const after = await anchor.boundingBox();
          const afterTimeline = await timeline.boundingBox();
          return Math.abs((after?.y ?? 0) - (afterTimeline?.y ?? 0) - movedOffset);
        })
        .toBeLessThan(2);
      await expect(timeline).not.toHaveAttribute('data-cinder-history-restoring');
      await expect
        .poll(async () => timeline.evaluate((element) => getComputedStyle(element).overflowAnchor))
        .toBe('auto');
      await expect(
        timeline.locator('.chat-message').filter({ hasText: 'Tell me about alpha.' }).first(),
      ).toBeFocused();
    } finally {
      await dispose();
    }
  });

  test('a delayed history load restores focus after its trigger is enabled', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      const trigger = timeline.getByRole('button', { name: /load earlier messages/i });
      await trigger.click();
      const resolveHistory = harness.locator('[data-testid="resolve-history"]');
      await expect(resolveHistory).toBeEnabled();
      await resolveHistory.dispatchEvent('click');

      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(trigger).toBeEnabled();
      await expect(trigger).toBeFocused();
    } finally {
      await dispose();
    }
  });

  test('a delayed history load does not steal focus from search', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      const trigger = timeline.getByRole('button', { name: /load earlier messages/i });
      await trigger.click();
      const resolveHistory = harness.locator('[data-testid="resolve-history"]');
      await expect(resolveHistory).toBeEnabled();

      await timeline.click();
      await page.keyboard.press('ControlOrMeta+f');
      const searchInput = harness.locator('.chat-search-input');
      await expect(searchInput).toBeFocused();
      await resolveHistory.dispatchEvent('click');

      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(trigger).toBeEnabled();
      await expect(searchInput).toBeFocused();
    } finally {
      await dispose();
    }
  });

  test('clearing cancels delayed history before a fresh load', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      await expect(harness.locator('[data-testid="resolve-history"]')).toBeEnabled();

      await harness.locator('[data-testid="clear"]').click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      await expect(timeline.getByText(/Earlier context/)).toHaveCount(0);
      await expect(
        harness.locator('[data-testid="event-log-entry"][data-event="onloadhistory"]'),
      ).toHaveCount(0);

      await harness.locator('[data-testid="seed-thread"]').click();
      await harness.locator('[data-testid="scroll-top"]').click();
      await timeline.getByRole('button', { name: /load earlier messages/i }).click();

      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(timeline.getByText('Earlier context 1.1')).toBeVisible();
    } finally {
      await dispose();
    }
  });

  test('continued user scrolling wins over non-virtualized history stabilization', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      await expect(harness.locator('[data-testid="resolve-history"]')).toBeEnabled();
      const previousScrollHeight = await timeline.evaluate((element) => element.scrollHeight);
      await harness.locator('[data-testid="resolve-history"]').click();
      await expectLoggedEvent(harness, 'onloadhistory');
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollHeight))
        .toBeGreaterThan(previousScrollHeight);
      await timeline.dispatchEvent('pointerdown');
      await timeline.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
      });

      await timeline.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const wait = () => {
              frames += 1;
              if (frames >= 8) resolve();
              else requestAnimationFrame(wait);
            };
            requestAnimationFrame(wait);
          }),
      );
      await expect
        .poll(async () =>
          timeline.evaluate((element) =>
            Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
          ),
        )
        .toBeLessThan(2);
    } finally {
      await dispose();
    }
  });

  test('a no-op gesture expires before later history stabilization', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      const anchor = timeline
        .locator('.chat-message')
        .filter({ hasText: 'Tell me about alpha.' })
        .first();
      await expect(anchor).toBeVisible();
      await expect
        .poll(async () => {
          const [anchorBox, timelineBox] = await Promise.all([
            anchor.boundingBox(),
            timeline.boundingBox(),
          ]);
          return anchorBox !== null && timelineBox !== null;
        })
        .toBe(true);
      const before = await anchor.boundingBox();
      const beforeTimeline = await timeline.boundingBox();
      expect(before).not.toBeNull();
      expect(beforeTimeline).not.toBeNull();
      const beforeOffset = (before?.y ?? 0) - (beforeTimeline?.y ?? 0);

      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      await expect(harness.locator('[data-testid="resolve-history"]')).toBeEnabled();
      await timeline.dispatchEvent('pointerdown');
      await timeline.evaluate(() => {
        document.querySelector<HTMLButtonElement>('[data-testid="resolve-history"]')?.click();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const firstMessage = document.querySelector<HTMLElement>('.chat-message-wrapper');
            if (firstMessage) firstMessage.style.minHeight = '12rem';
          });
        });
      });

      await expectLoggedEvent(harness, 'onloadhistory');
      await timeline.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const wait = () => {
              frames += 1;
              if (frames >= 8) resolve();
              else requestAnimationFrame(wait);
            };
            requestAnimationFrame(wait);
          }),
      );
      await expect
        .poll(async () => {
          const after = await anchor.boundingBox();
          const afterTimeline = await timeline.boundingBox();
          return Math.abs((after?.y ?? 0) - (afterTimeline?.y ?? 0) - beforeOffset);
        })
        .toBeLessThan(2);
    } finally {
      await dispose();
    }
  });

  test('jumping to latest invalidates a pending non-virtualized history anchor', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      const resolveHistory = harness.locator('[data-testid="resolve-history"]');
      await expect(resolveHistory).toBeEnabled();
      await harness.locator('.chat-jump-button').click();
      await resolveHistory.dispatchEvent('click');

      await expectLoggedEvent(harness, 'onloadhistory');
      await expect
        .poll(async () =>
          timeline.evaluate((element) =>
            Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
          ),
        )
        .toBeLessThan(2);
    } finally {
      await dispose();
    }
  });

  test('an arriving prepend wins over a queued anchor recapture', async ({ browser }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      await expect(harness.locator('[data-testid="resolve-history"]')).toBeEnabled();
      await timeline.evaluate((element) => {
        element.scrollTop = 120;
        element.dispatchEvent(new Event('scroll'));
        document.querySelector<HTMLButtonElement>('[data-testid="resolve-history"]')?.click();
      });

      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(timeline).not.toHaveAttribute('data-cinder-history-restoring');
      await expect
        .poll(async () => timeline.evaluate((element) => getComputedStyle(element).overflowAnchor))
        .toBe('auto');
    } finally {
      await dispose();
    }
  });

  test('search navigation wins over non-virtualized history stabilization', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('#t-history-delay').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await timeline.click();
      await page.keyboard.press('ControlOrMeta+f');
      await expect(harness.locator('.chat-search-input')).toBeVisible();
      await harness.locator('[data-testid="scroll-top"]').click();
      await timeline.getByRole('button', { name: /load earlier messages/i }).click();
      await expect(harness.locator('[data-testid="resolve-history"]')).toBeEnabled();

      await timeline.evaluate(() => {
        document.querySelector<HTMLButtonElement>('[data-testid="resolve-history"]')?.click();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const input = document.querySelector<HTMLInputElement>('.chat-search-input');
            if (!input) return;
            input.value = 'Detailed answer number 12';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
        });
      });

      const target = timeline
        .locator('.chat-message-wrapper[data-search-match]')
        .filter({ hasText: 'Detailed answer number 12, with alpha context.' });
      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(target).toBeAttached();
      await timeline.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const wait = () => {
              frames += 1;
              if (frames >= 8) resolve();
              else requestAnimationFrame(wait);
            };
            requestAnimationFrame(wait);
          }),
      );
      await expect(target).toBeInViewport();
    } finally {
      await dispose();
    }
  });

  test('non-virtualized history loading preserves the visible scroll anchor', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('#t-history').click();
      await harness.locator('[data-testid="seed-thread"]').click();

      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      await expect
        .poll(async () => timeline.evaluate((element) => getComputedStyle(element).overflowAnchor))
        .toBe('auto');
      const anchor = timeline.getByText('Tell me about alpha.').first();
      await expect(anchor).toBeVisible();
      const readAnchorOffset = () =>
        timeline.evaluate((timelineElement) => {
          const anchorElement = Array.from(timelineElement.querySelectorAll<HTMLElement>('*')).find(
            (element) => element.textContent?.trim() === 'Tell me about alpha.',
          );
          if (anchorElement === undefined) throw new Error('Anchor message not found');
          return (
            anchorElement.getBoundingClientRect().y - timelineElement.getBoundingClientRect().y
          );
        });
      const beforeOffset = await readAnchorOffset();

      await timeline.getByRole('button', { name: /load earlier messages/i }).dispatchEvent('click');
      await expectLoggedEvent(harness, 'onloadhistory');
      await expect(anchor).toBeVisible();
      await expect
        .poll(async () => {
          return Math.abs((await readAnchorOffset()) - beforeOffset);
        })
        .toBeLessThan(2);
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await expect
        .poll(async () => timeline.evaluate((element) => getComputedStyle(element).overflowAnchor))
        .toBe('auto');
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — imperative scroll + focus controls', () => {
  test('scroll-to-top / scroll-to-bottom move the timeline; focus-input focuses the composer', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      const timeline = harness.locator('.chat-timeline');
      await harness.locator('[data-testid="scroll-top"]').click();
      await expect.poll(async () => timeline.evaluate((element) => element.scrollTop)).toBe(0);
      await harness.locator('[data-testid="scroll-bottom"]').click();
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);

      await harness.locator('[data-testid="focus-input"]').click();
      const focusedInsideComposer = await harness.evaluate((root) => {
        const active = (root.ownerDocument ?? document).activeElement;
        return (
          active !== null && root.querySelector('.chat-input-editor')?.contains(active) === true
        );
      });
      expect(focusedInsideComposer).toBe(true);
    } finally {
      await dispose();
    }
  });

  // Regression for cinder#1236: on a long VIRTUALIZED transcript pinned to
  // the bottom, scrollToTop() was a no-op (or a snap-back) with real smooth
  // scrolling. The auto-stick effect's instant bottom corrections leave stale
  // scroll/scrollend events in flight at the bottom; one of them settled the
  // user-scroll guard milliseconds into the animation, and the next
  // virtualizer remeasurement re-pinned the viewport to the bottom. This test
  // deliberately runs WITHOUT reducedMotion: 'reduce' (unlike openHarness):
  // the bug only reproduces when behavior: 'smooth' produces a real,
  // interruptible animation.
  test('scrollToTop and scrollToBottom navigate a long virtualized transcript with smooth scrolling', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
      colorScheme: 'dark',
      // Explicit, not defaulted: this test is only meaningful when
      // behavior: 'smooth' produces a real, interruptible animation. A
      // config- or environment-level reduced-motion default would silently
      // downgrade it to an instant scroll and stop covering the regression.
      reducedMotion: 'no-preference',
      viewport: { width: 1280, height: 900 },
    });
    try {
      await context.addInitScript(() => {
        window.addEventListener('error', (event) => {
          const errors = ((
            window as Window & { __chatHarnessErrors?: string[] }
          ).__chatHarnessErrors ??= []);
          errors.push(event.error?.message ?? event.message);
        });
      });
      const page = await context.newPage();
      const pageErrors: Error[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (error) => {
        pageErrors.push(error);
      });
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(fixtureRoute('chat', { fixtureName: 'private-harness', snapshot: false }), {
        waitUntil: 'load',
      });
      await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
      const harness = page.locator(HARNESS);
      await harness.waitFor({ state: 'visible', timeout: 20_000 });

      await harness.locator('#t-virtualized').click();
      await harness.locator('[data-testid="seed-long"]').click();
      const timeline = harness.locator('.chat-timeline');
      // The transcript starts pinned to the bottom with the last rows rendered.
      await expect(timeline.getByText('Answer 150:').first()).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);

      await harness.locator('[data-testid="scroll-top"]').click();
      await expect
        .poll(async () => timeline.evaluate((element) => element.scrollTop), { timeout: 10_000 })
        .toBe(0);
      await expect(timeline.getByText('Question 1: tell me about alpha.').first()).toBeVisible();

      await harness.locator('[data-testid="scroll-bottom"]').click();
      await expect
        .poll(
          async () =>
            timeline.evaluate(
              (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
            ),
          { timeout: 10_000 },
        )
        .toBeLessThan(50);
      await expect(timeline.getByText('Answer 150:').first()).toBeVisible();
      expect(
        [
          ...pageErrors.map((error) => error.message),
          ...consoleErrors,
          ...(await page.evaluate(
            () => (window as Window & { __chatHarnessErrors?: string[] }).__chatHarnessErrors ?? [],
          )),
        ],
        'smooth virtualized scrolling must not emit page or console errors',
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe('chat harness — attachments', () => {
  for (const attachment of [
    {
      label: 'image',
      name: 'attachment-only.png',
      mimeType: 'image/png',
      buffer: validPng,
    },
    {
      label: 'document',
      name: 'attachment-only.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% attachment only\n'),
    },
    {
      label: 'code',
      name: 'attachment-only.ts',
      mimeType: 'text/typescript',
      buffer: Buffer.from('const attachmentOnly = true;\n'),
    },
  ] as const) {
    test(`submits a ready ${attachment.label} attachment with empty text`, async ({ browser }) => {
      const { harness, dispose } = await openHarness(browser);
      try {
        const chat = harness.locator('#harness-chat');
        const fileInput = chat.locator('input[type="file"]');
        await fileInput.setInputFiles({
          name: attachment.name,
          mimeType: attachment.mimeType,
          buffer: attachment.buffer,
        });

        const remove = chat.getByRole('button', { name: `Remove ${attachment.name}` });
        await expect(remove).toBeVisible();
        await expect(remove).toHaveCSS('opacity', '1');

        const send = chat.locator('.chat-input-send');
        await expect(send).toBeEnabled();
        await send.click();
        await expect(
          harness.locator('[data-testid="event-log-entry"][data-event="onsubmit"]').first(),
        ).toHaveAttribute('data-payload', '{"content":"","attachments":1}');
        await expect(chat.locator('.chat-input-attachment-wrapper')).toHaveCount(0);
      } finally {
        await dispose();
      }
    });
  }

  test('keeps the remove control inside the preview with keyboard access', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      const chat = harness.locator('#harness-chat');
      const fileInput = chat.locator('input[type="file"]');
      await fileInput.setInputFiles({
        name: 'remove-target.png',
        mimeType: 'image/png',
        buffer: validPng,
      });

      const wrapper = chat.locator('.chat-input-attachment-wrapper').first();
      const remove = chat.getByRole('button', { name: 'Remove remove-target.png' });
      await expect(remove).toBeVisible();
      await expect(remove).toHaveCSS('opacity', '1');
      const [wrapperBox, removeBox] = await Promise.all([
        wrapper.boundingBox(),
        remove.boundingBox(),
      ]);
      expect(wrapperBox).not.toBeNull();
      expect(removeBox).not.toBeNull();
      expect(removeBox?.width).toBeGreaterThanOrEqual(44);
      expect(removeBox?.height).toBeGreaterThanOrEqual(44);
      expect(removeBox?.x ?? 0).toBeGreaterThanOrEqual(wrapperBox?.x ?? 0);
      expect(removeBox?.y ?? 0).toBeGreaterThanOrEqual(wrapperBox?.y ?? 0);
      expect((removeBox?.x ?? 0) + (removeBox?.width ?? 0)).toBeLessThanOrEqual(
        (wrapperBox?.x ?? 0) + (wrapperBox?.width ?? 0),
      );
      expect((removeBox?.y ?? 0) + (removeBox?.height ?? 0)).toBeLessThanOrEqual(
        (wrapperBox?.y ?? 0) + (wrapperBox?.height ?? 0),
      );

      await remove.focus();
      await expect(remove).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(chat.locator('.chat-input-attachment-wrapper')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('an accepted file fires onattachmentadd; a disallowed file fires onattachmentfailure', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      const fileInput = harness.locator('input[type="file"]');
      // Accepted: an image (the composer accepts images by default).
      await fileInput.setInputFiles({
        name: 'pic.png',
        mimeType: 'image/png',
        buffer: validPng,
      });
      await expectLoggedEvent(harness, 'onattachmentadd');

      // Disallowed MIME → the composer's own validation fires onattachmentfailure.
      await fileInput.setInputFiles({
        name: 'evil.exe',
        mimeType: 'application/x-msdownload',
        buffer: Buffer.from([0x4d, 0x5a]),
      });
      await expectLoggedEvent(harness, 'onattachmentfailure');
    } finally {
      await dispose();
    }
  });

  test('dragging a file onto the chat surface fires onattachmentadd', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await page.evaluate(() => {
        const file = new File(['dragged attachment'], 'dragged.txt', { type: 'text/plain' });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const surface = document.querySelector('.chat-container');
        if (!(surface instanceof HTMLElement)) throw new Error('Chat surface was not found.');
        surface.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }),
        );
        surface.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
        );
      });

      await expectLoggedEvent(harness, 'onattachmentadd');
      await expect(harness.locator('.chat-attachment-preview')).toContainText('dragged.txt');
    } finally {
      await dispose();
    }
  });

  test('attachment picker and composer keep their keyboard accessibility contract', async ({
    browser,
  }) => {
    const { harness, dispose } = await openHarness(browser);
    try {
      const chat = harness.locator('#harness-chat');
      const attachButton = chat.getByRole('button', { name: 'Attach file' });
      await expect(attachButton).toBeVisible();
      await attachButton.focus();
      await expect(attachButton).toBeFocused();

      const picker = chat.locator('input[type="file"]');
      await expect(picker).toHaveAttribute('aria-label', 'Attach files');
      await expect(picker).toHaveAttribute('aria-hidden', 'true');
      await expect(picker).toHaveAttribute('tabindex', '-1');

      const composer = chat.getByRole('textbox', { name: 'Message' });
      await composer.focus();
      await expect(composer).toBeFocused();
      const describedBy = await composer.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      await expect(chat.locator(`#${describedBy}`)).toContainText('Shift');
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — composer help', () => {
  test('composer shortcut help is contextual without shifting footer controls', async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      const chat = harness.locator('#harness-chat');
      const send = chat.locator('.chat-input-send');
      await expect(send).toBeDisabled();
      await send.hover({ force: true });
      await expect(page.getByRole('tooltip')).toHaveText('Add a message or attachment');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);

      const composer = chat.getByRole('textbox', { name: 'Message' });
      await composer.fill('A contextual hint');
      await expect(chat.locator('.chat-input-hint')).toHaveCount(0);

      await expect(send).toBeEnabled();
      await page.mouse.move(0, 0);
      await send.hover();
      await expect(page.getByRole('tooltip')).toHaveText('Send (Enter)');
      await send.focus();
      await expect(page.getByRole('tooltip')).toHaveText('Send (Enter)');
      await send.blur();
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await send.focus();
      await expect(page.getByRole('tooltip')).toHaveText('Send (Enter)');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });
});

test.describe('chat harness — composer acceptance matrix', () => {
  const wideImageMarkup = svgMarkup(1600, 400, 'navy');
  const wideImage = `data:image/svg+xml,${encodeURIComponent(wideImageMarkup)}`;
  const tallImage = svgDataUrl(400, 1600, 'teal');
  const missingRatioImage = `data:image/png;base64,${validPng.toString('base64')}`;

  for (const imageCase of [
    {
      name: 'known-wide',
      image: {
        type: 'image',
        url: wideImage,
        mimeType: 'image/svg+xml',
        text: 'Known wide image',
        width: 1600,
        height: 400,
      },
      expected: { maxWidth: 512, maxHeight: 384, ratio: 4 },
    },
    {
      name: 'known-tall',
      image: {
        type: 'image',
        url: tallImage,
        mimeType: 'image/svg+xml',
        text: 'Known tall image',
        width: 400,
        height: 1600,
      },
      expected: { maxWidth: 512, maxHeight: 384, ratio: 0.25 },
    },
    {
      name: 'missing-ratio',
      image: {
        type: 'image',
        url: missingRatioImage,
        mimeType: 'image/png',
        text: 'Missing ratio image',
      },
      expected: { maxWidth: 512, maxHeight: 384, ratio: 4 / 3 },
    },
  ] satisfies Array<{
    name: string;
    image: HarnessImageContent;
    expected: { maxWidth: number; maxHeight: number; ratio: number };
  }>) {
    test(`bounds a single ${imageCase.name} image at 320px`, async ({ browser }) => {
      const { page, harness, dispose } = await openHarness(browser, {
        viewport: { width: 320, height: 900 },
      });
      try {
        await appendHarnessImages(page, [imageCase.image]);
        const message = harness.locator('[data-role="user"]').last();
        const bubble = message.locator('.chat-message');
        const attachments = message.locator('.message-attachments').last();
        const figure = attachments.locator('.message-attachment').first();
        await expect(attachments).toHaveAttribute('data-count', '1');
        await expectSingleImageGeometry(
          {
            bubble,
            attachments,
            figure,
            button: figure.locator('.message-attachment-button'),
            image: figure.locator('.message-attachment-image'),
          },
          imageCase.expected,
        );
        await expectNoHorizontalOverflow(page);
      } finally {
        await dispose();
      }
    });
  }

  test('keeps the existing multi-image grid rules unchanged', async ({ browser }) => {
    const { page, harness, dispose } = await openHarness(browser, {
      viewport: { width: 320, height: 900 },
    });
    try {
      await appendHarnessImages(page, [
        {
          type: 'image',
          url: wideImage,
          mimeType: 'image/svg+xml',
          text: 'Wide image in grid',
          width: 1600,
          height: 400,
        },
        {
          type: 'image',
          url: tallImage,
          mimeType: 'image/svg+xml',
          text: 'Tall image in grid',
          width: 400,
          height: 1600,
        },
        {
          type: 'image',
          url: missingRatioImage,
          mimeType: 'image/png',
          text: 'Missing ratio grid image',
        },
      ]);
      const attachments = harness.locator('[data-role="user"] .message-attachments').last();
      await expect(attachments).toHaveAttribute('data-count', '3');
      const figures = attachments.locator('.message-attachment');
      await expect(figures).toHaveCount(3);
      await expect
        .poll(() => attachments.evaluate((node) => getComputedStyle(node).display))
        .toBe('grid');
      await expect
        .poll(() => attachments.evaluate((node) => getComputedStyle(node).gridTemplateColumns))
        .not.toBe('none');
      for (let index = 0; index < 3; index += 1) {
        const box = await figures.nth(index).boundingBox();
        expect(box, `attachment ${index + 1} must have a rendered box`).not.toBeNull();
        expect(box?.width).toBeGreaterThan(0);
        expect(box?.height).toBeGreaterThan(0);
        expect(box?.height).toBeLessThanOrEqual(400);
      }
      await expectNoHorizontalOverflow(page);
    } finally {
      await dispose();
    }
  });

  test('keeps maximize pointer and keyboard activation available', async ({ browser }) => {
    const { harness, page, dispose } = await openHarness(browser);
    try {
      const chat = harness.locator('#harness-chat');
      await chat.locator('input[type="file"]').setInputFiles({
        name: 'maximize.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(wideImageMarkup),
      });
      await chat.locator('.chat-input-send').click();
      const maximize = harness.locator('.message-attachment-button').last();
      const overlay = maximize.locator('.message-attachment-maximize');
      await expect(overlay).toBeVisible();
      const [buttonBox, overlayBox] = await Promise.all([
        maximize.boundingBox(),
        overlay.boundingBox(),
      ]);
      expect(buttonBox).not.toBeNull();
      expect(overlayBox).not.toBeNull();
      expect(overlayBox?.width).toBeGreaterThanOrEqual(44);
      expect(overlayBox?.height).toBeGreaterThanOrEqual(44);
      expect(overlayBox?.x ?? 0).toBeGreaterThanOrEqual(buttonBox?.x ?? 0);
      expect(overlayBox?.y ?? 0).toBeGreaterThanOrEqual(buttonBox?.y ?? 0);
      expect((overlayBox?.x ?? 0) + (overlayBox?.width ?? 0)).toBeLessThanOrEqual(
        (buttonBox?.x ?? 0) + (buttonBox?.width ?? 0),
      );
      expect((overlayBox?.y ?? 0) + (overlayBox?.height ?? 0)).toBeLessThanOrEqual(
        (buttonBox?.y ?? 0) + (buttonBox?.height ?? 0),
      );
      expect((overlayBox?.x ?? 0) + (overlayBox?.width ?? 0) / 2).toBeGreaterThan(
        (buttonBox?.x ?? 0) + (buttonBox?.width ?? 0) / 2,
      );
      expect((overlayBox?.y ?? 0) + (overlayBox?.height ?? 0) / 2).toBeLessThan(
        (buttonBox?.y ?? 0) + (buttonBox?.height ?? 0) / 2,
      );
      await maximize.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await maximize.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await maximize.focus();
      await page.keyboard.press('Space');
      await expect(page.getByRole('dialog')).toBeVisible();
    } finally {
      await dispose();
    }
  });

  test('blocks pending attachments and gives the disabled trigger full tooltip context', async ({
    browser,
  }) => {
    const { harness, page, dispose } = await openHarness(browser);
    try {
      const chat = harness.locator('#harness-chat');
      await page.evaluate(() => {
        const input = document.querySelector('#harness-chat input[type="file"]');
        if (!(input instanceof HTMLInputElement)) throw new Error('file input missing');
        const file = new File(['pending'], 'pending.ts', { type: 'text/typescript' });
        Object.defineProperty(file, 'text', { value: () => new Promise<string>(() => {}) });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const send = chat.locator('.chat-input-send');
      await expect(send).toBeDisabled();
      await send.hover();
      await expect(page.getByRole('tooltip')).toHaveText('Wait for attachments');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    } finally {
      await dispose();
    }
  });

  test('keeps empty guidance ahead of stop, then shows the stop tooltip when text is present', async ({
    browser,
  }) => {
    const { harness, page, dispose } = await openHarness(browser);
    try {
      await harness.locator('#harness-reply-mode').getByText('Streaming', { exact: true }).click();
      await harness.locator('[data-testid="send-reply"]').click();
      const stop = harness.locator('.chat-input-send[data-stop]');
      await expect(stop).toBeVisible();
      await stop.hover();
      await expect(page.getByRole('tooltip')).toHaveText('Add a message or attachment');
      await page.keyboard.press('Escape');
      await stop.click();

      const composer = harness.locator('#harness-chat').getByRole('textbox', { name: 'Message' });
      await composer.fill('draft while streaming');
      await harness.locator('[data-testid="send-reply"]').click();
      await expect(stop).toBeVisible();
      await stop.hover();
      await expect(page.getByRole('tooltip')).toHaveText('Stop generating');
      await stop.focus();
      await stop.blur();
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await stop.click();
    } finally {
      await dispose();
    }
  });

  test('does not use a coarse-touch shortcut for the disabled trigger tooltip', async ({
    browser,
  }) => {
    const { harness, page, dispose } = await openHarness(browser, {
      hasTouch: true,
      viewport: { width: 320, height: 900 },
    });
    try {
      const chat = harness.locator('#harness-chat');
      const send = chat.locator('.chat-input-send');
      await chat.locator('input[type="file"]').setInputFiles({
        name: 'touch-submit.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(wideImageMarkup),
      });
      await expect(send).toBeEnabled();
      await expect(send).toHaveAttribute('aria-label', 'Send message');
      await send.tap();
      await expect(
        harness.locator('[data-testid="event-log-entry"][data-event="onsubmit"]').first(),
      ).toHaveAttribute('data-payload', '{"content":"","attachments":1}');
      await expect
        .poll(() =>
          harness
            .locator('[data-role="user"] .message-attachment-image')
            .last()
            .evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      await expect(page.locator('[role="tooltip"]:visible')).toHaveCount(0);
      const unrelated = harness.getByTestId('unrelated-tooltip-trigger');
      await unrelated.hover();
      await expect(page.getByRole('tooltip')).toHaveText('Unrelated tooltip remains available');
    } finally {
      await dispose();
    }
  });

  for (const colorScheme of ['dark', 'light'] as const) {
    for (const width of [320, 512, 848]) {
      test(`centers footer controls at ${width}px in ${colorScheme} reduced-motion mode`, async ({
        browser,
      }) => {
        const { harness, dispose } = await openHarness(browser, {
          colorScheme,
          viewport: { width, height: 900 },
          reducedMotion: 'reduce',
        });
        try {
          await expect
            .poll(() =>
              harness.evaluate(() => ({
                theme: document.documentElement.dataset['theme'],
                cinderTheme: document.documentElement.dataset['cinderTheme'],
                colorScheme: getComputedStyle(document.documentElement).colorScheme,
              })),
            )
            .toEqual({ theme: colorScheme, cinderTheme: colorScheme, colorScheme });
          const footer = harness.locator('#harness-chat .chat-input-footer');
          const left = await footer.locator('.chat-input-footer-left').boundingBox();
          const right = await footer.locator('.chat-input-footer-right').boundingBox();
          expect(left).not.toBeNull();
          expect(right).not.toBeNull();
          expect(
            Math.abs(
              (left?.y ?? 0) +
                (left?.height ?? 0) / 2 -
                ((right?.y ?? 0) + (right?.height ?? 0) / 2),
            ),
          ).toBeLessThanOrEqual(1);
          await harness.screenshot({
            path: test.info().outputPath(`chat-composer-${colorScheme}-${width}.png`),
          });
        } finally {
          await dispose();
        }
      });
    }
  }
});

test.describe('chat harness — accessibility', () => {
  test('the harnessed chat exposes log + region roles and has no critical axe violations', async ({
    browser,
  }) => {
    const { page, harness, dispose } = await openHarness(browser);
    try {
      await harness.locator('[data-testid="seed-thread"]').click();
      await expect(harness.locator('[role="region"]')).toBeVisible();
      await expect(harness.locator('[role="log"]')).toBeVisible();

      // Audit the Chat component under test specifically (not the demo control
      // panel, which is harness scaffolding rather than a cinder surface).
      const buckets = await runAxe(
        page,
        { slug: 'chat', theme: 'dark', viewport: 'desktop', fixture: 'private-harness' },
        { include: `${HARNESS} #harness-chat` },
      );
      expect(buckets.critical, JSON.stringify(buckets.critical, null, 2)).toHaveLength(0);
      expect(buckets.serious, JSON.stringify(buckets.serious, null, 2)).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});

// Regression suite for #1237's reopened symptoms, driven against the
// `history-prepend-stress` example: an adapter-mode load-earlier flow inside
// a full-height app shell whose header content (an event log line) grows when
// a load completes — the same geometry as the downstream repro. Three loads
// walk through every trigger state: idle → loading → idle, and finally
// idle → unmounted (last page, hasMore: false).
test.describe('chat harness — history prepend stress (#1237)', () => {
  const STRESS = '[data-testid="chat-private-history-prepend-stress"]';

  test('adapter prepend never presents an uncompensated anchor to the compositor', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      baseURL: environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
      viewport: { width: 1280, height: 900 },
    });
    // `newPage`/`newCDPSession` sat outside the try/finally below that closes
    // `context` -- a failure in either (the CDP session in particular; it's
    // a separate round-trip that can fail independently of page creation)
    // leaked the context, since nothing else here would have closed it.
    // This IIFE keeps that setup inside its own try/catch that closes the
    // context on failure and rethrows, without disturbing the screencast
    // try/finally below.
    const { page, session } = await (async () => {
      try {
        const page = await context.newPage();
        const session = await context.newCDPSession(page);
        return { page, session };
      } catch (error) {
        await context.close();
        throw error;
      }
    })();
    let screencastStarted = false;
    try {
      await page.goto(fixtureRoute('chat', { fixtureName: 'private-history-prepend-stress' }), {
        waitUntil: 'load',
      });
      const mount = page.locator(STRESS);
      await mount.waitFor({ state: 'visible', timeout: 20_000 });
      await mount.scrollIntoViewIfNeeded();
      const timeline = mount.locator('.chat-timeline');

      await mount.locator('[data-testid="stress-scroll-top"]').click();
      await expect.poll(async () => timeline.evaluate((element) => element.scrollTop)).toBe(0);
      await page.waitForTimeout(400);

      const anchorMarkerObserver = await timeline.evaluateHandle((element) => {
        const markAnchor = () => {
          const anchor = Array.from(element.querySelectorAll('.chat-message-body')).find(
            (candidate) => candidate.textContent?.trimStart().startsWith('Live message 1 —'),
          );
          anchor?.setAttribute('data-cinder-paint-anchor', '');
        };
        markAnchor();
        const observer = new MutationObserver(markAnchor);
        observer.observe(element, { childList: true, subtree: true });
        return observer;
      });

      // Paint two high-contrast rulers into the real surface: cyan at the
      // timeline's top edge and magenta across the retained message. CDP's
      // screencast event is emitted from compositor presentations, so unlike
      // a DOM read inside requestAnimationFrame this observes what Chromium
      // actually displayed.
      await page.addStyleTag({
        content: `
          .chat-timeline { box-shadow: inset 0 5px 0 rgb(0 255 255) !important; }
          [data-cinder-paint-anchor] {
            background: rgb(255 0 255) !important;
            border-color: rgb(255 0 255) !important;
            color: rgb(255 0 255) !important;
          }
        `,
      });

      const measureFrame = (data: Buffer): number | null => {
        const image = PNG.sync.read(data);
        let timelineTop = -1;
        let anchorTop = -1;

        for (let y = 0; y < image.height; y += 1) {
          let cyanPixels = 0;
          let magentaPixels = 0;
          for (let x = 0; x < image.width; x += 1) {
            const pixel = (y * image.width + x) * 4;
            const red = image.data[pixel] ?? 0;
            const green = image.data[pixel + 1] ?? 0;
            const blue = image.data[pixel + 2] ?? 0;
            if (timelineTop < 0 && red < 30 && green > 225 && blue > 225) {
              cyanPixels += 1;
              if (cyanPixels > 100) timelineTop = y;
            }
            if (anchorTop < 0 && red > 225 && green < 30 && blue > 225) {
              magentaPixels += 1;
              if (magentaPixels > 100) anchorTop = y;
            }
            if (timelineTop >= 0 && anchorTop >= 0) break;
          }
          if (timelineTop >= 0 && anchorTop >= 0) break;
        }

        return timelineTop >= 0 && anchorTop >= 0 ? anchorTop - timelineTop : null;
      };
      const baseline = measureFrame(await page.screenshot());
      expect(baseline).not.toBeNull();

      const samples: Array<number | null> = [];
      let imageProcessing = Promise.resolve();
      const handleScreencastFrame = (event: { data: string; sessionId: number }) => {
        void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {
          // A final frame can race Page.stopScreencast during test cleanup.
        });
        imageProcessing = imageProcessing.then(() => {
          samples.push(measureFrame(Buffer.from(event.data, 'base64')));
        });
      };
      session.on('Page.screencastFrame', handleScreencastFrame);
      await session.send('Page.startScreencast', {
        everyNthFrame: 1,
        format: 'png',
        maxHeight: 900,
        maxWidth: 1280,
      });
      screencastStarted = true;

      const paintProbe = await page.evaluateHandle(() => {
        const probe = document.createElement('div');
        probe.style.cssText =
          'position:fixed;left:0;top:0;width:50px;height:50px;z-index:2147483647;pointer-events:none';
        document.body.append(probe);
        let frame = 0;
        return setInterval(() => {
          probe.style.background = frame++ % 2 === 0 ? 'black' : 'white';
        }, 16);
      });
      try {
        await timeline
          .getByRole('button', { name: /load earlier messages/i })
          .dispatchEvent('click');
        await expect(mount.locator('[data-testid="stress-message-count"]')).toHaveText(
          'messages: 64',
        );
        await page.waitForTimeout(500);
        await session.send('Page.stopScreencast');
        screencastStarted = false;
        session.off('Page.screencastFrame', handleScreencastFrame);
        await imageProcessing;

        expect(samples.length).toBeGreaterThan(2);
        for (const sample of samples) {
          expect(sample).not.toBeNull();
          expect(Math.abs((sample ?? 0) - (baseline ?? 0))).toBeLessThanOrEqual(2);
        }
      } finally {
        await page.evaluate((interval) => clearInterval(interval), paintProbe);
        await paintProbe.dispose();
        await anchorMarkerObserver.evaluate((observer) => observer.disconnect());
        await anchorMarkerObserver.dispose();
        if (screencastStarted) {
          await session.send('Page.stopScreencast');
          screencastStarted = false;
        }
        session.off('Page.screencastFrame', handleScreencastFrame);
      }
    } finally {
      if (screencastStarted) await session.send('Page.stopScreencast');
      await context.close();
    }
  });

  test('adapter prepends at scrollTop=0 hold the anchor at every animation-frame checkpoint', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      baseURL: environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
      viewport: { width: 1280, height: 900 },
    });
    // `addInitScript`/`newPage` sat outside the try/finally below that
    // closes `context` -- a failure in either leaked the context, since
    // nothing else here would have closed it. Both now run inside the same
    // try that already closes `context` in its `finally`.
    try {
      await context.addInitScript(
        ([key, value]) => {
          localStorage.setItem(key, value);
        },
        [THEME_STORAGE_KEY, 'dark'] as const,
      );
      const page = await context.newPage();
      await page.goto(fixtureRoute('chat', { fixtureName: 'private-history-prepend-stress' }), {
        waitUntil: 'load',
      });
      await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
      const mount = page.locator(STRESS);
      await mount.waitFor({ state: 'visible', timeout: 20_000 });
      await mount.scrollIntoViewIfNeeded();
      const timeline = mount.locator('.chat-timeline');

      // Three pages: the first two swap the trigger idle → loading → idle,
      // the third also unmounts it (hasMore: false) after the restore.
      for (let load = 0; load < 3; load += 1) {
        await mount.locator('[data-testid="stress-scroll-bottom"]').click();
        await page.waitForTimeout(600);
        await mount.locator('[data-testid="stress-scroll-top"]').click();
        await expect.poll(async () => timeline.evaluate((element) => element.scrollTop)).toBe(0);
        await page.waitForTimeout(400);

        // Sample the anchor's viewport-relative offset on EVERY animation
        // frame. The restore must land in the same rendered frame as the
        // prepend — a single frame showing the anchor shifted is the visible
        // flash this test exists to prevent.
        const preloadBaseline = await timeline.evaluate((element) => {
          const w = window as unknown as {
            __anchorSamples?: number[];
            __anchorStop?: boolean;
          };
          w.__anchorSamples = [];
          w.__anchorStop = false;
          const measure = (): number | null => {
            const target = Array.from(element.querySelectorAll('.chat-message-body')).find(
              (candidate) => candidate.textContent?.trimStart().startsWith('Live message 5 —'),
            );
            if (!target) return null;
            return target.getBoundingClientRect().top - element.getBoundingClientRect().top;
          };
          // Seed the series SYNCHRONOUSLY. `evaluate` resolves the moment this
          // body returns, so the requestAnimationFrame below only SCHEDULES
          // the first sample — nothing forces a frame boundary before the
          // click dispatched two statements later, and the click routinely
          // wins. When it does, samples[0] is a POST-restore reading (the
          // stress example is non-virtualized and prepends synchronously
          // inside the dispatch, and the non-virtualized restore lands in the
          // same microtask flush), so a regression that anchors at a
          // wrong-but-stable offset just moves the baseline with it and every
          // comparison below passes vacuously.
          const initial = measure();
          if (initial !== null) w.__anchorSamples.push(initial);
          const sample = () => {
            if (w.__anchorStop) return;
            const offset = measure();
            if (offset !== null) w.__anchorSamples!.push(offset);
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          return initial;
        });
        // A missed lookup would silently slide the baseline to a later frame.
        expect(preloadBaseline).not.toBeNull();
        // And at least one genuinely PAINTED pre-prepend frame must be in the
        // series before the prepend is triggered.
        await expect
          .poll(async () =>
            page.evaluate(
              () =>
                (window as unknown as { __anchorSamples?: number[] }).__anchorSamples?.length ?? 0,
            ),
          )
          .toBeGreaterThan(1);

        // dispatchEvent rather than .click(): the trigger sits at the top of
        // the transcript and Playwright's click would scroll on its own.
        await timeline
          .getByRole('button', { name: /load earlier messages/i })
          .dispatchEvent('click');
        await expect(mount.locator('[data-testid="stress-message-count"]')).toHaveText(
          `messages: ${60 + (load + 1) * 4}`,
        );
        await page.waitForTimeout(500);

        const samples = await page.evaluate(() => {
          const w = window as unknown as {
            __anchorSamples?: number[];
            __anchorStop?: boolean;
          };
          w.__anchorStop = true;
          return w.__anchorSamples ?? [];
        });
        expect(samples.length).toBeGreaterThan(5);
        const baseline = samples[0]!;
        for (const sample of samples) {
          expect(Math.abs(sample - baseline)).toBeLessThanOrEqual(2);
        }
        expect(Math.abs(samples[samples.length - 1]! - baseline)).toBeLessThanOrEqual(1);
      }

      // The final page reported hasMore: false — the trigger is gone and the
      // anchored content stayed put through its unmount.
      await expect(timeline.getByRole('button', { name: /load earlier messages/i })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
