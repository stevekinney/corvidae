import { loadManifest } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

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

// R10-13: a long key chosen in a secret field is cut in its middle inside its column. An implicit
// `auto` grid track once took the key's whole width, so the trigger and its help ran off a phone.
test.describe('SchemaForm secret field with a long chosen key', () => {
  test('cuts the key in its middle in the trigger, and keeps the trigger and help inside the column', async ({
    componentPage,
  }) => {
    const longKey = 'slack-workspace-admin-bot-token-for-the-reviews-channel';
    const page = await componentPage.open({
      entry: getEntry('schema-form'),
      theme: lightTheme,
      viewport: { name: 'phone', width: 320, height: 900 },
      fixtureName: 'long-secret',
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const column = page.locator('#long-secret-column');
    const trigger = column.getByRole('combobox', { name: /^Token/ });
    const chosen = trigger.locator('.cinder-select__value .cinder-text');
    await expect(chosen).toHaveAttribute('data-cinder-truncate', 'middle');
    await expect(chosen.locator('.cinder-text__tail')).toHaveText('nnel');

    const measured = await column.evaluate((element) => {
      const right = (selector: string): number => {
        const node = element.querySelector(selector);
        if (node === null) throw new Error(`The column drew no ${selector}`);
        return node.getBoundingClientRect().right;
      };
      const head = element.querySelector<HTMLElement>(
        '.cinder-select__value .cinder-text .cinder-text__head',
      );
      if (head === null) throw new Error('The trigger drew no head');
      return {
        column: element.getBoundingClientRect().right,
        trigger: right('.cinder-schema-form__secret .cinder-select'),
        help: right('.cinder-schema-form__secret .cinder-select-field__description'),
        headScroll: head.scrollWidth,
        headClient: head.clientWidth,
        headText: head.textContent ?? '',
      };
    });
    // The head keeps the whole key's start as its text and is drawn narrower than that text.
    expect(measured.headText).toBe(longKey.slice(0, -4));
    expect(measured.headScroll, JSON.stringify(measured)).toBeGreaterThan(measured.headClient);
    expect(measured.trigger, JSON.stringify(measured)).toBeLessThanOrEqual(measured.column + 0.5);
    expect(measured.help, JSON.stringify(measured)).toBeLessThanOrEqual(measured.column + 0.5);
  });
});
