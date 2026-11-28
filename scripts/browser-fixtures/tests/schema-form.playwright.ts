import { loadManifest, type Viewport } from '@lostgradient/testing';
import {
  expect,
  test,
  type ComponentPageFixture,
} from '@lostgradient/testing/playwright/component-page-fixture';

const entriesBySlug = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));
const desktopViewport = { name: 'desktop', width: 1280, height: 900 } as const;
const lightTheme = 'light' as const;

function getEntry(slug: string) {
  const entry = entriesBySlug.get(slug);
  if (!entry) throw new Error(`Component manifest is missing slug: ${slug}`);
  return entry;
}

test.describe('SchemaForm native form serialization', () => {
  test('serializes the validated JSON Schema value into real FormData', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('schema-form'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });

    const mount = page.locator('#example-mount-json-schema');
    const form = mount.locator('form');
    await expect(form).toBeVisible();

    await mount.getByRole('button', { name: 'Save schedule' }).click();
    const submittedOutput = mount
      .getByRole('heading', { name: 'Last valid submission' })
      .locator('..')
      .locator('pre');
    await expect(submittedOutput).toContainText('"name": "Refresh indexes"');

    const payload = await form.evaluate((element) => {
      if (!(element instanceof HTMLFormElement)) throw new Error('Expected a form element.');
      const raw = new FormData(element).get('payload');
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    });

    expect(payload).toEqual({
      name: 'Refresh indexes',
      retries: 2,
      enabled: true,
      cadence: 'daily',
    });
  });
});

/**
 * A host's own settings rows (`rootRowHosted`), measured in a browser because happy-dom has no
 * layout: a form that is one number or one choice hands its control to the host row's control
 * column, so the row is as tall, as wide and as far from the next as a row with a plain scalar
 * control, and what a chosen alternative adds sits with its parent. The `host-row` fixture is a
 * list of such rows beside reference scalar rows; the `setting-rows` fixture is the form's own.
 */
const SPACING = 16;
/** A row's body starts this far under the row's text: the SettingRow's own gap (`space-2`). */
const ROW_BODY_GAP = 8;
const TOLERANCE = 1;

type Box = { x: number; y: number; width: number; height: number };

/** Two measured lengths are the same, and a failure names both, so a run shows the numbers. */
const same = (label: string, actual: number, expected: number, tolerance = TOLERANCE) =>
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    tolerance,
  );

/** A measured length is at most a limit, and a failure names both. */
const atMost = (label: string, actual: number, limit: number) =>
  expect(actual, `${label}: ${actual} vs at most ${limit}`).toBeLessThanOrEqual(limit);

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
] as const satisfies readonly Viewport[]) {
  test.describe(`SchemaForm in a host's settings rows at ${viewport.name}`, () => {
    async function openHostRows(componentPage: ComponentPageFixture) {
      const entry = getEntry('schema-form');
      const fixture = entry.fixtures?.find((candidate) => candidate.name === 'host-row');
      const page = await componentPage.open({
        entry,
        theme: lightTheme,
        viewport,
        fixtureName: 'host-row',
        ...(fixture === undefined ? {} : { fixtureContentHash: fixture.fixtureContentHash }),
      });
      const row = (id: string) => page.locator(`[data-testid="${id}"]`);
      const box = async (locator: ReturnType<typeof row>): Promise<Box> => {
        const found = await locator.first().boundingBox();
        if (found === null) throw new Error('The element has no box.');
        return found;
      };
      return { page, row, box };
    }

    test('a lone number is the width, edge and height of a scalar row, with no label of its own', async ({
      componentPage,
    }) => {
      const { page, row, box } = await openHostRows(componentPage);
      const scalar = row('scalar');
      const lone = row('lone-number');
      const scalarInput = await box(scalar.locator('input[inputmode="decimal"]'));
      const loneInput = await box(lone.locator('input[inputmode="decimal"]'));
      same(
        'the number input right edge',
        loneInput.x + loneInput.width,
        scalarInput.x + scalarInput.width,
      );
      same('the number input width', loneInput.width, scalarInput.width);
      const loneField = await box(lone.locator('.cinder-number-input-field'));
      const scalarField = await box(scalar.locator('.cinder-number-input-field'));
      same('the number field left edge', loneField.x, scalarField.x);
      same('the number field width', loneField.width, scalarField.width);
      // The control is in the row's control column, with the row's own text, not under it.
      const frame = await box(lone.locator('.cinder-setting-row__field'));
      const centre = loneInput.y + loneInput.height / 2;
      expect(centre >= frame.y && centre <= frame.y + frame.height).toBe(true);
      // "Max bytes" names the control for assistive technology only.
      const visibleLabels = await page.evaluate(() => {
        const found = [...document.querySelectorAll('[data-testid="lone-number"] *')].filter(
          (element) => element.children.length === 0 && element.textContent?.trim() === 'Max bytes',
        );
        return found.filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 2 && rect.height > 2;
        }).length;
      });
      expect(visibleLabels).toBe(0);
      const loneRow = await box(lone.locator('.cinder-setting-row'));
      const scalarRow = await box(scalar.locator('.cinder-setting-row'));
      same('the row height', loneRow.height, scalarRow.height);
    });

    test('a choice that is off is a scalar row, with its control on the column and no legend', async ({
      componentPage,
    }) => {
      const { row, box } = await openHostRows(componentPage);
      const scalar = row('scalar');
      const off = row('choice-off');
      // The column is the scalar number's whole field (its frame, steppers included), not the
      // text input inside it, which stops where the steppers start.
      const scalarField = await box(scalar.locator('.cinder-number-input-field'));
      const group = await box(off.locator('[role="radiogroup"]'));
      const offRow = await box(off.locator('.cinder-setting-row'));
      if (offRow.width >= 480) {
        same('the choice right edge', group.x + group.width, scalarField.x + scalarField.width);
      } else {
        // Stacked under the label, a number fills the row and a choice, which never stretches,
        // starts at the same leading edge.
        same('the choice left edge', group.x, scalarField.x);
      }
      const scalarRow = await box(scalar.locator('.cinder-setting-row'));
      same('the row height', offRow.height, scalarRow.height);
      expect(await off.locator('.cinder-schema-form__legend:visible').count()).toBe(0);
    });

    test('a custom choice puts its field with its parent and 16px above the next row', async ({
      componentPage,
    }) => {
      const { row, box } = await openHostRows(componentPage);
      const custom = row('choice-custom');
      const rowBox = await box(custom.locator('.cinder-setting-row'));
      const count = await box(custom.locator('.cinder-schema-form__field').first());
      same('the field left edge', count.x, rowBox.x);
      // The next row's box, not its label: a row is at least 44px tall and centres its text, so the
      // label sits a pixel or two inside the row's top edge, which is what the list spaces.
      const nextRow = await box(row('scalar-after').locator('.cinder-setting-row'));
      same('the gap to the next row', nextRow.y - (count.y + count.height), SPACING);
    });

    test('a word-or-object row with the object chosen starts 8px under its text and ends with the list spacing', async ({
      componentPage,
    }) => {
      const { row, box } = await openHostRows(componentPage);
      const word = row('word-custom');
      // The row's text is its frame (label, description and, on a narrow row, the control stacked
      // under them): on a wide row the control sits beside the text and the frame ends with the
      // description, on a narrow one it ends with the stacked control. The body starts one
      // SettingRow gap under it either way.
      const frame = await box(word.locator('.cinder-setting-row__field'));
      const children = word.locator('.cinder-schema-form__choice-body > *');
      const first = await box(children.first());
      const last = await box(children.last());
      same(
        'the gap from the row text to the first field',
        first.y - (frame.y + frame.height),
        ROW_BODY_GAP,
      );
      const body = await box(word.locator('.cinder-schema-form__choice-body'));
      same('the body ends with its last field', body.y + body.height, last.y + last.height);
      const next = await box(row('scalar-end'));
      same('the gap from the last field to the next row', next.y - (last.y + last.height), SPACING);
    });

    test('every adjacent pair of rows is 16px apart, and no control ends past its row', async ({
      componentPage,
    }) => {
      const { row, box } = await openHostRows(componentPage);
      const ids = [
        'scalar',
        'lone-number',
        'choice-off',
        'choice-custom',
        'scalar-after',
        'guard-duration',
        'word-custom',
        'scalar-end',
      ];
      let previous: Box | undefined;
      for (const id of ids) {
        const current = await box(row(id));
        if (previous !== undefined) {
          same(`${id}: the gap above the row`, current.y - (previous.y + previous.height), SPACING);
        }
        for (const control of await row(id).locator('input, select, [role="radiogroup"]').all()) {
          const found = await control.boundingBox();
          if (found === null) continue;
          atMost(
            `${id}: a control's bottom`,
            found.y + found.height,
            current.y + current.height + 0.5,
          );
        }
        previous = current;
      }
    });

    test('an end-aligned row keeps a wrapped duration to its cap', async ({ componentPage }) => {
      const { row, box } = await openHostRows(componentPage);
      const guard = row('guard-duration');
      const number = await box(guard.locator('input[inputmode="decimal"]'));
      const unit = await box(guard.locator('select'));
      const column = await box(guard.locator('.cinder-setting-row__field'));
      atMost('the number width', number.width, 160.5);
      atMost('the unit right edge', unit.x + unit.width, column.x + column.width + 0.5);
    });
  });

  test.describe(`SchemaForm setting rows with a duration at ${viewport.name}`, () => {
    test('the duration fills the column on a wide row, and is a compact pair on a phone', async ({
      componentPage,
    }) => {
      const entry = getEntry('schema-form');
      const fixture = entry.fixtures?.find((candidate) => candidate.name === 'setting-rows');
      const page = await componentPage.open({
        entry,
        theme: lightTheme,
        viewport,
        fixtureName: 'setting-rows',
        ...(fixture === undefined ? {} : { fixtureContentHash: fixture.fixtureContentHash }),
      });
      const search = await page
        .locator('[data-cinder-field="searchAddress"] input')
        .first()
        .boundingBox();
      const rowElement = page.locator('[data-cinder-field="cacheMs"] .cinder-setting-row').first();
      const rowBox = await rowElement.boundingBox();
      const number = await page
        .locator('[data-cinder-field="cacheMs"] input[inputmode="decimal"]')
        .first()
        .boundingBox();
      const unit = await page.locator('[data-cinder-field="cacheMs"] select').first().boundingBox();
      if (search === null || rowBox === null || number === null || unit === null) {
        throw new Error('The rows are not drawn.');
      }
      if (rowBox.width >= 480) {
        // Wide enough for a control column: the pair fills it, on the edges of its siblings.
        same('the unit right edge', unit.x + unit.width, search.x + search.width);
        same('the number left edge', number.x, search.x);
      } else {
        // Stacked under the label: the compact pair, number first, narrower than the row.
        const pairWidth = unit.x + unit.width - number.x;
        atMost('the pair width', pairWidth, rowBox.width - 1);
        atMost('the number left edge', number.x, unit.x - 1);
      }
    });
  });
}
