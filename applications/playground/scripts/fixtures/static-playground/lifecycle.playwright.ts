/**
 * Holds one real Chromium page open on the good fixture and announces it by writing
 * `browser-active` beside the run's case list, then waits for the runner to be interrupted.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { readEnvironmentConfiguration } from '../../../src/environment-configuration.ts';

test('keeps a browser page open until the runner is interrupted', async ({ page }) => {
  const casesPath = readEnvironmentConfiguration().playgroundStaticCases;
  if (casesPath === undefined) throw new Error('PLAYGROUND_STATIC_CASES is required');
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fixture home');
  // Playwright runs this file under Node, so it uses `node:fs`, not Bun's file API.
  writeFileSync(join(dirname(casesPath), 'browser-active'), '');
  await new Promise<never>(() => {});
});
