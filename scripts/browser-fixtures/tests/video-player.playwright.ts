/// <reference lib="dom" />
import { loadManifest, VIEWPORTS } from '@lostgradient/testing';

import { expect, test } from '@lostgradient/testing/playwright/component-page-fixture';
import { fixtureRoute, setFixtureWidth } from './layout-fixture.ts';

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
  const button = player.getByRole('button', { name: 'Play or pause' });
  const media = player.locator('video');
  const currentTime = () => media.evaluate((element: HTMLMediaElement) => element.currentTime);

  await expect(media).toHaveJSProperty('readyState', 4);
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  // The elapsed and total time show once the length is known; the slider speaks the same.
  await expect(player.locator('.cinder-media-controls__time')).toHaveText('0:00 / 0:04');
  await expect(player.getByRole('slider')).toHaveAttribute('aria-valuetext', '0:00 of 0:04');

  // Mute: a pressed toggle that follows the element's own muted state.
  const mute = player.getByRole('button', { name: 'Mute' });
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await mute.click();
  await expect(media).toHaveJSProperty('muted', true);
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await mute.press('Enter');
  await expect(media).toHaveJSProperty('muted', false);
  await expect(mute).toHaveAttribute('aria-pressed', 'false');

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
  await expect(blocked.getByRole('button', { name: 'Mute' })).toHaveCount(0);
  await expect(blocked.locator('video')).not.toHaveAttribute('src', /.*/);
});

test('at 375px under touch, each control, marker, and chapter keeps its own 44px target', async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 375, height: 1400 },
  });
  try {
    const page = await context.newPage();
    await page.goto(fixtureRoute('video-player'), { waitUntil: 'load' });
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
    const review = page.getByTestId('video-player-review');
    await expect(review.getByRole('button', { name: 'Comment 1 at 0:08' })).toBeVisible();
    // The bound position written before the metadata loaded reaches the comment action.
    await expect(review.getByRole('button', { name: 'Comment at 0:19' })).toBeVisible();
    await review.scrollIntoViewIfNeeded();

    const markerCenters = await review
      .locator('.cinder-video-player__marker')
      .evaluateAll((markers) =>
        markers.map((marker) => {
          const box = marker.getBoundingClientRect();
          return box.x + box.width / 2;
        }),
      );
    expect(markerCenters).toHaveLength(3);
    for (let index = 1; index < markerCenters.length; index += 1) {
      expect(markerCenters[index]! - markerCenters[index - 1]!).toBeGreaterThanOrEqual(44);
    }

    const intersecting = await review.locator('.cinder-media-controls__row').evaluate((row) => {
      const boxes = [...row.children].map((child) => child.getBoundingClientRect());
      const pairs: string[] = [];
      for (let first = 0; first < boxes.length; first += 1) {
        for (let second = first + 1; second < boxes.length; second += 1) {
          const a = boxes[first]!;
          const b = boxes[second]!;
          const apart =
            a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
          if (!apart) pairs.push(`${first} and ${second}`);
        }
      }
      return pairs;
    });
    expect(intersecting).toEqual([]);

    const misses = await review.evaluate((root) => {
      const targets = [
        ...root.querySelectorAll<HTMLElement>(
          '.cinder-media-controls__row button, .cinder-video-player__marker, .cinder-video-player__chapter',
        ),
      ].filter((target) => target.getClientRects().length > 0);
      const missed: string[] = [];
      for (const target of targets) {
        const box = target.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const probes = [
          ['above', x, y - 21],
          ['below', x, y + 21],
          ['left', x - 21, y],
          ['right', x + 21, y],
        ] as const;
        for (const [side, probeX, probeY] of probes) {
          if (!target.contains(document.elementFromPoint(probeX, probeY))) {
            const name = target.getAttribute('aria-label') ?? target.textContent?.trim() ?? '';
            missed.push(`${name} ${side}`);
          }
        }
      }
      return { count: targets.length, missed };
    });
    // Three markers, play, back, speed, mute, the comment action, and three chapters at least.
    expect(misses.count).toBeGreaterThanOrEqual(11);
    expect(misses.missed).toEqual([]);
  } finally {
    await context.close();
  }
});

test('markers ten pixels apart overlap with the later on top, and Tab reaches both in order', async ({
  page,
}) => {
  await page.goto(fixtureRoute('video-player'), { waitUntil: 'load' });
  const player = page.getByTestId('video-player-close-markers');
  // 48 seconds over a 480px marker layer (the player less the slider thumb's 16px travel inset)
  // puts the markers at 0:20 and 0:21 ten pixels apart.
  await setFixtureWidth(player, '496px');
  const earlier = player.getByRole('button', { name: 'Comment 1 at 0:20' });
  const later = player.getByRole('button', { name: 'Comment 2 at 0:21' });
  await expect(later).toBeVisible();
  const [earlierBox, laterBox] = await Promise.all([earlier.boundingBox(), later.boundingBox()]);
  const earlierCenter = earlierBox!.x + earlierBox!.width / 2;
  const laterCenter = laterBox!.x + laterBox!.width / 2;
  expect(laterCenter - earlierCenter).toBeCloseTo(10, 0);

  const hitsLater = await later.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(
      document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
    );
  });
  expect(hitsLater).toBe(true);

  await player.getByRole('slider', { name: 'Close comments position' }).focus();
  await page.keyboard.press('Tab');
  await expect(earlier).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(later).toBeFocused();
});
