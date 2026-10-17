import { loadManifest, VIEWPORTS } from '@lostgradient/testing';

import { expect, test } from './component-page-fixture.ts';

const entries = loadManifest();

test('VideoPlayer plays, pauses, and seeks from the controls and the keyboard', async ({
  componentPage,
}) => {
  const entry = entries.find((candidate) => candidate.slug === 'video-player');
  const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (entry === undefined || fixture === undefined) {
    throw new Error('video-player must expose its assertion fixture');
  }
  const page = await componentPage.open({
    entry,
    theme: 'light',
    viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
    fixtureName: fixture.name,
    fixtureContentHash: fixture.fixtureContentHash,
  });

  const player = page.getByTestId('video-player-playable');
  const button = player.getByRole('button');
  const media = player.locator('video');
  const currentTime = () => media.evaluate((element: HTMLMediaElement) => element.currentTime);

  await expect(media).toHaveJSProperty('readyState', 4);
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  // Pointer: play, then pause.
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(currentTime).toBeGreaterThan(0);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(media).toHaveJSProperty('paused', true);

  // Keyboard: Space plays, Enter pauses.
  await button.focus();
  await page.keyboard.press('Space');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  // Seek with the slider by keyboard.
  const slider = player.getByRole('slider', { name: 'Fixture clip position' });
  await slider.focus();
  await page.keyboard.press('End');
  await expect.poll(currentTime).toBeGreaterThan(3.5);
  await page.keyboard.press('Home');
  await expect.poll(currentTime).toBeLessThan(0.5);
  await page.keyboard.press('ArrowRight');
  await expect.poll(currentTime).toBeGreaterThan(0);

  // A source with a disallowed scheme is unavailable and never loads.
  const blocked = page.getByTestId('video-player-blocked');
  await expect(blocked.getByRole('button')).toHaveAttribute('data-cinder-state', 'unavailable');
  await expect(blocked.locator('video')).not.toHaveAttribute('src', /.*/);
});
