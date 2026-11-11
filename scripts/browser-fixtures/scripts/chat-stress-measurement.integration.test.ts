import { chromium } from '@playwright/test';
import { describe, expect, it } from 'bun:test';

import { locate, measureInPage, readWithdrawal, runStep } from './capture-chat-stress.ts';

describe('chat stress visual measurement', () => {
  it('recognizes a focus ring painted by a pseudo-element after withdrawal', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(
        '<main data-testid="chat-stress-shell"><button class="chat-message-action-button">Open source</button></main><style>.chat-message-action-button:focus-visible { outline: none; box-shadow: none; position: relative; }.chat-message-action-button:focus-visible::before { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 2px #06f; }</style>',
      );
      await page.locator('button').focus();
      const measurement = await page.evaluate(readWithdrawal);
      expect(measurement.focusVisible).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('rejects a focused action whose pseudo-element focus face is hidden', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(
        '<main data-testid="chat-stress-shell"><button class="chat-message-action-button">Open source</button></main><style>.chat-message-action-button:focus-visible { outline: none; box-shadow: none; position: relative; }.chat-message-action-button:focus-visible::before { content: ""; position: absolute; inset: 0; box-shadow: none; opacity: 0; }</style>',
      );
      await page.locator('button').focus();
      const measurement = await page.evaluate(readWithdrawal);
      expect(measurement.focusVisible).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it('reports masked ancestors, pointer-transparent fades, and code Copy overlap', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell" style="position:relative; height:640px">
          <section class="masked" style="position:relative; width:200px; height:180px; mask-image:linear-gradient(#000,#000)">
            <button style="margin-top:40px">Approve</button>
            <div class="fade" style="position:absolute; inset:0; pointer-events:none"></div>
          </section>
          <section style="position:relative; width:200px; height:80px; mask-image:linear-gradient(#000,#000)">
            <button>Refund $42.00</button>
          </section>
          <section style="width:200px; height:80px; background:linear-gradient(#fff,#eee)">
            <button>Deny</button>
          </section>
          <section class="cinder-code-block" data-cinder-markdown-kind="code-block" style="position:relative; width:240px; height:120px">
            <pre style="margin:0; width:240px; height:120px">total = 42</pre>
            <button aria-label="Copy" style="position:absolute; right:0; top:0">Copy</button>
          </section>
        </main>
        <style>.fade::after { content:""; position:absolute; inset:0; background:linear-gradient(transparent,#fff); }</style>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(measurement.occlusions?.map((entry) => entry.target)).toEqual(
        expect.arrayContaining(['Approve', 'Copy']),
      );
      expect(measurement.occlusions?.map((entry) => entry.target)).not.toEqual(
        expect.arrayContaining(['Refund $42.00', 'Deny']),
      );
      expect(
        measurement.controlGeometry?.every((control) =>
          control.samples.every((sample) => sample.hitsTarget),
        ),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('reports an inset pseudo-element face separately from a 44px hit region', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell">
          <button data-cinder-hit-target="44" aria-label="Refund $42.00">Refund $42.00</button>
        </main>
        <style>
          button { position: relative; width: 120px; height: 44px; background: transparent; border: 0; }
          button::before { content: ''; position: absolute; inset: 8px 0; background: #f00; }
        </style>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      const control = measurement.controlGeometry?.[0];
      expect(control?.hitHeight).toBe(44);
      expect(control?.paintedHeight).toBe(28);
    } finally {
      await browser.close();
    }
  });

  it('ignores clipped and modal-background controls but reports a reachable obstruction', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell">
          <div class="scroll" style="height:40px; overflow:auto"><button style="margin-top:100px">Offscreen</button></div>
          <button class="background">Background</button>
          <div role="dialog" aria-modal="true"><button>Dialog action</button></div>
        </main>
      `);
      const modalMeasurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(modalMeasurement.controlGeometry?.map((control) => control.name)).toEqual([
        'Dialog action',
      ]);

      await page.setContent(`
        <main data-testid="chat-stress-shell" style="position:relative; height:640px">
          <button>Approve</button>
          <div class="fade" style="position:absolute; inset:0; pointer-events:none"></div>
        </main>
        <style>.fade::after { content:""; position:absolute; inset:0; background:linear-gradient(transparent,#fff); }</style>
      `);
      const obstructed = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(obstructed.occlusions?.some((entry) => entry.target === 'Approve')).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('keeps nonmodal popovers interactive and clips each axis independently', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell">
          <div class="scroll-x" style="width:40px; overflow-x:auto; overflow-y:visible"><button style="margin-left:100px">Vertical action</button></div>
          <div role="dialog"><button>Popover action</button></div>
        </main>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(measurement.controlGeometry?.map((control) => control.name)).toEqual([
        'Popover action',
      ]);
    } finally {
      await browser.close();
    }
  });

  it('measures active portaled surfaces without measuring inert background controls', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell"><button>Background</button></main>
        <div role="dialog" aria-modal="true" aria-label="Sources" style="position:fixed; inset:40px; background:white">
          <section class="cinder-citation__panel" aria-label="Sources">
            <a href="https://example.com">Open example.com</a>
            <button aria-label="Previous source">Previous source</button>
            <button aria-label="Next source">Next source</button>
          </section>
        </div>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(measurement.controlGeometry?.map((control) => control.name)).toEqual([
        'Open example.com',
        'Previous source',
        'Next source',
      ]);
    } finally {
      await browser.close();
    }
  });

  it('compares Copy against the clipped code viewport, not an overflowing pre', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell">
          <section class="cinder-code-block cinder-code-block--floating-meta" style="display:grid; grid-template-columns:200px 40px; width:240px; height:120px; overflow:hidden">
            <div class="cinder-code-block__meta" style="grid-column:2; grid-row:1"><button aria-label="Copy">Copy</button></div>
            <div class="cinder-code-block__viewport" style="grid-column:1; grid-row:1; overflow:auto"><pre style="margin:0; width:480px; height:120px">total = 42</pre></div>
          </section>
        </main>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(measurement.occlusions?.some((entry) => entry.target === 'Copy')).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it('keeps scoped expectation locators from matching identical controls outside the scope', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell">
          <button>Choose</button>
          <fieldset class="expected"><button>Choose</button></fieldset>
        </main>
      `);
      const scoped = locate(page, {
        action: 'expect',
        role: 'button',
        name: 'Choose',
        scope: 'fieldset.expected',
      });
      expect(await scoped.count()).toBe(1);
      expect(await scoped.first().evaluate((element) => element.closest('fieldset') !== null)).toBe(
        true,
      );
    } finally {
      await browser.close();
    }
  });

  it('preserves partial text expectations while supporting scoped exact witnesses', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell">
          <p>Loading conversation…</p>
          <fieldset class="question"><p>Which ledger should?</p></fieldset>
        </main>
      `);
      await runStep(page, { action: 'expect-text', text: 'Loading conversation' });
      await runStep(page, {
        action: 'expect-text',
        text: 'Which ledger should?',
        scope: 'fieldset.question',
        exact: true,
      });
    } finally {
      await browser.close();
    }
  });

  it('uses background clip when measuring a control face', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell">
          <button class="border-box">Border box</button>
          <button class="padding-box">Padding box</button>
        </main>
        <style>
          button { width:100px; height:44px; border:8px solid transparent; }
          .border-box { background:#f00; background-clip:border-box; }
          .padding-box { background:#f00; background-clip:padding-box; }
        </style>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(measurement.controlGeometry?.map((control) => control.paintedHeight)).toEqual([
        44, 28,
      ]);
    } finally {
      await browser.close();
    }
  });
});
