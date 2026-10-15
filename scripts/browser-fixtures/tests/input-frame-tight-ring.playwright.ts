/// <reference lib="dom" />
/**
 * COR-1498: the tight focus ring on input frames, proven in rendered pixels.
 *
 * On focus the frame's 1px border turns transparent and the ring sits
 * directly outside it with no offset band. A transparent border paints the
 * element's own background, so reading outward from the content edge:
 *
 *   - the 1px border band composites to the control's own fill, and
 *   - the 2px band outside it composites to the ring colour.
 *
 * The ring stays exactly 2px: nothing ring-coloured is stacked inside it
 * (the problem COR-1072 was cancelled over). The expected ring colour is
 * `--cinder-ring-color` in the default and read-only states and
 * `--cinder-status-danger-solid` when invalid, as `_input-frame.css` and
 * `input-frame-danger-ring.playwright.ts` define.
 *
 * None of Input, Select or NumberInput styles a read-only state; each passes
 * `readonly` through to its native control, so the read-only case sets that
 * attribute on the rendered control, exactly as a consumer prop would.
 *
 * The same border-under-ring rule covers the other bordered controls with an
 * outer ring (Textarea, TagInput, Combobox, PinInput, the MultiSelect trigger
 * and SearchField). Their fixtures render the default state only, so their
 * invalid cases set the attribute each component renders when invalid. Each
 * keeps the ring colour its own CSS assigns to the invalid state: a danger
 * ring where the control defines one, the standard ring where it does not.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { readPixelRegion, type PositionedRgb, type Rgb } from './pixel-probe.ts';
import { THEMES, focusByKeyboard, openThemedFixture } from './quiet-focus-rings-support.ts';

const CHANNEL_TOLERANCE = 2;
const DEVICE_PIXEL = 0.5;

type FrameState = 'default' | 'invalid' | 'read-only';

type FrameCase = {
  control: string;
  state: FrameState;
  slug: string;
  fixtureName?: string;
  /** The keyboard focus target. */
  focusTarget: (page: Page) => Locator;
  /** The element that owns the border and paints the ring. */
  frame: (page: Page) => Locator;
  /** Runs after focus lands. */
  afterFocus?: (page: Page, focusTarget: Locator) => Promise<void>;
  prepare?: (focusTarget: Locator, page: Page) => Promise<void>;
  /** Overrides the ring token implied by `state`. */
  ringToken?: string;
};

function setAttribute(locate: (page: Page) => Locator, name: string, value: string) {
  return async (_focusTarget: Locator, page: Page): Promise<void> => {
    await locate(page).evaluate(
      (element, [attribute, attributeValue]) => element.setAttribute(attribute, attributeValue),
      [name, value] as const,
    );
  };
}

async function makeReadOnly(focusTarget: Locator): Promise<void> {
  await focusTarget.evaluate((element) => element.setAttribute('readonly', ''));
}

const inputControl = (page: Page) => page.locator('input.cinder-input').first();
const schemaSelect = (page: Page) => page.locator('select.cinder-select').first();
const numberInput = (page: Page) => page.locator('#number-input');
const numberFrame = (page: Page) => page.locator('.cinder-input-group.cinder-number-input');

function otherBorderedCases(): FrameCase[] {
  const textarea = (page: Page) => page.locator('textarea.cinder-textarea').first();
  const tagInput = (page: Page) => page.locator('.cinder-tag-input__input').first();
  const tagControl = (page: Page) => page.locator('.cinder-tag-input__control').first();
  const combobox = (page: Page) => page.locator('.cinder-combobox__input').first();
  const pinSegment = (page: Page) => page.locator('.cinder-pin-input__segment').first();
  const multiSelect = (page: Page) => page.locator('.cinder-multi-select__trigger').first();
  const search = (page: Page) => page.locator('.cinder-search-field__input').first();
  const searchGroup = (page: Page) =>
    page.locator('.cinder-search-field .cinder-input-group').first();
  return [
    {
      control: 'Textarea',
      state: 'default',
      slug: 'textarea',
      focusTarget: textarea,
      frame: textarea,
    },
    {
      control: 'Textarea',
      state: 'invalid',
      slug: 'textarea',
      focusTarget: textarea,
      frame: textarea,
      prepare: setAttribute(textarea, 'aria-invalid', 'true'),
    },
    {
      control: 'TagInput',
      state: 'default',
      slug: 'tag-input',
      focusTarget: tagInput,
      frame: tagControl,
    },
    {
      control: 'TagInput',
      state: 'invalid',
      slug: 'tag-input',
      focusTarget: tagInput,
      frame: tagControl,
      prepare: setAttribute(
        (page) => page.locator('.cinder-tag-input').first(),
        'data-invalid',
        '',
      ),
    },
    {
      control: 'Combobox',
      state: 'default',
      slug: 'combobox',
      focusTarget: combobox,
      frame: combobox,
    },
    {
      control: 'Combobox',
      state: 'invalid',
      slug: 'combobox',
      focusTarget: combobox,
      frame: combobox,
      prepare: setAttribute(combobox, 'aria-invalid', 'true'),
      // Combobox has no danger focus ring of its own; only its border signals invalid.
      ringToken: '--cinder-ring-color',
    },
    {
      control: 'PinInput segment',
      state: 'default',
      slug: 'pin-input',
      focusTarget: pinSegment,
      frame: pinSegment,
    },
    {
      control: 'PinInput segment',
      state: 'invalid',
      slug: 'pin-input',
      focusTarget: pinSegment,
      frame: pinSegment,
      prepare: setAttribute(
        (page) => page.locator('.cinder-pin-input').first(),
        'aria-invalid',
        'true',
      ),
      // PinInput has no danger focus ring of its own; only its border signals invalid.
      ringToken: '--cinder-ring-color',
    },
    {
      control: 'MultiSelect trigger',
      state: 'default',
      slug: 'multi-select',
      focusTarget: multiSelect,
      frame: multiSelect,
    },
    {
      control: 'MultiSelect trigger',
      state: 'invalid',
      slug: 'multi-select',
      focusTarget: multiSelect,
      frame: multiSelect,
      prepare: setAttribute(multiSelect, 'aria-invalid', 'true'),
    },
    {
      control: 'SearchField',
      state: 'default',
      slug: 'search-field',
      focusTarget: search,
      frame: searchGroup,
    },
  ];
}

const CASES: readonly FrameCase[] = [
  {
    control: 'Input',
    state: 'default',
    slug: 'input',
    fixtureName: 'empty',
    focusTarget: inputControl,
    frame: inputControl,
  },
  {
    control: 'Input',
    state: 'invalid',
    slug: 'input',
    fixtureName: 'invalid',
    focusTarget: inputControl,
    frame: inputControl,
  },
  {
    control: 'Input',
    state: 'read-only',
    slug: 'input',
    fixtureName: 'empty',
    focusTarget: inputControl,
    frame: inputControl,
    prepare: makeReadOnly,
  },
  {
    control: 'Select trigger',
    state: 'default',
    slug: 'schema-form',
    focusTarget: schemaSelect,
    frame: schemaSelect,
  },
  {
    control: 'Select trigger',
    state: 'invalid',
    slug: 'select',
    focusTarget: (page) => page.locator('#invalid-select'),
    frame: (page) => page.locator('#invalid-select'),
  },
  {
    control: 'Select trigger',
    state: 'read-only',
    slug: 'schema-form',
    focusTarget: schemaSelect,
    frame: schemaSelect,
    prepare: makeReadOnly,
  },
  {
    control: 'NumberInput',
    state: 'default',
    slug: 'number-input',
    focusTarget: numberInput,
    frame: numberFrame,
  },
  {
    control: 'NumberInput',
    state: 'invalid',
    slug: 'number-input',
    focusTarget: numberInput,
    frame: numberFrame,
    // A non-numeric entry committed with Enter is NumberInput's own invalid
    // state (a malformed value); focus stays on the field.
    afterFocus: async (page, focusTarget) => {
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('abc');
      await page.keyboard.press('Enter');
      await expect(focusTarget).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('.cinder-input-group--invalid')).toHaveCount(1);
      await expect(focusTarget).toBeFocused();
    },
  },
  {
    control: 'NumberInput',
    state: 'read-only',
    slug: 'number-input',
    focusTarget: numberInput,
    frame: numberFrame,
    prepare: makeReadOnly,
  },
  ...otherBorderedCases(),
];

type FrameReading = {
  left: number;
  top: number;
  height: number;
  borderWidth: number;
  ringWidth: number;
  fill: Rgb;
  ring: Rgb;
};

/** Resolve the frame geometry and the expected colours as sRGB bytes via a canvas. */
async function readFrame(frame: Locator, ringToken: string): Promise<FrameReading> {
  return frame.evaluate((element, token) => {
    const toRgb = (css: string): { r: number; g: number; b: number } => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas context unavailable.');
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const [r = -1, g = -1, b = -1] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    };
    const styles = getComputedStyle(element);
    const tokenValue = styles.getPropertyValue(token).trim();
    if (tokenValue === '') throw new Error(`Token ${token} is unset on the frame.`);
    // Resolve light-dark() under the frame's color-scheme, with transitions off
    // so computed style reports the final colour.
    const probe = document.createElement('span');
    probe.style.setProperty('transition', 'none', 'important');
    probe.style.setProperty('color', tokenValue, 'important');
    (element.parentElement ?? document.body).append(probe);
    const ringColor = getComputedStyle(probe).color;
    probe.remove();
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      height: rect.height,
      borderWidth: Number.parseFloat(styles.borderLeftWidth),
      ringWidth: Number.parseFloat(styles.getPropertyValue('--cinder-ring-width')),
      fill: toRgb(styles.backgroundColor),
      ring: toRgb(ringColor),
    };
  }, ringToken);
}

function channelDistance(pixel: Rgb, expected: Rgb): number {
  return Math.max(
    Math.abs(pixel.r - expected.r),
    Math.abs(pixel.g - expected.g),
    Math.abs(pixel.b - expected.b),
  );
}

/** Device pixels whose whole footprint lies inside [from, to) on the x axis. */
function pixelsWithin(pixels: readonly PositionedRgb[], from: number, to: number): PositionedRgb[] {
  return pixels.filter((pixel) => pixel.x >= from && pixel.x + DEVICE_PIXEL <= to);
}

for (const theme of THEMES) {
  test.describe(`COR-1498 input frame tight ring pixels (${theme})`, () => {
    for (const frameCase of CASES) {
      test(`${frameCase.control} (${frameCase.state}): border band is the fill, the 2px band outside is the ring`, async ({
        browser,
      }) => {
        const fixtureOptions =
          frameCase.fixtureName === undefined ? {} : { fixtureName: frameCase.fixtureName };
        const { page, dispose } = await openThemedFixture(
          browser,
          theme,
          frameCase.slug,
          fixtureOptions,
        );
        try {
          const focusTarget = frameCase.focusTarget(page);
          const frame = frameCase.frame(page);
          await expect(focusTarget).toBeVisible();
          await frameCase.prepare?.(focusTarget, page);
          await focusByKeyboard(page, focusTarget, `${frameCase.control} (${frameCase.state})`);
          await frameCase.afterFocus?.(page, focusTarget);
          // Park a text caret at the end so it never sits in the sampled column.
          // Set the selection directly: an End key press would change a
          // <select>'s value or move PinInput's focus to its last segment.
          await focusTarget.evaluate((element) => {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              const end = element.value.length;
              try {
                element.setSelectionRange(end, end);
              } catch {
                // Input types without a text selection (none here) keep their caret.
              }
            }
          });
          await expect(focusTarget).toBeFocused();
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
          );
          // Frames transition border-color and box-shadow on focus; sample the
          // settled paint, not a mid-transition frame.
          await frame.evaluate(async (element) => {
            await Promise.all(element.getAnimations().map((animation) => animation.finished));
          });

          const ringToken =
            frameCase.ringToken ??
            (frameCase.state === 'invalid'
              ? '--cinder-status-danger-solid'
              : '--cinder-ring-color');
          const reading = await readFrame(frame, ringToken);
          expect(reading.borderWidth, 'frames keep a 1px border').toBe(1);
          expect(reading.ringWidth, 'the ring is 2px').toBe(2);

          const middle = reading.top + reading.height / 2;
          const region = await readPixelRegion(
            page,
            { x: reading.left - 4, y: middle - 1, width: 8, height: 2 },
            0,
          );
          const row = region.filter((pixel) => Math.abs(pixel.y - middle) <= 1);

          const borderBand = pixelsWithin(row, reading.left, reading.left + reading.borderWidth);
          const ringBand = pixelsWithin(row, reading.left - reading.ringWidth, reading.left);
          expect(borderBand.length, 'border band has whole device pixels').toBeGreaterThan(0);
          expect(ringBand.length, 'ring band has whole device pixels').toBeGreaterThan(0);

          for (const pixel of borderBand) {
            expect(
              channelDistance(pixel, reading.fill),
              `border band pixel at x=${pixel.x} ${JSON.stringify(pixel)} vs fill ${JSON.stringify(reading.fill)}`,
            ).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
          }
          for (const pixel of ringBand) {
            expect(
              channelDistance(pixel, reading.ring),
              `ring band pixel at x=${pixel.x} ${JSON.stringify(pixel)} vs ring ${JSON.stringify(reading.ring)}`,
            ).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
          }
        } finally {
          await dispose();
        }
      });
    }
  });
}
