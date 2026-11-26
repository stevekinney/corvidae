import { chromium } from '@playwright/test';
import { describe, expect, it } from 'bun:test';

import { collectGeometryFacts } from './design-review-geometry-probe.ts';

describe('design-review geometry probe', () => {
  it('measures identifier typeface, caption gaps and disclosure chevron centring', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
      await page.setContent(`
        <style>
          :root {
            --cinder-space-1: 0.25rem; --cinder-space-2: 0.5rem; --cinder-space-3: 0.75rem; --cinder-space-4: 1rem;
            --cinder-font-mono: ui-monospace, monospace;
          }
          body { margin: 0; font: 14px/20px sans-serif; }
          .copyable { font-family: var(--cinder-font-mono); }
          .panel { --cinder-font-mono: 'Courier New', monospace; font-family: var(--cinder-font-mono); }
          ul { margin: 0; padding: 0; list-style: none; }
          .row { display: flex; align-items: flex-start; gap: 8px; padding: 8px; }
          .row.centred { align-items: center; }
          .text { display: flex; flex-direction: column; flex: 1; }
          .row span.cinder-grouped-list-item__chevron { width: 16px; height: 16px; display: block; }
          .row svg { width: 16px; height: 16px; }
          .gap-1 { margin-top: var(--cinder-space-1); }
          .gap-3 { margin-top: var(--cinder-space-3); }
          .gap-4px { margin-top: 4px; }
        </style>
        <p id="plain">127.0.0.1:7233</p>
        <p id="copy" class="copyable">127.0.0.1:7233</p>
        <p class="panel">~/work/project/file.ts</p>
        <p>namespace.delete</p>
        <p>01ARZ3NDEKTSV4RRFFQ69G5FAV</p>
        <p>Ordinary prose, no identifier here.</p>
        <table id="t4"><tr><td>a</td></tr></table><p class="gap-4px">Four</p>
        <table id="t1"><tr><td>a</td></tr></table><p class="gap-1">Space one</p>
        <table id="t3"><tr><td>a</td></tr></table><p class="gap-3">Space three</p>
        <ul>
          <li class="row" id="top"><div class="text"><span>Title</span><span>Second line</span></div><span class="cinder-grouped-list-item__chevron"><svg></svg></span></li>
          <li class="row centred" id="middle"><div class="text"><span>Title</span><span>Second line</span></div><span class="cinder-grouped-list-item__chevron"><svg></svg></span></li>
          <li class="row" id="leading"><span class="cinder-grouped-list-item__leading"><svg></svg></span><div class="text"><span>Title</span><span>Second line</span></div><span class="cinder-grouped-list-item__value"><svg></svg></span></li>
          <li class="row" id="single"><div class="text"><span>Title</span></div><span class="cinder-grouped-list-item__chevron"><svg></svg></span></li>
        </ul>
      `);

      const facts = await page.evaluate(collectGeometryFacts);

      const family = (text: string, name: string): string | undefined =>
        facts.identifiers.find((entry) => entry.text === text && entry.name === name)?.family;
      const flagged = facts.identifiers.filter((entry) => entry.family !== entry.mono);
      expect(flagged.map((entry) => entry.text)).toEqual([
        '127.0.0.1:7233',
        'namespace.delete',
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      ]);
      expect(family('127.0.0.1:7233', 'p')).toBe('sans-serif');
      expect(family('127.0.0.1:7233', 'p.copyable')).toBe('ui-monospace');
      expect(facts.identifiers.map((entry) => entry.text)).not.toContain('Ordinary prose');
      const panel = facts.identifiers.find((entry) => entry.text === '~/work/project/file.ts');
      expect(panel?.mono).toBe('courier new');
      expect(panel?.family).toBe(panel?.mono);

      const gaps = facts.captionGaps.map((entry) => [entry.sample, entry.gap]);
      expect(gaps).toEqual([
        ['Four', 4],
        ['Space one', 4],
        ['Space three', 12],
      ]);
      expect(facts.captionGaps[0]?.minimum).toBe(8);

      // The one-line row and the rows with no chevron class report nothing.
      expect(facts.chevrons).toHaveLength(2);
      expect(facts.chevrons.map((entry) => entry.name)).toEqual([
        'span.cinder-grouped-list-item__chevron',
        'span.cinder-grouped-list-item__chevron',
      ]);
      const [top, middle] = facts.chevrons;
      expect(Math.abs(top?.offset ?? 0)).toBeGreaterThan(1);
      expect(Math.abs(middle?.offset ?? 99)).toBeLessThanOrEqual(1);
      expect(top?.lines).toBe(2);
    } finally {
      await browser.close();
    }
  });

  it('measures an identifier that CopyableValue splits across inline elements', async () => {
    const stylesheet = await Bun.file(
      new URL(
        '../../../components/cinder/src/components/copyable-value/copyable-value.css',
        import.meta.url,
      ),
    ).text();
    // The markup `copyable-value.svelte` renders for `127.0.0.1:7233`: a part ends after a colon, a
    // piece after a dot, and the last character travels with the copy control in `__end`.
    const copyableValue = (style: string): string => `
      <span class="cinder-copyable-value" ${style}><span class="cinder-copyable-value__part"><span class="cinder-copyable-value__piece">127.</span><span class="cinder-copyable-value__piece">0.</span><span class="cinder-copyable-value__piece">0.</span><span class="cinder-copyable-value__piece">1:</span></span><span class="cinder-copyable-value__part">723<span class="cinder-copyable-value__end">3<span class="cinder-copyable-value__control"><button class="cinder-copy-button" data-cinder-appearance="inline" aria-label="Copy"><svg width="12" height="12"></svg></button></span></span></span></span>`;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
      await page.setContent(`
        <style>
          :root { --cinder-font-mono: ui-monospace, monospace; }
          body { margin: 0; font: 14px/20px sans-serif; }
        </style>
        <p id="mono">${copyableValue('')}</p>
        <p id="proportional">${copyableValue('style="font-family: sans-serif"')}</p>
        <p>12:30</p><p>10:45</p><p>9:05</p>
        <p>localhost:3000</p><p>127.0.0.1:8080</p><p>api.example.com:443</p>
      `);
      await page.addStyleTag({ content: stylesheet });
      const facts = await page.evaluate(collectGeometryFacts);

      const split = facts.identifiers.filter((entry) => entry.text === '127.0.0.1:7233');
      expect(split.map((entry) => [entry.name, entry.family === entry.mono])).toEqual([
        ['span.cinder-copyable-value', true],
        ['span.cinder-copyable-value', false],
      ]);
      expect(split[0]?.family).toBe('ui-monospace');
      expect(split[1]?.family).toBe('sans-serif');
    } finally {
      await browser.close();
    }
  });

  it('reads a host and port as an identifier and a clock time as prose', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
      await page.setContent(`
        <style>:root { --cinder-font-mono: ui-monospace, monospace; }</style>
        <p>12:30</p><p>10:45</p><p>9:05</p>
        <p>localhost:3000</p><p>127.0.0.1:8080</p><p>api.example.com:443</p>
      `);
      const facts = await page.evaluate(collectGeometryFacts);
      expect(facts.identifiers.map((entry) => entry.text)).toEqual([
        'localhost:3000',
        '127.0.0.1:8080',
        'api.example.com:443',
      ]);
    } finally {
      await browser.close();
    }
  });

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
