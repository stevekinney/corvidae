import { expect, type Frame, type Page } from '@playwright/test';

export type PreviewContext = {
  colorMode: 'light' | 'dark';
  motion: 'default' | 'reduced' | 'forced-reduced-motion';
};

export const PREVIEW_PATH = '/theme-builder/preview';

/** Console output that must not appear: errors and warnings are defects. */
export function trackConsoleProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/** The preview frame's document, once the frame has navigated to the preview route. */
export async function previewFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes(PREVIEW_PATH)))
    .toBe(true);
  return page.frames().find((frame) => frame.url().includes(PREVIEW_PATH))!;
}

/** Open the builder and wait until the preview frame acknowledged the latest revision. */
export async function openBuilder(page: Page, size?: { width: number; height: number }) {
  if (size !== undefined) await page.setViewportSize(size);
  await page.goto('/theme-builder');
  await expect(page.getByTestId('theme-workbench')).toBeVisible();
  // The first evaluation of the draft runs the whole validation once, which takes seconds.
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });
  await waitForPreviewApplied(page);
}

export async function waitForPreviewApplied(page: Page): Promise<void> {
  await expect(page.getByTestId('preview-revision')).not.toContainText('updating');
}

/** Wait for the frame's document to render the scene (the `main` stage is mounted). */
export async function waitForScene(frame: Frame): Promise<void> {
  await frame.waitForSelector('main.stage [data-example], main.stage .specimens');
}

export async function selectContext(page: Page, context: PreviewContext): Promise<void> {
  // Exact: editor fields are labeled with token names, such as "Motion slow value".
  await page.getByLabel('Color mode', { exact: true }).selectOption(context.colorMode);
  await page.getByLabel('Motion', { exact: true }).selectOption(context.motion);
}

/** A state the builder's own host would never send, posted from the builder window. */
export async function postToPreview(page: Page, message: Record<string, unknown>): Promise<void> {
  await page.evaluate((payload) => {
    const frame = document.querySelector('iframe');
    frame?.contentWindow?.postMessage(
      { protocol: 'cinder-theme-preview', version: 1, ...payload },
      window.location.origin,
    );
  }, message);
}

/** The `--cinder-*` properties set inline on the document root and body of `target`. */
export async function inlineVariables(target: Page | Frame): Promise<string[]> {
  return target.evaluate(() =>
    // A frame that is mid-navigation has no body yet.
    [document.documentElement, document.body]
      .filter((element) => element !== null)
      .flatMap((element) =>
        Array.from(element.style)
          .filter((name) => name.startsWith('--cinder-'))
          .map((name) => `${element.tagName.toLowerCase()} ${name}`),
      ),
  );
}

export type ChromeSnapshot = Record<string, Record<string, string>>;

const CHROME_PROPERTIES = [
  'font-size',
  'padding-top',
  'padding-left',
  'border-top-left-radius',
  'z-index',
  'transition-duration',
  'row-gap',
  'height',
];

/** Computed styles of the builder's own chrome, which theme values must never change. */
export async function chromeSnapshot(page: Page): Promise<ChromeSnapshot> {
  return page.evaluate((properties) => {
    const selectors: Record<string, string> = {
      heading: '#theme-builder-heading',
      toolbar: '[aria-label="Theme builder toolbar"]',
      railItem: 'nav[aria-label="Token categories"] button',
      filter: '#theme-builder-token-filter',
      colorMode: '#theme-builder-color-mode',
      previewHeading: '#preview-heading',
      editor: '[data-testid="editor-slot"]',
      root: 'html',
      body: 'body',
    };
    const snapshot: Record<string, Record<string, string>> = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`missing chrome element ${selector}`);
      const style = getComputedStyle(element);
      const values = Object.fromEntries(
        properties.map((property) => [property, style.getPropertyValue(property)]),
      );
      values['--cinder-text-base'] = style.getPropertyValue('--cinder-text-base');
      values['--cinder-space-4'] = style.getPropertyValue('--cinder-space-4');
      snapshot[name] = values;
    }
    return snapshot;
  }, CHROME_PROPERTIES);
}

/** True when the page cannot scroll sideways: the page-level horizontal overflow check. */
export async function hasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      document.body.scrollWidth <= document.documentElement.clientWidth,
  );
}
