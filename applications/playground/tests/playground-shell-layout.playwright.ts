import { expect, test, type Page } from '@playwright/test';

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const overflowPages = ['button', 'chat', 'side-navigation', 'sidebar'] as const;

type Offsets = { left: number; top: number };

async function openDocumentation(page: Page, path: string, theme?: 'light' | 'dark') {
  await page.goto(theme === undefined ? path : `${path}?theme=${theme}`);
  await page.locator('[data-component-page] .dx-hero h1').waitFor();
}

async function canvasOffsets(page: Page): Promise<Offsets> {
  return page.evaluate(() => {
    const heading = document.querySelector('.dx-hero h1');
    if (heading === null) throw new Error('The documentation hero heading is missing.');
    const box = heading.getBoundingClientRect();
    const canvas = document.querySelector('.dx');
    if (canvas === null) throw new Error('The documentation canvas is missing.');
    const canvasBox = canvas.getBoundingClientRect();
    return { left: box.left - canvasBox.left, top: box.top - canvasBox.top };
  });
}

for (const viewport of viewports) {
  test.describe(`${viewport.width}px viewport`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const [label, path] of [
      ['home', '/'],
      ['Action Row', '/page/action-row'],
    ] as const) {
      test(`${label} has an unframed canvas with no body inset`, async ({ page }) => {
        await openDocumentation(page, path);

        const metrics = await page.evaluate(() => {
          const canvas = document.querySelector('.dx');
          if (canvas === null) throw new Error('The documentation canvas is missing.');
          const frame = getComputedStyle(canvas);
          const body = getComputedStyle(document.body);
          return {
            borders: [
              frame.borderTopWidth,
              frame.borderRightWidth,
              frame.borderBottomWidth,
              frame.borderLeftWidth,
            ],
            canvasInlinePadding: [frame.paddingLeft, frame.paddingRight],
            innerInlinePadding: (() => {
              const inner = document.querySelector('.dx__inner');
              if (inner === null) throw new Error('The gutter owner .dx__inner is missing.');
              const owner = getComputedStyle(inner);
              return [owner.paddingLeft, owner.paddingRight];
            })(),
            bodyPadding: [body.paddingTop, body.paddingRight, body.paddingBottom, body.paddingLeft],
          };
        });

        expect(metrics.borders).toEqual(['0px', '0px', '0px', '0px']);
        expect(metrics.bodyPadding).toEqual(['0px', '0px', '0px', '0px']);
        expect(metrics.canvasInlinePadding).toEqual(['0px', '0px']);
        for (const padding of metrics.innerInlinePadding) {
          expect(Number.parseFloat(padding)).toBeGreaterThan(0);
        }
      });
    }

    test('home and Action Row share the same outer canvas offsets', async ({ page }) => {
      await openDocumentation(page, '/');
      const home = await canvasOffsets(page);
      await openDocumentation(page, '/page/action-row');
      const component = await canvasOffsets(page);

      expect(component.left).toBe(home.left);
      // Vertical offsets differ only by hero content above the heading, so the
      // eyebrow, which opens both heroes, is the shared vertical reference.
      const eyebrowTop = async () =>
        page.evaluate(() => {
          const eyebrow = document.querySelector('.dx-eyebrow');
          const canvas = document.querySelector('.dx');
          if (eyebrow === null || canvas === null) throw new Error('The hero eyebrow is missing.');
          return eyebrow.getBoundingClientRect().top - canvas.getBoundingClientRect().top;
        });
      const componentTop = await eyebrowTop();
      await openDocumentation(page, '/');
      expect(componentTop).toBe(await eyebrowTop());
    });

    test('the Component facts region is absent', async ({ page }) => {
      await openDocumentation(page, '/page/action-row');

      await expect(page.getByLabel('Component facts')).toHaveCount(0);
      await expect(page.locator('.dx-spec')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'ActionRow' })).toBeVisible();
      await expect(page.locator('.dx-import')).toBeVisible();
      await expect(page.locator('.dx-eyebrow__index')).toHaveText('Actions');
    });

    for (const theme of ['light', 'dark'] as const) {
      test(`explicit ${theme} theme paints the expected canvas`, async ({ page }) => {
        await openDocumentation(page, '/page/action-row', theme);

        const background = await page.evaluate(() => {
          const canvas = document.querySelector('.dx');
          if (canvas === null) throw new Error('The documentation canvas is missing.');
          const context = document.createElement('canvas').getContext('2d');
          if (context === null) throw new Error('Canvas 2D is unavailable.');
          context.fillStyle = '#000';
          context.fillStyle = getComputedStyle(canvas).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
          return { red, green, blue };
        });
        const luminance = (background.red + background.green + background.blue) / 3;
        if (theme === 'dark') expect(luminance).toBeLessThan(90);
        else expect(luminance).toBeGreaterThan(240);
      });
    }
  });
}

test.describe('component pages at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const name of overflowPages) {
    test(`${name} has no horizontal overflow and no inset frame`, async ({ page }) => {
      await openDocumentation(page, `/page/${name}`);

      const geometry = await page.evaluate(() => {
        const canvas = document.querySelector('.dx');
        if (canvas === null) throw new Error('The documentation canvas is missing.');
        const frame = getComputedStyle(canvas);
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          borderLeft: frame.borderLeftWidth,
          canvasLeft: canvas.getBoundingClientRect().left,
          bodyPaddingLeft: getComputedStyle(document.body).paddingLeft,
        };
      });

      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.borderLeft).toBe('0px');
      expect(geometry.bodyPaddingLeft).toBe('0px');
      expect(geometry.canvasLeft).toBe(0);
    });
  }
});

test.describe('import control at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('keeps the full import statement reachable without widening the page', async ({ page }) => {
    await openDocumentation(page, '/page/action-row');

    const reachability = await page.evaluate(() => {
      const control = document.querySelector('.dx-import');
      const code = document.querySelector<HTMLElement>('.dx-import__code');
      if (control === null || code === null) throw new Error('The import control is missing.');
      const clippedBefore = code.scrollWidth > code.clientWidth;
      code.scrollLeft = code.scrollWidth;
      return {
        statement: code.textContent?.trim() ?? '',
        clippedBefore,
        scrolledToEnd: Math.ceil(code.scrollLeft + code.clientWidth) >= code.scrollWidth,
        controlRight: control.getBoundingClientRect().right,
        viewportWidth: document.documentElement.clientWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        overflowX: getComputedStyle(code).overflowX,
        tabIndex: code.tabIndex,
      };
    });

    expect(reachability.statement).toBe("import { ActionRow } from '@lostgradient/cinder';");
    // The statement is wider than the control, so it must scroll rather than clip.
    expect(reachability.clippedBefore).toBe(true);
    expect(reachability.overflowX).toBe('auto');
    expect(reachability.scrolledToEnd).toBe(true);
    expect(reachability.controlRight).toBeLessThanOrEqual(reachability.viewportWidth);
    expect(reachability.pageScrollWidth).toBeLessThanOrEqual(reachability.viewportWidth);

    // The scroll region is keyboard reachable and shows a focus indicator.
    expect(reachability.tabIndex).toBe(0);
    await page.locator('.dx-import__code').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.dx-import__code')).toBeFocused();
    const outlineWidth = await page
      .locator('.dx-import__code')
      .evaluate((element) => getComputedStyle(element).outlineWidth);
    expect(Number.parseFloat(outlineWidth)).toBeGreaterThan(0);
  });
});
