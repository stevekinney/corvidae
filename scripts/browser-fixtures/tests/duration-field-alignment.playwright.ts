import { loadManifest, type Viewport } from '@lostgradient/testing';
import {
  expect,
  test,
  type ComponentPageFixture,
} from '@lostgradient/testing/playwright/component-page-fixture';

const entry = loadManifest().find((candidate) => candidate.slug === 'duration-field');
if (entry === undefined) throw new Error('Component manifest is missing slug: duration-field');
const fixture = entry.fixtures?.find((candidate) => candidate.name === 'alignment');

/**
 * Where a row is measured: as the fixture draws it, 3px over what its pair needs, 1px under it, or
 * at a width in pixels.
 */
type Place = 'as-drawn' | 'just-fits' | 'just-short' | number;

/** One row's pair, read in the page in one pass so every box is from the same layout. */
function readPair({ id, place }: { id: string; place: Place }) {
  const row = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const pair = row?.querySelector<HTMLElement>('.cinder-duration-field');
  const frame = row?.querySelector<HTMLElement>('.cinder-number-input-field');
  const group = row?.querySelector<HTMLElement>('.cinder-number-input');
  const input = row?.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
  const unit = row?.querySelector<HTMLSelectElement>('select');
  if (!row || !pair || !frame || !group || !input || !unit) {
    throw new Error(`The ${id} row draws no number and unit pair.`);
  }
  const steppers = Array.from(row.querySelectorAll<HTMLElement>('.cinder-number-input__stepper'));
  const style = getComputedStyle(input);
  // Text is measured in the input's own font. `getComputedStyle(input).font` is an empty string
  // here, so a canvas would measure in its 10px default.
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  for (const property of [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-stretch',
    'font-variant',
    'font-feature-settings',
    'font-kerning',
    'letter-spacing',
    'word-spacing',
    'text-transform',
  ]) {
    probe.style.setProperty(property, style.getPropertyValue(property));
  }
  document.body.append(probe);
  const widthOf = (text: string) => {
    probe.textContent = text;
    return probe.getBoundingClientRect().width;
  };
  let digits = 0;
  for (let number = 0; number < 100; number += 1) {
    digits = Math.max(digits, widthOf(String(number).padStart(2, '0')));
  }
  const placeholder = widthOf(input.placeholder);
  const shown = widthOf(input.value === '' ? input.placeholder : input.value);
  probe.remove();
  const pixels = (value: string) => Number.parseFloat(value);
  const groupStyle = getComputedStyle(group);
  // What the number's frame is besides its text: the steppers, the borders and the slot's padding.
  const chrome =
    steppers.reduce((sum, stepper) => sum + stepper.getBoundingClientRect().width, 0) +
    pixels(groupStyle.borderLeftWidth) +
    pixels(groupStyle.borderRightWidth) +
    pixels(style.paddingLeft) +
    pixels(style.paddingRight);
  const gap = pixels(getComputedStyle(pair).columnGap);
  const drawn = row.style.inlineSize;
  // The fixture page carries a global `transition: all 1e-05s`, so a width set here starts a
  // transition and a measure in the same pass reads the old width. The row is measured with no
  // transition and given its own back afterwards.
  const transition = row.style.transition;
  row.style.transition = 'none';
  // The unit's own width is its longest option, read where nothing squeezes it.
  row.style.inlineSize = '40rem';
  const minimum = chrome + Math.max(digits, placeholder) + gap + unit.getBoundingClientRect().width;
  const requested =
    place === 'as-drawn'
      ? undefined
      : place === 'just-fits'
        ? Math.ceil(minimum) + 3
        : place === 'just-short'
          ? Math.floor(minimum) - 1
          : place;
  row.style.inlineSize = requested === undefined ? drawn : `${requested}px`;
  const rowBox = row.getBoundingClientRect();
  // A width that did not take would leave every reading below true of the wrong row.
  if (requested !== undefined && Math.abs(rowBox.width - requested) > 0.5) {
    throw new Error(`The ${id} row was set to ${requested}px and measures ${rowBox.width}px.`);
  }
  const numberBox = frame.getBoundingClientRect();
  const unitBox = unit.getBoundingClientRect();
  const lastStepper = steppers[steppers.length - 1]?.getBoundingClientRect();
  const reading = {
    row: rowBox.width,
    /** The least row that holds the pair on one line: the frame, the text, the gap and the unit. */
    minimum,
    digits,
    placeholder,
    shown,
    slot:
      input.getBoundingClientRect().width - pixels(style.paddingLeft) - pixels(style.paddingRight),
    number: numberBox.width,
    wrapped: unitBox.top >= numberBox.bottom - 0.5,
    unitAtLeadingEdge: Math.abs(unitBox.left - numberBox.left) <= 0.5,
    unitAfterNumber: unitBox.left >= numberBox.right,
    pastRowEnd: Math.max(unitBox.right, numberBox.right, lastStepper?.right ?? 0) - rowBox.right,
  };
  row.style.inlineSize = drawn;
  row.style.transition = transition;
  return reading;
}

const openAlignment = async (
  componentPage: ComponentPageFixture,
  viewport: Viewport,
  hasTouch: boolean,
) => {
  const page = await componentPage.open({
    entry,
    theme: 'light',
    viewport,
    hasTouch,
    fixtureName: 'alignment',
    ...(fixture === undefined ? {} : { fixtureContentHash: fixture.fixtureContentHash }),
  });
  return (id: string, place: Place = 'as-drawn') => page.evaluate(readPair, { id, place });
};

for (const { name, viewport, hasTouch } of [
  { name: 'desktop', viewport: { name: 'desktop', width: 1280, height: 900 }, hasTouch: false },
  { name: 'mobile', viewport: { name: 'mobile', width: 375, height: 812 }, hasTouch: false },
  {
    name: 'mobile with a coarse pointer',
    viewport: { name: 'mobile', width: 375, height: 812 },
    hasTouch: true,
  },
] as const satisfies readonly { name: string; viewport: Viewport; hasTouch: boolean }[]) {
  test.describe(`DurationField number and unit at ${name}`, () => {
    test('a pair that fits stays on one line, in a 254px phone card and on a wide row', async ({
      componentPage,
    }) => {
      const read = await openAlignment(componentPage, viewport, hasTouch);
      const wide = await read('wide');
      expect(wide.wrapped, 'the wide row wraps').toBe(false);
      expect(wide.unitAfterNumber, 'the wide unit follows its number').toBe(true);

      // A workflow step's limit: units in words and no placeholder, so two digits are the floor.
      const card = await read('phone-card');
      expect(card.row, 'the phone card row is 254px').toBeCloseTo(254, 0);
      expect(card.wrapped, `a ${card.row}px row that needs ${card.minimum}px wraps`).toBe(false);
      expect(card.pastRowEnd, 'the phone card pair passes its row').toBeLessThanOrEqual(0.5);
      expect(
        card.slot,
        `the slot ${card.slot} vs two digits ${card.digits}`,
      ).toBeGreaterThanOrEqual(card.digits);

      // The same row with a number that may be unset.
      const unset = await read('phone-card-not-set');
      expect(unset.wrapped, `a ${unset.row}px row that needs ${unset.minimum}px wraps`).toBe(false);
      expect(unset.pastRowEnd, 'the unset pair passes its row').toBeLessThanOrEqual(0.5);
      expect(
        unset.slot,
        `the slot ${unset.slot} vs "Not set" ${unset.shown}`,
      ).toBeGreaterThanOrEqual(unset.shown);
    });

    test('a row that cannot hold the pair wraps the unit under the number, at its leading edge', async ({
      componentPage,
    }) => {
      const read = await openAlignment(componentPage, viewport, hasTouch);
      for (const id of ['squeezed', 'squeezed-not-set']) {
        const row = await read(id);
        expect(row.wrapped, `${id}: a ${row.row}px row that needs ${row.minimum}px`).toBe(true);
        expect(row.unitAtLeadingEdge, `${id}: the unit's leading edge`).toBe(true);
        expect(row.pastRowEnd, `${id}: past the row's end`).toBeLessThanOrEqual(0.5);
        // "90" in one row and "Not set" in the other, whole.
        expect(row.slot, `${id}: the slot ${row.slot} vs ${row.shown}`).toBeGreaterThanOrEqual(
          row.shown,
        );
        expect(row.slot, `${id}: the slot ${row.slot} vs ${row.digits}`).toBeGreaterThanOrEqual(
          row.digits,
        );
      }

      // 192px is the row that drew "90" as "9..". The pair misses it by under 5px (it needs about
      // 195px), so the fixture's own row is narrower and this width is set here.
      const at192 = await read('squeezed', 192);
      expect(at192.wrapped, `a 192px row that needs ${at192.minimum}px`).toBe(true);
      expect(at192.unitAtLeadingEdge, "the 192px row's unit leading edge").toBe(true);
      expect(at192.pastRowEnd, "past the 192px row's end").toBeLessThanOrEqual(0.5);
      expect(at192.slot, `the slot ${at192.slot} vs "90" ${at192.shown}`).toBeGreaterThanOrEqual(
        at192.shown,
      );
    });

    test('the unit wraps where the pair stops fitting, and not before', async ({
      componentPage,
    }) => {
      const read = await openAlignment(componentPage, viewport, hasTouch);
      // What a pair needs is read from its own parts, so the row is set from the fonts in use.
      for (const id of ['squeezed', 'squeezed-not-set', 'phone-card']) {
        const fits = await read(id, 'just-fits');
        expect(fits.wrapped, `${id}: ${fits.row}px holds a ${fits.minimum}px pair`).toBe(false);
        expect(fits.pastRowEnd, `${id}: past the row's end`).toBeLessThanOrEqual(0.5);
        expect(
          fits.slot,
          `${id}: the slot ${fits.slot} vs its text ${Math.max(fits.digits, fits.placeholder)}`,
        ).toBeGreaterThanOrEqual(Math.max(fits.digits, fits.placeholder));

        const short = await read(id, 'just-short');
        expect(short.wrapped, `${id}: ${short.row}px is under a ${short.minimum}px pair`).toBe(
          true,
        );
        expect(short.unitAtLeadingEdge, `${id}: the unit's leading edge`).toBe(true);
        expect(short.pastRowEnd, `${id}: past the row's end`).toBeLessThanOrEqual(0.5);
      }
    });

    test('a row narrower than the number gives up the slot before anything leaves the row', async ({
      componentPage,
    }) => {
      const read = await openAlignment(componentPage, viewport, hasTouch);
      const narrow = await read('squeezed', 100);
      expect(narrow.wrapped, 'a 100px row wraps').toBe(true);
      expect(narrow.pastRowEnd, 'the steppers pass a 100px row').toBeLessThanOrEqual(0.5);
    });
  });
}
