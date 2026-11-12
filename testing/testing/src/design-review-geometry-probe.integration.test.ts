import { chromium } from '@playwright/test';
import { describe, expect, it } from 'bun:test';

import { collectGeometryFacts } from './design-review-geometry-probe.ts';

describe('design-review geometry probe', () => {
  it('separates a transparent touch border from the painted control face', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main>
          <div class="scrollport"><button aria-label="Padding face">Padding face</button></div>
        </main>
        <style>
          button {
            width: 120px;
            height: 44px;
            border: 8px solid transparent;
            background: #f00;
            background-clip: padding-box;
          }
          .scrollport { width: 160px; height: 44px; overflow: hidden; }
        </style>
      `);

      const facts = await page.evaluate(collectGeometryFacts);
      const control = facts.controls.find(
        (candidate) => candidate.accessibleLabel === 'Padding face',
      );
      expect(control?.rect.height).toBe(44);
      expect(control?.painted.height).toBe(28);
      expect(control?.hit.height).toBe(44);

      await page.locator('.scrollport').evaluate((element) => {
        element.setAttribute('style', 'height: 20px; overflow: hidden; padding-top: 12px;');
      });
      const clippedFacts = await page.evaluate(collectGeometryFacts);
      const clipped = clippedFacts.controls.find(
        (candidate) => candidate.accessibleLabel === 'Padding face',
      );
      expect(clipped?.painted.height).toBe(12);
    } finally {
      await browser.close();
    }
  });
});
