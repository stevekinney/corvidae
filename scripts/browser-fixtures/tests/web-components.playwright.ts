import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('the browser entry registers every component in the Cinder manifest', async ({ page }) => {
  const manifest: { components: { id: string }[] } = await Bun.file(
    resolve(import.meta.dirname, '../../../components/cinder/.metadata/components.json'),
  ).json();
  const tags = manifest.components.map(({ id }) => `cinder-${id}`).toSorted();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/web-components/index.html');
  await expect(page.locator('.cinder-avatar__initials')).toHaveText('AL');
  const registrations = await page.evaluate((names) => {
    return names.filter((name) => {
      const constructor = customElements.get(name);
      return constructor !== undefined && document.createElement(name) instanceof constructor;
    });
  }, tags);
  expect(registrations).toEqual(tags);
  expect(errors).toEqual([]);
});

test('VirtualList passes live row data to a plain JavaScript renderer', async ({ page }) => {
  await page.goto('/web-components/index.html');
  await page.evaluate(async () => {
    await customElements.whenDefined('cinder-virtual-list');
    const list = document.createElement('cinder-virtual-list');
    list.setAttribute('item-height', '32');
    list.setAttribute('height', '128px');
    Object.assign(list, {
      items: ['Daily digest', 'As they arrive'],
      renderRow(label: string, context: { index: number }) {
        const row = document.createElement('div');
        row.textContent = `${context.index}: ${label}`;
        return row;
      },
    });
    document.body.append(list);
  });
  const list = page.locator('cinder-virtual-list');
  await expect(list).toContainText('0: Daily digest');
  await expect(list).toContainText('1: As they arrive');
  await list.evaluate((element) => Object.assign(element, { items: ['Weekly digest'] }));
  await expect(list).toContainText('0: Weekly digest');
  await expect(list).not.toContainText('Daily digest');
});

test('composed custom elements share their source component context', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/web-components/index.html', async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const tabs = `
      <cinder-tabs value="first">
        <cinder-tab-list label="Example tabs">
          <cinder-tab value="first">First tab</cinder-tab>
          <cinder-tab value="second">Second tab</cinder-tab>
        </cinder-tab-list>
        <cinder-tab-panel value="first">First panel</cinder-tab-panel>
        <cinder-tab-panel value="second">Second panel</cinder-tab-panel>
      </cinder-tabs>
    `;
    await route.fulfill({ response, body: html.replace('</body>', `${tabs}</body>`) });
  });
  await page.goto('/web-components/index.html');
  await expect(page.getByRole('tab', { name: 'First tab' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const second = page.getByRole('tab', { name: 'Second tab' });
  await second.click();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveText('Second panel');
  expect(errors).toEqual([]);
});

for (const name of [
  'data-list',
  'list-detail',
  'command-menu',
  'command-palette',
  'navigation-bar',
  'resizable-panels',
] as const) {
  test(`${name} calls its browser renderer with component data`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/web-components/index.html');
    await page.evaluate(async (name) => {
      const tag = `cinder-${name}`;
      await customElements.whenDefined(tag);
      const element = document.createElement(tag);
      const row = (text: string) => {
        const result = document.createElement('li');
        result.textContent = text;
        return result;
      };
      const anchor = document.createElement('input');
      document.body.append(anchor);
      const properties = {
        'data-list': {
          items: ['Alpha'],
          key: (item: string) => item,
          renderChildren: (item: string) => row(`List: ${item}`),
        },
        'list-detail': {
          items: ['Alpha'],
          key: (item: string) => item,
          label: 'Entries',
          openFirst: true,
          renderList: (item: string) => row(item),
          renderDetail: (item: string) => `Detail: ${item}`,
        },
        'command-menu': {
          open: true,
          anchor,
          query: 'Alpha',
          renderItems: ({ query }: { query: string }) => `Menu: ${query}`,
        },
        'command-palette': {
          open: true,
          query: 'Alpha',
          renderItems: ({ query }: { query: string }) => `Palette: ${query}`,
        },
        'navigation-bar': {
          placement: 'bottom',
          renderItems: ({ placement }: { placement: string }) => `Navigation: ${placement}`,
        },
        'resizable-panels': {
          panes: [
            { id: 'first', label: 'Alpha' },
            { id: 'second', label: 'Beta' },
          ],
          renderChildren: ({ label }: { label: string }) => `Pane: ${label}`,
        },
      };
      Object.assign(element, properties[name]);
      document.body.append(element);
    }, name);
    if (name === 'command-palette') {
      await page.getByRole('combobox', { name: 'Command palette' }).fill('Alpha');
    }
    const expected = {
      'data-list': 'List: Alpha',
      'list-detail': 'Detail: Alpha',
      'command-menu': 'Menu: Alpha',
      'command-palette': 'Palette: Alpha',
      'navigation-bar': 'Navigation: bottom',
      'resizable-panels': 'Pane: Alpha',
    };
    await expect(page.getByText(expected[name], { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('Cinder upgrades plain HTML with theme, native form, and single-open accordion behavior', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/web-components/index.html');
  const avatar = page.locator('cinder-avatar');
  await expect(avatar.locator('.cinder-avatar__initials')).toHaveText('AL');
  await avatar.evaluate((element) =>
    element.parentElement!.style.setProperty('--cinder-surface-inset', 'rebeccapurple'),
  );
  await expect(avatar.locator('.cinder-avatar')).toHaveCSS('background-color', 'rgb(102, 51, 153)');
  await avatar.evaluate((element) => element.setAttribute('name', 'Grace Hopper'));
  await expect(avatar.locator('.cinder-avatar__initials')).toHaveText('GH');

  const select = page.getByRole('combobox', { name: 'Notification delivery' });
  const host = page.locator('cinder-select');
  await host.evaluate((element) =>
    element.addEventListener('change', () => element.setAttribute('data-changed', 'yes'), {
      once: true,
    }),
  );
  await select.selectOption('instant');
  await expect(host).toHaveAttribute('data-changed', 'yes');
  await expect(host).toHaveJSProperty('value', 'instant');
  const submit = page.locator('cinder-button');
  const nativeButton = submit.getByRole('button', { name: 'Read form value' });
  await expect(nativeButton).toHaveAttribute('type', 'submit');
  const formWidth = await page.locator('form').evaluate((element) => element.clientWidth);
  const buttonWidth = await nativeButton.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  expect(buttonWidth).toBeLessThan(formWidth);
  await submit.evaluate((element) => element.setAttribute('disabled', ''));
  await expect(nativeButton).toBeDisabled();
  await submit.evaluate((element) => element.removeAttribute('disabled'));
  await expect(nativeButton).toBeEnabled();
  await nativeButton.click();
  await expect(page.locator('output')).toHaveText('delivery=instant');

  await page.locator('form').evaluate((form: HTMLFormElement) => form.reset());
  await expect(select).toHaveValue('daily');
  await expect(host).toHaveJSProperty('value', 'daily');

  const daily = page.getByRole('button', { name: 'Daily digest' });
  const instant = page.getByRole('button', { name: 'As they arrive' });
  const firstPanel = page.getByText('Receive one email with the day’s updates.');
  const secondPanel = page.getByText('Receive an email for each update.');
  await expect(daily).toHaveAttribute('aria-expanded', 'false');
  await expect(daily).toHaveCSS('border-bottom-left-radius', '0px');
  await expect(firstPanel).toBeHidden();
  await daily.focus();
  await daily.press('Enter');
  await expect(daily).toHaveAttribute('aria-expanded', 'true');
  await expect(firstPanel).toBeVisible();
  await instant.click();
  await expect(daily).toHaveAttribute('aria-expanded', 'false');
  await expect(firstPanel).toBeHidden();
  await expect(instant).toHaveAttribute('aria-expanded', 'true');
  await expect(secondPanel).toBeVisible();
  await expect(instant).toHaveCSS('display', 'flex');

  await page
    .locator('cinder-accordion')
    .evaluate((element) => element.setAttribute('multiple', ''));
  await daily.click();
  await expect(daily).toHaveAttribute('aria-expanded', 'true');
  await expect(instant).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test('accordion spacing follows the component width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/web-components/index.html');
  const accordion = page.locator('cinder-accordion');
  const trigger = accordion.getByRole('button', { name: 'Daily digest' });
  await expect(trigger).toHaveCSS('padding-block-start', '16px');

  await accordion.evaluate((element) => element.style.setProperty('inline-size', '20rem'));
  await expect(trigger).toHaveCSS('padding-block-start', '12px');

  await page.setViewportSize({ width: 375, height: 640 });
  await accordion.evaluate((element) => element.style.setProperty('inline-size', '32rem'));
  await expect(trigger).toHaveCSS('padding-block-start', '16px');
});

test('edits to authored items preserve the live panel contents', async ({ page }) => {
  await page.goto('/web-components/index.html');
  const accordion = page.locator('cinder-accordion');
  const item = accordion.locator('cinder-accordion-item').first();
  await item.evaluate((element) => {
    element.setAttribute('heading', 'Message');
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Draft');
    element.append(input);
  });
  const message = page.getByRole('button', { name: 'Message', exact: true });
  await message.click();
  const draft = page.getByRole('textbox', { name: 'Draft' });
  await draft.fill('Keep this text');
  await page.getByRole('button', { name: 'As they arrive' }).click();
  await message.click();
  await expect(draft).toHaveValue('Keep this text');
  await item.evaluate((element) => element.toggleAttribute('disabled', true));
  await expect(message).toBeDisabled();
  await item.evaluate((element) => element.remove());
  await expect(message).toHaveCount(0);

  await accordion.evaluate((element) => {
    const item = document.createElement('cinder-accordion-item');
    item.setAttribute('heading', 'New option');
    const content = document.createElement('p');
    content.textContent = 'Added after the accordion mounted.';
    item.append(content);
    element.append(item);
  });
  await page.getByRole('button', { name: 'New option' }).click();
  await expect(page.getByText('Added after the accordion mounted.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'As they arrive' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('authored select options set the reset value and update the native control', async ({
  page,
}) => {
  await page.goto('/web-components/index.html');
  await expect(page.locator('cinder-select').getByRole('combobox')).toBeVisible();

  await page.evaluate(() => {
    const form = document.createElement('form');
    form.id = 'authored-options';
    form.style.display = 'block';
    const select = document.createElement('cinder-select');
    select.setAttribute('label', 'Priority');
    document.body.append(form);
    form.append(select);
    select.append(new Option('Normal', 'normal'), new Option('High', 'high', true));
  });

  const form = page.locator('#authored-options');
  const host = form.locator('cinder-select');
  const select = form.getByRole('combobox', { name: 'Priority' });
  await expect(host).toHaveCSS('display', 'block');
  await expect(host.locator(':scope > option').first()).toBeHidden();
  await expect(select).toHaveValue('high');
  await select.selectOption('normal');
  await form.evaluate((element: HTMLFormElement) => element.reset());
  await expect(select).toHaveValue('high');
  await expect(host).toHaveJSProperty('value', 'high');

  await host.evaluate((element) => element.append(new Option('Urgent', 'urgent')));
  await select.selectOption('urgent');
  await expect(host).toHaveJSProperty('value', 'urgent');
  await host.locator(':scope > option[value="normal"]').evaluate((option) => {
    option.textContent = 'Standard';
    option.setAttribute('disabled', '');
  });
  await expect(select.getByRole('option', { name: 'Standard' })).toBeDisabled();
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 640 } });

  test('the form button accepts a tap just outside its painted face', async ({ page }) => {
    await page.goto('/web-components/index.html');
    await expect(page.getByRole('combobox')).toHaveValue('daily');
    const button = page.getByRole('button', { name: 'Read form value' });
    const bounds = await button.boundingBox();
    if (!bounds) throw new Error('The submit button must have a layout box');
    await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y - 3);
    await expect(page.locator('output')).toHaveText('delivery=daily');
  });
});

test('workspace components use their public browser properties and render real interactions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/workspace-web-components/index.html');

  const chat = page.locator('cinder-chat');
  await expect(chat.getByText('Ready to review your draft.')).toBeVisible();
  await chat.getByRole('textbox').fill('Please review the notes.');
  await chat.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('#sent-message')).toHaveText('Please review the notes.');

  await expect(chat.getByText('Please review the notes.')).toBeVisible();

  const editor = page.getByRole('application', { name: 'Notes editor' }).getByRole('textbox');
  await expect(editor.getByText('Draft')).toBeVisible();
  await editor.fill('Edited on the page.');
  await expect(page.locator('#saved-notes')).toHaveText('## Edited on the page.');

  await expect(page.locator('#parsed-output')).toHaveText('Output parsed');
  await expect(page.locator('cinder-terminal .xterm-rows')).toContainText('Terminal proof ready');

  await page.setViewportSize({ width: 375, height: 640 });
  await page.reload();
  const toolbar = page.getByRole('toolbar', { name: 'Formatting toolbar' });
  const moreFormatting = toolbar.getByRole('button', { name: 'More formatting' });
  await expect(moreFormatting).toBeVisible();
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBe(0);

  await page.setViewportSize({ width: 320, height: 640 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBe(0);
  expect(errors).toEqual([]);
});
