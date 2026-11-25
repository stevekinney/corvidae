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
          <div class="scrollport">
            <button class="cinder-button button-size-small button-variant-primary" aria-label="Padding face">Padding face</button>
          </div>
          <select class="cinder-select select-size-medium select-variant-ghost" aria-label="Filter">
            <option>All</option>
          </select>
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
      expect(control?.layout.height).toBe(44);
      expect(control?.rect.height).toBe(28);
      expect(control?.hit.height).toBe(44);
      expect(control?.name).toBe('button.cinder-button[size=small]');
      expect(control?.variant).toBe('primary');
      const select = facts.controls.find((candidate) => candidate.accessibleLabel === 'Filter');
      expect(select?.name).toBe('select.cinder-select[size=medium]');
      expect(select?.variant).toBe('ghost');
    } finally {
      await browser.close();
    }
  });

  it('measures a tooltip a hover opens, and nothing when none is visible', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
      await page.setContent(`
        <main>
          <button id="near" aria-describedby="near-tip">Near</button>
          <div role="tooltip" id="near-tip" class="near">Beside its row</div>
          <button id="far" aria-describedby="far-tip">Far</button>
          <div role="tooltip" id="far-tip" class="far">A hundred pixels off</div>
        </main>
        <style>
          main { padding: 120px 40px; }
          button { display: block; width: 100px; height: 32px; margin-bottom: 150px; }
          [role='tooltip'] { position: absolute; visibility: hidden; padding: 4px; }
          .near { left: 48px; top: 164px; }
          .far { left: 48px; top: 450px; }
          #near:hover + .near, #far:hover ~ .far { visibility: visible; }
        </style>
      `);
      const rested = await page.evaluate(collectGeometryFacts);
      expect(rested.tooltips).toEqual([]);

      await page.hover('#near');
      const nearFacts = await page.evaluate(collectGeometryFacts);
      const near = nearFacts.tooltips;
      expect(near).toHaveLength(1);
      expect(near[0]?.verticalGap).toBeLessThanOrEqual(16);

      await page.hover('#far');
      const farFacts = await page.evaluate(collectGeometryFacts);
      const far = farFacts.tooltips;
      expect(far).toHaveLength(1);
      expect(far[0]?.verticalGap).toBeGreaterThan(16);
    } finally {
      await browser.close();
    }
  });

  it('reads how strongly a fill or an outline reads against the parent', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
      await page.setContent(`
        <div class="row">
          <button class="cinder-button button-variant-soft-danger" aria-label="Soft">Soft</button>
          <button class="cinder-button button-variant-secondary" aria-label="Outlined">Outlined</button>
        </div>
        <style>
          .row { background: #fff; }
          .button-variant-soft-danger { background: rgba(255, 0, 0, 0.1); border: 0; }
          .button-variant-secondary { background: transparent; border: 1px solid #333; }
        </style>
      `);
      const facts = await page.evaluate(collectGeometryFacts);
      const soft = facts.controls.find((control) => control.accessibleLabel === 'Soft');
      const outlined = facts.controls.find((control) => control.accessibleLabel === 'Outlined');
      expect(soft?.weight?.outlined).toBe(false);
      expect(outlined?.weight?.outlined).toBe(true);
      expect(soft?.weight?.contrast).toBeLessThan(outlined?.weight?.contrast ?? 0);
    } finally {
      await browser.close();
    }
  });
});
