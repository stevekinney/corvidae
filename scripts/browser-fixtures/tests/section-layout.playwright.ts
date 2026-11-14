import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

test.describe('Section layout', () => {
  test('a tall Section keeps every child inside a short flex scroll parent', async ({ page }) => {
    await page.goto(fixtureRoute('section'), { waitUntil: 'load' });
    const rows = page.locator('.section-row');
    await expect(rows).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      const box = await rows.nth(index).boundingBox();
      expect(box?.height, `row ${index} keeps its 48px height`).toBeGreaterThanOrEqual(47.5);
    }
    // The parent scrolls instead of squeezing the Section.
    const scroll = await page
      .locator('#section-scroll-parent')
      .evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
    expect(scroll.scroll).toBeGreaterThan(scroll.client);
    // Neither Section is shrunk below its content, so the second still has its full heading.
    const sections = page.locator('.cinder-section');
    const first = await sections.nth(0).boundingBox();
    expect(first?.height).toBeGreaterThanOrEqual(8 * 48);
  });

  test('a small more link in the actions is centred on the title’s line (COR-2329)', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('section'), { waitUntil: 'load' });
    const section = page.getByTestId('section-more-link');
    const [title, link] = await Promise.all([
      section.getByRole('heading', { name: 'Needs attention' }).boundingBox(),
      section.getByRole('link', { name: 'Open Health' }).boundingBox(),
    ]);
    const centre = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(centre(link!) - centre(title!))).toBeLessThanOrEqual(1);
  });

  test('the Section draws no box', async ({ page }) => {
    await page.goto(fixtureRoute('section'), { waitUntil: 'load' });
    const section = page.locator('.cinder-section').first();
    await expect(section).toHaveCSS('border-top-width', '0px');
    await expect(section).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });
});

test.describe('GroupedList layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
  });

  test('separators start at the text and the last row has none', async ({ page }) => {
    const first = page.locator('.cinder-grouped-list-item').first();
    await expect(first.locator('.cinder-grouped-list-item__content')).toHaveCSS(
      'border-bottom-style',
      'solid',
    );
    await expect(first).toHaveCSS('border-bottom-width', '0px');
    const last = page.locator('.cinder-grouped-list-item').last();
    await expect(last.locator('.cinder-grouped-list-item__content')).toHaveCSS(
      'border-bottom-color',
      'rgba(0, 0, 0, 0)',
    );
  });

  test('the action column is fixed, so a longer value never moves the click target', async ({
    page,
  }) => {
    const actions = page.locator('.cinder-grouped-list-item__action');
    const [one, two] = await Promise.all([
      actions.nth(0).boundingBox(),
      actions.nth(1).boundingBox(),
    ]);
    expect(one?.width).toBeCloseTo(44, 0);
    expect(two?.width).toBeCloseTo(44, 0);
    expect(one?.x).toBeCloseTo(two?.x ?? 0, 0);
  });

  test('the whole row is the link', async ({ page }) => {
    const row = page.locator('.cinder-grouped-list-item').first();
    const link = row.locator('.cinder-grouped-list-item__link');
    const [rowBox, overlay] = await Promise.all([
      row.boundingBox(),
      link.evaluate((element) => {
        const rectangle = getComputedStyle(element, '::after');
        return { position: rectangle.position, inset: rectangle.top };
      }),
    ]);
    expect(rowBox).not.toBeNull();
    expect(overlay.position).toBe('absolute');
    expect(overlay.inset).toBe('0px');
  });

  test('the grouped skeleton draws the grouped list surface, and its button block drops under the text on a phone (COR-2329)', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('skeleton'), { waitUntil: 'load' });
    const surface = page.getByTestId('skeleton-grouped').locator('.cinder-skeleton-grouped');
    await expect(surface).toHaveCSS('border-top-width', '0px');
    await expect(surface).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const rows = surface.locator('.cinder-skeleton-grouped-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.cinder-skeleton-grouped-content')).toHaveCSS(
      'border-bottom-style',
      'solid',
    );
    await page.setViewportSize({ width: 1024, height: 800 });
    const wide = await rows.first().locator('.cinder-skeleton-action-bar').boundingBox();
    expect(wide!.width).toBeCloseTo(84, 0);
    // A placeholder row is as tall as a real row with a title, a subtitle and an action, so nothing
    // moves when the rows arrive.
    const placeholderHeight = (await rows.first().boundingBox())!.height;
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    const real = page
      .getByTestId('grouped-list-actions')
      .locator('.cinder-grouped-list-item')
      .nth(1);
    expect(Math.abs((await real.boundingBox())!.height - placeholderHeight)).toBeLessThanOrEqual(1);
    await page.goto(fixtureRoute('skeleton'), { waitUntil: 'load' });
    await page.setViewportSize({ width: 375, height: 800 });
    const text = await rows.first().locator('.cinder-skeleton-grouped-text').boundingBox();
    const block = await rows.first().locator('.cinder-skeleton-action-bar').boundingBox();
    // Under the text, at the button's own 84px, from the text's leading edge, as the real one is.
    expect(block!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
    expect(block!.width).toBeCloseTo(84, 0);
    expect(Math.abs(block!.x - text!.x)).toBeLessThanOrEqual(1);
  });

  test('a slow load’s status line sits above the first placeholder, not under them (COR-2329)', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('skeleton'), { waitUntil: 'load' });
    // COR-2329 round two: the line takes the first row's place; a line inserted above moved the
    // rows when it appeared and again when the data arrived.
    const slow = page.getByTestId('skeleton-still-loading');
    const status = slow.locator('.cinder-skeleton-status');
    await expect(status).toContainText('Still loading reviews.');
    const rowTops = async (testId: string) => {
      const group = await page.getByTestId(testId).boundingBox();
      const rows = page.getByTestId(testId).locator('.cinder-skeleton-grouped-row');
      return Promise.all(
        [0, 1].map(async (index) => (await rows.nth(index).boundingBox())!.y - group!.y),
      );
    };
    // The rows sit where the same rows sit with no line.
    const [withLine, withoutLine] = await Promise.all([
      rowTops('skeleton-still-loading'),
      rowTops('skeleton-grouped'),
    ]);
    for (const index of [0, 1]) {
      expect(Math.abs(withLine[index]! - withoutLine[index]!)).toBeLessThanOrEqual(1);
    }
    // The line lies inside the first row, which shows no bars under it.
    const line = await status.boundingBox();
    const first = await slow.locator('.cinder-skeleton-grouped-row').first().boundingBox();
    expect(line!.y).toBeGreaterThanOrEqual(first!.y - 1);
    expect(line!.y + line!.height).toBeLessThanOrEqual(first!.y + first!.height + 1);
    await expect(
      slow.locator('.cinder-skeleton-grouped-row').first().locator('.cinder-skeleton').first(),
    ).toHaveCSS('visibility', 'hidden');
    // A page's own placeholder: the block that holds the line keeps the page where it was.
    const pageTops = async (testId: string) => {
      const group = await page.getByTestId(testId).boundingBox();
      return (
        (await page.getByTestId(testId).getByTestId('after-place').boundingBox())!.y - group!.y
      );
    };
    await expect(
      page.getByTestId('skeleton-page-slow').locator('.cinder-skeleton-status'),
    ).toContainText('Still loading Home.');
    await expect(
      page.getByTestId('skeleton-page-waiting').locator('.cinder-skeleton-status'),
    ).toHaveText('');
    expect(
      Math.abs((await pageTops('skeleton-page-slow')) - (await pageTops('skeleton-page-waiting'))),
    ).toBeLessThanOrEqual(1);
  });

  test('an empty row’s and a failed row’s actions end on the list buttons’ edge (COR-2329)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    const listButton = await page
      .getByTestId('grouped-list-actions')
      .getByRole('link', { name: 'Answer' })
      .boundingBox();
    const listEdge = listButton!.x + listButton!.width;
    const emptyAction = await page
      .getByTestId('grouped-list-empty-row')
      .getByRole('button', { name: 'Open Health' })
      .boundingBox();
    const retry = await page
      .getByTestId('grouped-list-error-row')
      .getByRole('button', { name: 'Try again' })
      .boundingBox();
    expect(Math.abs(emptyAction!.x + emptyAction!.width - listEdge)).toBeLessThanOrEqual(1);
    expect(Math.abs(retry!.x + retry!.width - listEdge)).toBeLessThanOrEqual(1);
  });

  test('a trailing value is one line on the title’s line, and on a phone the subtitle runs under both (COR-2329)', async ({
    page,
  }) => {
    const rows = page.getByTestId('grouped-list-trailing').locator('.cinder-grouped-list-item');
    const measure = async (index: number) => {
      const row = rows.nth(index);
      const [title, subtitle, trailing, chevron, content] = await Promise.all(
        [
          '.cinder-grouped-list-item__title',
          '.cinder-grouped-list-item__subtitle',
          '.cinder-grouped-list-item__trailing',
          '.cinder-grouped-list-item__chevron',
          '.cinder-grouped-list-item__content',
        ].map(async (selector) => (await row.locator(selector).boundingBox())!),
      );
      const titleLine = await row
        .locator('.cinder-grouped-list-item__title')
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
      return {
        title: title!,
        subtitle: subtitle!,
        trailing: trailing!,
        chevron: chevron!,
        content: content!,
        titleLine,
      };
    };
    for (const width of [1024, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const index of [0, 1]) {
        const { title, subtitle, trailing, chevron, content, titleLine } = await measure(index);
        const at = `row ${index} at ${width}`;
        // One line, never broken.
        expect(trailing.height, `${at}: the value is one line`).toBeLessThanOrEqual(titleLine + 1);
        // Centred on the title's first line, not on the row; the chevron too.
        const firstLine = title.y + titleLine / 2;
        expect(Math.abs(trailing.y + trailing.height / 2 - firstLine), at).toBeLessThanOrEqual(1);
        expect(Math.abs(chevron.y + chevron.height / 2 - firstLine), at).toBeLessThanOrEqual(1);
        if (width < 1024) {
          // The subtitle takes the full width under the title and the value.
          expect(subtitle.y, at).toBeGreaterThanOrEqual(trailing.y + trailing.height - 1);
          expect(subtitle.y, at).toBeGreaterThanOrEqual(title.y + title.height - 1);
          expect(Math.abs(subtitle.x - content.x), at).toBeLessThanOrEqual(1);
          expect(subtitle.width, at).toBeGreaterThan(content.width - 12);
        }
      }
    }
    // The fixture's longer value beside a lead column: the title never breaks letter by letter.
    await page.setViewportSize({ width: 320, height: 900 });
    const indexRebuild = page
      .locator('.cinder-grouped-list-item')
      .filter({ hasText: 'Index rebuild' });
    const title = await indexRebuild.locator('.cinder-grouped-list-item__title').boundingBox();
    expect(title!.width).toBeGreaterThanOrEqual(80);
    const value = await indexRebuild.locator('.cinder-grouped-list-item__trailing').boundingBox();
    const valueLine = await indexRebuild
      .locator('.cinder-grouped-list-item__title')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    expect(value!.height).toBeLessThanOrEqual(valueLine + 1);
    const titleLines = await indexRebuild
      .locator('.cinder-grouped-list-item__title')
      .evaluate((element) =>
        Math.round(
          element.getBoundingClientRect().height /
            Number.parseFloat(getComputedStyle(element).lineHeight),
        ),
      );
    expect(titleLines).toBe(1);
  });

  test('text actions trail their row on a wide screen (COR-2329)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    const rows = page.getByTestId('grouped-list-actions').locator('.cinder-grouped-list-item');
    const row = await rows.nth(0).boundingBox();
    const button = await rows.nth(0).getByRole('link', { name: 'Answer' }).boundingBox();
    expect(button!.x + button!.width).toBeGreaterThan(row!.x + row!.width - 40);
    expect(button!.width).toBeLessThan(row!.width / 3);
  });

  test('text actions drop under the text on a phone at their own width, from the title’s leading edge (COR-2329)', async ({
    page,
  }) => {
    const rows = page.getByTestId('grouped-list-actions').locator('.cinder-grouped-list-item');
    const actions = [
      [0, 'Answer'],
      [1, 'View run'],
    ] as const;
    // The natural width of each button is its width beside the text on a wide screen.
    await page.setViewportSize({ width: 1024, height: 800 });
    const natural = new Map<string, number>();
    for (const [index, name] of actions) {
      natural.set(name, (await rows.nth(index).getByRole('link', { name }).boundingBox())!.width);
    }
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [index, name] of actions) {
        const text = await rows.nth(index).locator('.cinder-grouped-list-item__text').boundingBox();
        const title = await rows
          .nth(index)
          .locator('.cinder-grouped-list-item__title')
          .boundingBox();
        const button = await rows.nth(index).getByRole('link', { name }).boundingBox();
        expect(button!.y, `${name} is under its text at ${width}`).toBeGreaterThanOrEqual(
          text!.y + text!.height - 1,
        );
        expect(
          Math.abs(button!.width - natural.get(name)!),
          `${name} keeps its natural width at ${width}`,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(button!.x - title!.x),
          `${name} starts at the title's leading edge at ${width}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});
