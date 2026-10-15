/// <reference lib="dom" />
/**
 * COR-1498: quiet focus rings.
 *
 * 1. The default ring is tight: one 2px band of `--cinder-ring-color` sitting
 *    directly on the control edge, with no `--cinder-ring-offset-color` halo.
 * 2. A focused control whose own background is a solid accent, danger or
 *    status fill paints a `--cinder-ring-offset-color` gap and then the
 *    standard ring, because an accent ring directly against a same-hue fill
 *    reads as the control growing. The same control unfilled (unchecked, off,
 *    aria-disabled) keeps the tight ring. FloatingAction primary predates this
 *    and keeps its own tight `--cinder-ring-on-accent` ring.
 * 3. The command palette's search field paints no ring at all; under
 *    `forced-colors: active` it keeps a visible `Highlight` outline.
 *
 * A few filled states are not rendered by any fixture (pressed accent and
 * danger chips, calendar range ends, pressed and current segments). Those
 * cases take a real rendered control and set the exact attributes its
 * component renders for that state, so the CSS contract is still exercised by
 * the real cascade.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  THEMES,
  expectRing,
  focusByKeyboard,
  openThemedFixture,
  outerBands,
  parseBoxShadow,
  readRing,
  type RingExpectation,
} from './quiet-focus-rings-support.ts';

type RingCase = {
  label: string;
  slug: string;
  fixtureName?: string;
  expected: RingExpectation;
  target: (page: Page) => Locator;
  /** Runs before the keyboard walk (state setup). */
  prepare?: (page: Page, target: Locator) => Promise<void>;
  /** Start the keyboard walk from this element instead of `document.body`. */
  walkFrom?: (page: Page) => Locator;
  /** Runs after focus lands (keyboard state changes such as Space). */
  afterFocus?: (page: Page) => Promise<void>;
};

async function setAttributes(
  target: Locator,
  set: Record<string, string>,
  remove: readonly string[] = [],
): Promise<void> {
  await target.evaluate(
    (element, { setAttributes, removeAttributes }) => {
      for (const name of removeAttributes) element.removeAttribute(name);
      for (const [name, value] of Object.entries(setAttributes)) element.setAttribute(name, value);
    },
    { setAttributes: set, removeAttributes: [...remove] },
  );
}

const TIGHT_DEFAULT_CASES: readonly RingCase[] = [
  {
    label: 'secondary Button',
    slug: 'button',
    expected: 'tight',
    target: (page) => page.locator('button.cinder-button[data-cinder-variant="secondary"]').first(),
  },
  {
    label: 'Input',
    slug: 'input',
    fixtureName: 'empty',
    expected: 'tight',
    target: (page) => page.locator('input.cinder-input').first(),
  },
  {
    label: 'Select trigger',
    slug: 'schema-form',
    expected: 'tight',
    target: (page) => page.locator('select.cinder-select').first(),
  },
  {
    label: 'unchecked Checkbox',
    slug: 'checkbox',
    expected: 'tight',
    target: (page) => page.locator('#terms'),
  },
];

const FILLED_CASES: readonly RingCase[] = [
  {
    label: 'primary Button',
    slug: 'button',
    fixtureName: 'primary',
    expected: 'gap',
    target: (page) => page.locator('.cinder-button[data-cinder-variant="primary"]'),
  },
  {
    label: 'danger Button',
    slug: 'button',
    fixtureName: 'danger',
    expected: 'gap',
    target: (page) => page.locator('.cinder-button[data-cinder-variant="danger"]'),
  },
  {
    label: 'checked Checkbox',
    slug: 'checkbox',
    expected: 'gap',
    target: (page) => page.locator('#newsletter'),
  },
  {
    label: 'checked Radio',
    slug: 'radio-group',
    expected: 'gap',
    target: (page) => page.locator('input.cinder-radio:checked').first(),
  },
  {
    label: 'on Switch',
    slug: 'toggle',
    expected: 'gap',
    target: (page) => page.locator('button.cinder-toggle'),
    afterFocus: async (page) => {
      await page.keyboard.press('Space');
      await expect(page.locator('button.cinder-toggle')).toHaveAttribute('aria-checked', 'true');
    },
  },
  {
    label: 'selected SegmentedControl option',
    slug: 'segmented-control',
    expected: 'gap',
    target: (page) =>
      page.locator('.cinder-segmented-control-option[data-cinder-selected]').first(),
  },
  {
    label: 'pressed SegmentedControl option (multiple mode)',
    slug: 'segmented-control',
    expected: 'gap',
    target: (page) => page.locator('.cinder-segmented-control-option[tabindex="0"]').first(),
    prepare: (_page, target) =>
      setAttributes(target, { 'data-cinder-pressed': '' }, ['data-cinder-selected']),
  },
  {
    label: 'current SegmentedControl option (navigation)',
    slug: 'segmented-control',
    expected: 'gap',
    target: (page) => page.locator('.cinder-segmented-control-option[tabindex="0"]').first(),
    prepare: (_page, target) =>
      setAttributes(target, { 'data-cinder-current': '' }, ['data-cinder-selected']),
  },
  {
    label: 'pressed accent Chip',
    slug: 'chip',
    expected: 'gap',
    target: (page) => page.locator('button.cinder-chip[data-cinder-mode="toggle"]').first(),
    prepare: (_page, target) =>
      setAttributes(target, { 'aria-pressed': 'true', 'data-cinder-variant': 'accent' }, [
        'disabled',
      ]),
  },
  {
    label: 'pressed danger Chip',
    slug: 'chip',
    expected: 'gap',
    target: (page) => page.locator('button.cinder-chip[data-cinder-mode="toggle"]').first(),
    prepare: (_page, target) =>
      setAttributes(target, { 'aria-pressed': 'true', 'data-cinder-variant': 'danger' }, [
        'disabled',
      ]),
  },
  {
    label: 'pressed success Chip',
    slug: 'chip',
    expected: 'gap',
    target: (page) => page.locator('button.cinder-chip[data-cinder-mode="toggle"]').first(),
    prepare: (_page, target) =>
      setAttributes(target, { 'aria-pressed': 'true', 'data-cinder-variant': 'success' }, [
        'disabled',
      ]),
  },
  {
    label: 'pressed warning Chip',
    slug: 'chip',
    expected: 'gap',
    target: (page) => page.locator('button.cinder-chip[data-cinder-mode="toggle"]').first(),
    prepare: (_page, target) =>
      setAttributes(target, { 'aria-pressed': 'true', 'data-cinder-variant': 'warning' }, [
        'disabled',
      ]),
  },
  {
    label: 'pressed info Chip',
    slug: 'chip',
    expected: 'gap',
    target: (page) => page.locator('button.cinder-chip[data-cinder-mode="toggle"]').first(),
    prepare: (_page, target) =>
      setAttributes(target, { 'aria-pressed': 'true', 'data-cinder-variant': 'info' }, [
        'disabled',
      ]),
  },
  {
    label: 'current Pagination page',
    slug: 'pagination',
    expected: 'gap',
    target: (page) => page.locator('.cinder-pagination__page[data-cinder-current]'),
  },
  {
    label: 'Calendar range-start day',
    slug: 'calendar',
    expected: 'gap',
    target: (page) => page.locator('.cinder-calendar__day[tabindex="0"]'),
    prepare: (_page, target) => setAttributes(target, { 'data-range-start': '' }),
  },
  {
    label: 'Calendar range-end day',
    slug: 'calendar',
    expected: 'gap',
    target: (page) => page.locator('.cinder-calendar__day[tabindex="0"]'),
    prepare: (_page, target) => setAttributes(target, { 'data-range-end': '' }),
  },
  {
    label: 'SelectionPopover add-comment button',
    slug: 'selection-popover',
    expected: 'gap',
    target: (page) => page.locator('#toggled-selection-popover .cinder-selection-popover__button'),
    prepare: async (page, target) => {
      await page.getByRole('button', { name: 'Open popover' }).click();
      await expect(target).toBeVisible();
    },
  },
  {
    label: 'SchemaForm submit',
    slug: 'schema-form',
    expected: 'gap',
    target: (page) => page.locator('.cinder-schema-form__submit'),
  },
  {
    label: 'FileUpload browse button',
    slug: 'file-upload',
    expected: 'gap',
    target: (page) => page.locator('.cinder-file-upload__button'),
  },
  {
    label: 'primary FloatingAction (pre-existing on-accent ring, unchanged)',
    slug: 'floating-action',
    expected: 'on-accent',
    target: (page) => page.locator('.cinder-floating-action[data-cinder-variant="primary"]'),
  },
  {
    label: 'enabled Chat send button',
    slug: 'chat',
    expected: 'gap',
    target: (page) => page.locator('.chat-input-send').first(),
    prepare: async (page) => {
      await page.locator('.chat-input textarea').first().fill('Hello');
      await expect(page.locator('.chat-input-send').first()).toBeEnabled();
    },
    walkFrom: (page) => page.locator('.chat-input textarea').first(),
  },
];

const UNFILLED_CASES: readonly RingCase[] = [
  {
    label: 'off Switch',
    slug: 'toggle',
    expected: 'tight',
    target: (page) => page.locator('button.cinder-toggle'),
  },
  {
    label: 'unchecked Radio',
    slug: 'radio-group',
    expected: 'tight',
    target: (page) => page.locator('input.cinder-radio').first(),
    prepare: async (page) => {
      await page.evaluate(() => {
        for (const radio of document.querySelectorAll<HTMLInputElement>('input.cinder-radio')) {
          radio.checked = false;
        }
      });
    },
  },
  {
    label: 'aria-disabled primary Button (inset fill, still focusable)',
    slug: 'button',
    fixtureName: 'primary',
    expected: 'tight',
    target: (page) => page.locator('.cinder-button[data-cinder-variant="primary"]'),
    prepare: (_page, target) => setAttributes(target, { 'aria-disabled': 'true' }),
  },
];

async function measureCase(page: Page, ringCase: RingCase): Promise<void> {
  const target = ringCase.target(page);
  await ringCase.prepare?.(page, target);
  await expect(target, `${ringCase.label} is rendered`).toBeVisible();
  if (ringCase.walkFrom === undefined) {
    await focusByKeyboard(page, target, ringCase.label);
  } else {
    await ringCase.walkFrom(page).focus();
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
    expect(await target.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  }
  await ringCase.afterFocus?.(page);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expectRing(await readRing(target), ringCase.expected, ringCase.label);
}

for (const theme of THEMES) {
  test.describe(`COR-1498 quiet focus rings (${theme})`, () => {
    const groups = [
      ['tight default ring', TIGHT_DEFAULT_CASES],
      ['filled control has a gap before the ring', FILLED_CASES],
      ['unfilled control keeps the default ring', UNFILLED_CASES],
    ] as const;
    for (const [group, cases] of groups) {
      for (const ringCase of cases) {
        test(`${group}: ${ringCase.label}`, async ({ browser }) => {
          const fixtureOptions =
            ringCase.fixtureName === undefined ? {} : { fixtureName: ringCase.fixtureName };
          const { page, dispose } = await openThemedFixture(
            browser,
            theme,
            ringCase.slug,
            fixtureOptions,
          );
          try {
            await measureCase(page, ringCase);
          } finally {
            await dispose();
          }
        });
      }
    }

    test('command palette search field paints no ring', async ({ browser }) => {
      const { page, dispose } = await openThemedFixture(browser, theme, 'command-palette');
      try {
        const input = await openPaletteByKeyboard(page);
        const boxShadow = await input.evaluate((element) => getComputedStyle(element).boxShadow);
        expect(
          outerBands(parseBoxShadow(boxShadow)),
          `palette input box-shadow: ${boxShadow}`,
        ).toEqual([]);
      } finally {
        await dispose();
      }
    });

    test('command palette search field keeps a Highlight outline in forced colors', async ({
      browser,
    }) => {
      const { page, dispose } = await openThemedFixture(browser, theme, 'command-palette', {
        forcedColors: 'active',
      });
      try {
        const input = await openPaletteByKeyboard(page);
        const outline = await input.evaluate((element) => {
          const styles = getComputedStyle(element);
          const probe = document.createElement('span');
          probe.style.color = 'Highlight';
          document.body.append(probe);
          try {
            return {
              style: styles.outlineStyle,
              width: Number.parseFloat(styles.outlineWidth),
              color: styles.outlineColor,
              highlight: getComputedStyle(probe).color,
              ringWidth: Number.parseFloat(styles.getPropertyValue('--cinder-ring-width')),
            };
          } finally {
            probe.remove();
          }
        });
        expect(outline.style).toBe('solid');
        expect(outline.width).toBe(outline.ringWidth);
        expect(outline.color).toBe(outline.highlight);
      } finally {
        await dispose();
      }
    });
  });
}

async function openPaletteByKeyboard(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'Open palette' });
  await focusByKeyboard(page, trigger, 'command palette trigger');
  await page.keyboard.press('Enter');
  const input = page.locator('.cinder-command-palette__input');
  await expect(input).toBeFocused();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(
    await input.evaluate((element) => element.matches(':focus-visible')),
    'palette input is keyboard-focused',
  ).toBe(true);
  return input;
}
