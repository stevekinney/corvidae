/**
 * The agent editor's model field against the real host: models grouped by provider, a provider the
 * host can call and has no key for listed as a disabled option that points to Settings › Models,
 * and the abilities of the chosen model. The host's home connects one provider (`anthropic`), so
 * the others are not connected. The editor's other fields are in `24-define-agents.spec.ts`.
 */
import { AGENT_EDITOR_COPY } from '../../src/app/copy.ts';
import { providerDisplayName } from '../../src/routes/settings/models/format-model.ts';
import { expect, test } from './fixtures.ts';

const copy = AGENT_EDITOR_COPY.model;
const WIDTHS = [375, 1280] as const;

for (const width of WIDTHS) {
  test.describe(`the model field at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('groups models by provider and disables a provider that is not connected', async ({
      page,
      request,
    }) => {
      const response = await request.get('/host/providers');
      expect(response.ok()).toBe(true);
      const host = (await response.json()) as { providers: { name: string; hasKey: boolean }[] };
      const unconnected = host.providers.filter((provider) => !provider.hasKey);
      // The home connects `anthropic` alone, so this spec has a provider to look at.
      expect(unconnected.length).toBeGreaterThan(0);

      await page.goto('/agents/new');
      const model = page.getByRole('combobox', { name: 'Model' });
      await expect(model).toBeVisible();
      await model.fill('');

      await expect(page.locator('.cinder-_option-group__label').first()).toHaveText('Anthropic');
      for (const provider of unconnected) {
        const option = page.getByRole('option', {
          name: copy.notConnected(providerDisplayName(provider.name)),
        });
        await expect(option).toHaveAttribute('aria-disabled', 'true');
      }

      // Pressing a provider that is not connected chooses nothing.
      const first = unconnected[0];
      if (first === undefined) throw new Error('Expected a provider that is not connected.');
      await page
        .getByRole('option', { name: copy.notConnected(providerDisplayName(first.name)) })
        .click({ force: true });
      await page.keyboard.press('Escape');
      await expect(model).toHaveValue('anthropic/claude-sonnet-5');

      // The line under the field links to the page that connects a provider.
      const hint = page.getByTestId('agent-model-unconnected');
      await expect(hint).toContainText(
        copy.unconnectedLead(unconnected.map(label)).split(' in')[0]!,
      );
      await hint.getByRole('link', { name: copy.settingsLink }).click();
      await expect(page).toHaveURL(/\/settings\/models$/);
    });

    test('shows the abilities of the chosen model', async ({ page }) => {
      await page.goto('/agents/new');
      const abilities = page.getByTestId('agent-model-abilities');
      await expect(abilities).toBeVisible();
      await expect(abilities).toContainText(copy.abilities.tools);

      const model = page.getByRole('combobox', { name: 'Model' });
      await model.fill('');
      await page.getByRole('option', { name: /^anthropic\/claude-haiku-4-5/ }).click();
      await expect(model).toHaveValue('anthropic/claude-haiku-4-5');
      await expect(abilities).toBeVisible();
      await expect(abilities).toContainText(/context window/);
    });
  });
}

function label(provider: { name: string }): string {
  return providerDisplayName(provider.name);
}
