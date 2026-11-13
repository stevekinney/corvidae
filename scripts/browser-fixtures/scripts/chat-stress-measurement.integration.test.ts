import { chromium } from '@playwright/test';
import { describe, expect, it } from 'bun:test';

import {
  attachmentTargetReached,
  locate,
  measureInPage,
  readFailureSummaryProblems,
  readRepeatedSummaryProblems,
  readWithdrawal,
  revealScrollableControls,
  runStep,
  waitForCaptureLayout,
} from './capture-chat-stress.ts';

describe('chat stress visual measurement', () => {
  describe('repeated rollup guard', () => {
    // The real mechanism of `tool-call-timeline.svelte`: the summary becomes a two-column grid, the
    // count spans the first row, and the tool/count and duration share the second row.
    const rollup = (toolsStyle: string): string => `
      <style>
        body { margin: 0; }
        .chat-tool-call-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; font: 12px monospace; }
        .chat-tool-call-summary-count { grid-column: 1 / -1; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chat-tool-call-summary-tools { grid-column: 1; grid-row: 2; max-inline-size: 100%; white-space: nowrap; ${toolsStyle} }
        .chat-tool-call-summary-duration { grid-column: 2; grid-row: 2; white-space: nowrap; }
      </style>
      <main data-testid="chat-stress-shell" style="width:320px">
        <section class="chat-tool-call-timeline" data-cinder-tool-call-count="20" data-has-repeated-summary="true">
          <span class="chat-tool-call-summary">
            <span class="chat-tool-call-summary-count">Looked up twenty orders</span>
            <span class="chat-tool-call-summary-tools">lookup_order ×20</span>
            <span class="chat-tool-call-summary-duration">6s</span>
          </span>
        </section>
      </main>`;

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
        await page.setContent(markup);
        return await readRepeatedSummaryProblems(page);
      } finally {
        await browser.close();
      }
    };

    it('passes when the tool/count and duration are fully painted', async () => {
      expect(await problemsFor(rollup(''))).toEqual([]);
    });

    it('fails when the tool/count is display: none', async () => {
      expect(await problemsFor(rollup('display: none;'))).toContain(
        'repeated summary tool/count is not painted',
      );
    });

    it('fails when an ellipsis clips the tool/count in a too-narrow container', async () => {
      expect(
        await problemsFor(
          rollup(
            'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-inline-size: 60px;',
          ),
        ),
      ).toContain('repeated summary tool/count is clipped');
    });
  });

  describe('failed step guard', () => {
    // The real mechanism of the narrow-container rule: the row is a three-column grid and the status
    // and duration both live in the last column, each in a row of its own.
    const failedRow = (durationArea: string): string => `
      <style>
        body { margin: 0; }
        .chat-tool-call-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; row-gap: 4px; inline-size: 100%; font: 12px monospace; }
        .chat-tool-call-label { grid-column: 2; grid-row: 1; }
        .chat-tool-call-name { grid-column: 2; grid-row: 2; }
        .chat-tool-call-duration { grid-area: ${durationArea}; white-space: nowrap; }
      </style>
      <main data-testid="chat-stress-shell" style="width:320px">
        <ol>
          <li class="chat-tool-call-item" data-cinder-tool-call-status="failed">
            <button class="chat-tool-call-row" type="button">
              <span>x</span>
              <span class="chat-tool-call-label">Looked up an order</span>
              <code class="chat-tool-call-name">lookup_order</code>
              <span class="chat-tool-call-duration">1m</span>
            </button>
          </li>
        </ol>
      </main>`;

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
        await page.setContent(markup);
        return await readFailureSummaryProblems(page);
      } finally {
        await browser.close();
      }
    };

    it('fails when the tool name and duration share one grid cell', async () => {
      expect(await problemsFor(failedRow('2 / 2 / 3 / 4'))).toContain(
        'failed step tool overlaps duration',
      );
    });

    it('passes when the duration sits beside the tool name in its own column', async () => {
      expect(await problemsFor(failedRow('2 / 3 / 3 / 4'))).toEqual([]);
    });
  });

  it('proves scroll-reveal for a clipped control and rejects fixed-mask interception', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <style>*, *::before, *::after { box-sizing:border-box } body { margin:0 }</style>
        <main data-testid="chat-stress-shell">
          <div class="scroll" style="height:44px; overflow:auto">
            <button data-chat-stress-control-id="control-0" aria-label="Copy" style="margin-top:80px; width:120px; height:44px">Copy</button>
          </div>
          <div class="masked" style="height:44px; overflow:auto">
            <button data-chat-stress-control-id="control-1" aria-label="Copy" style="margin-top:80px; width:120px; height:44px">Copy</button>
          </div>
          <div class="unscrollable" style="height:44px; overflow:hidden">
            <button data-chat-stress-control-id="control-2" aria-label="Copy" style="margin-top:80px; width:120px; height:44px">Copy</button>
          </div>
          <div class="fixed-mask" style="position:fixed; left:0; top:44px; width:200px; height:44px; pointer-events:auto"></div>
        </main>
      `);
      const proof = await page.evaluate(revealScrollableControls, [
        'control-0',
        'control-1',
        'control-2',
      ]);
      expect(proof).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            controlId: 'control-0',
            name: 'Copy',
            initiallyClipped: true,
            revealed: true,
            samplesHitTarget: true,
          }),
          expect.objectContaining({
            controlId: 'control-1',
            name: 'Copy',
            initiallyClipped: true,
            revealed: true,
            samplesHitTarget: false,
          }),
        ]),
      );
      expect(proof).toContainEqual(
        expect.objectContaining({
          controlId: 'control-2',
          initiallyClipped: true,
          revealed: false,
          samplesHitTarget: false,
        }),
      );
    } finally {
      await browser.close();
    }
  });

  it('reveals a control at the centre of its scroller, clear of a floating corner button', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      const scroller = (identifier: string) => `
        <div style="height:300px; overflow:auto">
          <div style="height:500px"></div>
          <button data-chat-stress-control-id="${identifier}" aria-label="Copy" style="width:80px; height:32px">Copy</button>
          <div style="height:500px"></div>
        </div>`;
      await page.setContent(`
        <style>*, *::before, *::after { box-sizing:border-box } body { margin:0 }</style>
        <main data-testid="chat-stress-shell">
          ${scroller('edge')}
          <div style="position:fixed; left:0; top:256px; width:200px; height:44px"></div>
        </main>
      `);
      // The nearest-edge position (bottom of the scroller) sits under the floating button; the centre does not.
      expect(await page.evaluate(revealScrollableControls, ['edge'])).toEqual([
        expect.objectContaining({ controlId: 'edge', revealed: true, samplesHitTarget: true }),
      ]);
      await page.setContent(`
        <style>*, *::before, *::after { box-sizing:border-box } body { margin:0 }</style>
        <main data-testid="chat-stress-shell">
          ${scroller('covered')}
          <div style="position:fixed; left:0; top:0; width:200px; height:300px"></div>
        </main>
      `);
      expect(await page.evaluate(revealScrollableControls, ['covered'])).toEqual([
        expect.objectContaining({ controlId: 'covered', revealed: true, samplesHitTarget: false }),
      ]);
    } finally {
      await browser.close();
    }
  });

  it('holds a coarse attachment control to its hit area on all four sides, excusing a neighbouring control', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      const row = (between: string, surround: string): string => `
        <style>
          *, *::before, *::after { box-sizing:border-box } body { margin:0 }
          .row { display:flex; align-items:center; gap:4px; padding:40px; ${surround} }
          .row button { width:28px; height:28px; padding:0; position:relative }
          .row button.target::after { content:''; position:absolute; left:50%; top:50%; width:${between}; height:44px; transform:translate(-50%,-50%) }
        </style>`;
      const reached = async (markup: string): Promise<boolean> => {
        await page.setContent(markup);
        return page.locator('.target').evaluate(attachmentTargetReached);
      };
      // Reaches 44px in both axes, with other controls beside it: every probe lands on a control.
      expect(
        await reached(
          `${row('44px', '')}<div class="row"><button>A</button><button class="target">B</button><button>C</button></div>`,
        ),
      ).toBe(true);
      // The hit area stops short horizontally and plain space lies beside it: a tap there reaches nothing.
      expect(
        await reached(`${row('28px', '')}<div class="row"><button class="target">B</button></div>`),
      ).toBe(false);
      // A neighbour overlapping the horizontal reach is excused only because it is another control.
      expect(
        await reached(
          `${row('28px', '')}<div class="row"><button>A</button><button class="target">B</button><span style="display:block;width:28px;height:28px"></span></div>`,
        ),
      ).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it('scrolls an inner user-scrollport through an outer hidden clip', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <style>body { margin:0 } *, *::before, *::after { box-sizing:border-box }</style>
        <main data-testid="chat-stress-shell">
          <div style="height:44px; overflow:hidden">
            <div style="height:44px; overflow:auto">
              <button data-chat-stress-control-id="nested" aria-label="Nested" style="margin-top:20px; width:120px; height:44px">Nested</button>
            </div>
          </div>
        </main>
      `);
      expect(await page.evaluate(revealScrollableControls, ['nested'])).toEqual([
        expect.objectContaining({ controlId: 'nested', revealed: true, samplesHitTarget: true }),
      ]);
    } finally {
      await browser.close();
    }
  });

  it('measures the visible question dock and safe-area override, and preserves RTL direction evidence', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
      await page.setContent(`
        <style>body { margin:0 } *, *::before, *::after { box-sizing:border-box }</style>
        <main data-testid="chat-stress-shell">
          <section class="chat-timeline" style="width:280px; height:120px; padding:0 16px"></section>
          <div class="chat-input-area" style="width:280px; height:80px; --_cinder-chat-safe-area-inset-bottom:0px; padding-block-end:8px">
            <div class="chat-input-shell" style="display:none"></div>
            <div data-chat-question-dock style="width:280px; height:80px"></div>
          </div>
          <p dir="rtl">سياسة الاسترداد</p>
          <p dir="ltr">Review sources</p>
        </main>
      `);
      const baseline = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: true,
        settledApproval: false,
      });
      expect(baseline.readingEdges).toEqual({
        transcriptLeft: 16,
        transcriptRight: 264,
        composerLeft: 0,
        composerRight: 280,
      });
      expect(baseline.composerEdge).toBe(200);
      expect(baseline.safeArea).toEqual({ inset: 0, paddingBottom: 8 });
      expect(baseline.directions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'سياسة الاسترداد', direction: 'rtl' }),
        ]),
      );

      await page.locator('.chat-input-area').evaluate((element) => {
        element.setAttribute(
          'style',
          `${element.getAttribute('style')}; --_cinder-chat-safe-area-inset-bottom:24px; padding-block-end:32px`,
        );
      });
      const overridden = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: true,
        settledApproval: false,
      });
      expect(overridden.safeArea).toEqual({ inset: 24, paddingBottom: 32 });
      expect(overridden.safeArea!.paddingBottom - baseline.safeArea!.paddingBottom).toBe(24);
    } finally {
      await browser.close();
    }
  });

  it('checks the real streaming assistant article and body, not a guessed message selector', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<main data-testid="chat-stress-shell" data-chat-stress-streaming="true" data-chat-stress-stream-content=""><div class="chat-typing-indicator" aria-label="Assistant is typing" style="height:20px"></div><button data-stop style="height:44px">Stop</button><article class="chat-message" data-message-role="assistant" aria-busy="true"><div class="chat-message-body"></div></article></main>',
      );
      await runStep(page, { action: 'expect-empty-streaming-assistant' });
      await page
        .locator('.chat-message-body')
        .evaluate((element) => (element.textContent = 'The ledger is ready.'));
      await runStep(page, {
        action: 'expect-streaming-assistant-text',
        text: 'The ledger is ready.',
      });
    } finally {
      await browser.close();
    }
  });

  it('waits for the post-font resize delivery and completes without a composer', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(
        '<main data-testid="chat-stress-shell"><div class="chat-input" /></main>',
      );
      await page.evaluate(() => {
        let trigger: (() => void) | undefined;
        class DeferredResizeObserver {
          constructor(callback: ResizeObserverCallback) {
            trigger = () => callback([], this);
          }
          observe(): void {
            (
              window as typeof window & { __triggerCaptureResize?: (() => void) | undefined }
            ).__triggerCaptureResize = trigger;
          }
          disconnect(): void {}
          unobserve(): void {}
        }
        Object.defineProperty(window, 'ResizeObserver', {
          configurable: true,
          value: DeferredResizeObserver,
        });
      });
      let settled = false;
      const pending = waitForCaptureLayout(page).then(() => {
        settled = true;
      });
      await page.waitForFunction(
        () =>
          typeof (window as typeof window & { __triggerCaptureResize?: () => void })
            .__triggerCaptureResize === 'function',
      );
      expect(settled).toBe(false);
      await page.evaluate(() =>
        (
          window as typeof window & { __triggerCaptureResize?: () => void }
        ).__triggerCaptureResize?.(),
      );
      await pending;
      expect(settled).toBe(true);

      await page.setContent('<main data-testid="chat-stress-shell"></main>');
      await waitForCaptureLayout(page);
    } finally {
      await browser.close();
    }
  });

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

  it('recognizes the next remaining source chip as the withdrawal focus', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.setContent(
        '<main data-testid="chat-stress-shell"><span class="chat-message-source-chips"><button class="cinder-citation__marker">Support playbook</button></span></main><style>.cinder-citation__marker:focus-visible { outline: 2px solid #06f; }</style>',
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

  it('keeps target size and reachable hit evidence for a partially clipped control', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <style>body { margin:0 } *, *::before, *::after { box-sizing:border-box }</style>
        <main data-testid="chat-stress-shell">
          <div style="height:40px; overflow:hidden">
            <button style="position:relative; top:20px; width:120px; height:44px">Partially visible</button>
          </div>
        </main>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      const control = measurement.controlGeometry?.find(
        (entry) => entry.name === 'Partially visible',
      );
      expect(control?.hitHeight).toBe(44);
      expect(control?.reachableHeight).toBe(20);
      expect(control?.samples.length).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  it('keeps same-name hit failures associated with their exact control after one reveal passes', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <style>body { margin:0 } *, *::before, *::after { box-sizing:border-box }</style>
        <main data-testid="chat-stress-shell">
          <div style="height:44px; overflow:auto"><button aria-label="Copy" style="margin-top:20px; width:120px; height:44px">Copy</button></div>
          <div style="height:44px; overflow:auto"><button aria-label="Copy" style="margin-top:20px; width:120px; height:44px">Copy</button></div>
          <div style="position:fixed; left:0; top:64px; width:200px; height:24px"></div>
        </main>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      const controls = measurement.controlGeometry ?? [];
      expect(controls.map((control) => control.name)).toEqual(['Copy', 'Copy']);
      const failures = controls.filter((control) =>
        control.samples.some((sample) => !sample.hitsTarget),
      );
      expect(failures).toHaveLength(1);
      const proof = await page.evaluate(
        revealScrollableControls,
        controls.map((control) => control.controlId),
      );
      expect(proof.filter((entry) => entry.revealed && entry.samplesHitTarget)).toHaveLength(1);
      expect(proof.filter((entry) => !entry.revealed || !entry.samplesHitTarget)).toHaveLength(1);
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

  it('assigns control identities in shell-then-portal order for identical names', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      await page.setContent(`
        <main data-testid="chat-stress-shell"><button aria-label="Choose">Choose</button></main>
        <div role="dialog" aria-label="Menu" style="position:fixed; inset:40px; background:white">
          <button aria-label="Choose">Choose</button>
        </div>
      `);
      const measurement = await page.evaluate(measureInPage, {
        coarse: true,
        rtl: false,
        settledApproval: false,
      });
      expect(
        measurement.controlGeometry?.map(({ controlId, name }) => ({ controlId, name })),
      ).toEqual([
        { controlId: 'control-0', name: 'Choose' },
        { controlId: 'control-1', name: 'Choose' },
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
  describe('touch target hit area', () => {
    // The real mechanism of Cinder's Button (`button.css`): the box is the painted face, and a
    // positioned pseudo-element reaches 44px without taking layout space.
    const hitStyle = `
      <style>
        body { margin: 0; }
        main { padding: 40px; }
        .cinder-button { position: relative; display: inline-block; box-sizing: border-box; width: 24px; height: 24px; padding: 0; border: 0; background: #ccc; vertical-align: top; }
        .cinder-button[data-cinder-hit-target='44']::before {
          content: ''; position: absolute;
          inset-block: min(0px, calc((100% - 44px) / 2));
          inset-inline: min(0px, calc((100% - 44px) / 2));
        }
      </style>`;
    const smallTargetsFor = async (buttons: string) => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
        await page.setContent(`${hitStyle}<main data-testid="chat-stress-shell">${buttons}</main>`);
        const measurement = await page.evaluate(measureInPage, {
          coarse: true,
          rtl: false,
          settledApproval: false,
        });
        return measurement.smallTargets;
      } finally {
        await browser.close();
      }
    };

    it('passes a 24px button whose hit pseudo-element reaches 44px', async () => {
      expect(
        await smallTargetsFor(
          '<button class="cinder-button" data-cinder-hit-target="44" aria-label="Copy"></button>',
        ),
      ).toEqual([]);
    });

    it('fails the same 24px button without the pseudo-element, naming the control and its sides', async () => {
      const targets = await smallTargetsFor(
        '<button class="cinder-button" aria-label="Copy"></button>',
      );
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        name: 'Copy',
        width: 24,
        height: 24,
      });
      expect(targets[0]?.shortSides?.map((side) => side.split(' ')[0])).toEqual([
        'left',
        'right',
        'above',
        'below',
      ]);
    });

    it('fails a hit area cut off by an overflow: hidden parent', async () => {
      const targets = await smallTargetsFor(
        '<div style="width:24px;height:24px;overflow:hidden"><button class="cinder-button" data-cinder-hit-target="44" aria-label="Copy"></button></div>',
      );
      expect(targets).toHaveLength(1);
      expect(targets[0]?.name).toBe('Copy');
    });

    it("passes a button whose hit area is covered by the next button's own hit area just short of the probe radius", async () => {
      // The second button's centre is 43.25px below the first's: its 44px area starts 21.75px from
      // the first's centre, so the probe at 21.5px lands in it. That is the neighbour's tap, and a
      // distance test with the probe radius would have missed it by a quarter pixel.
      expect(
        await smallTargetsFor(
          `<button class="cinder-button" data-cinder-hit-target="44" aria-label="Continue"></button><br><button class="cinder-button" data-cinder-hit-target="44" aria-label="Quote" style="margin-block-start:19.25px"></button>`,
        ),
      ).toEqual([]);
    });

    it('fails a 44px control whose face is partly covered by a neighbouring control', async () => {
      // The neighbour sits over the right half of the first button's own face, so a tap there
      // never reaches it. That is a defect, unlike a neighbour's hit area beyond the box.
      const targets = await smallTargetsFor(
        `<button class="cinder-button" aria-label="Under" style="width:44px;height:44px"></button><button class="cinder-button" aria-label="Over" style="position:absolute;left:72px;top:40px;width:44px;height:44px"></button>`,
      );
      const under = targets.find((target) => target.name === 'Under');
      expect(under?.shortSides?.map((side) => side.split(' ')[0])).toContain('right');
    });

    it('passes two touching 44px buttons whose hit pseudo-elements sit on the shared edge', async () => {
      // A bordered 44px button (Cinder's) has a pseudo-element offset by its border, so its
      // region is exactly its box; the neighbour starts where it ends.
      const bordered = 'width:44px;height:44px;border:1px solid #999;';
      expect(
        await smallTargetsFor(
          `<button class="cinder-button" data-cinder-hit-target="44" aria-label="Edit" style="${bordered}"></button><button class="cinder-button" data-cinder-hit-target="44" aria-label="Remove" style="${bordered}"></button>`,
        ),
      ).toEqual([]);
    });

    it('passes two adjacent 24px buttons at a 28px pitch, whose hit areas overlap by design', async () => {
      expect(
        await smallTargetsFor(
          `<button class="cinder-button" data-cinder-hit-target="44" aria-label="Copy"></button><button class="cinder-button" data-cinder-hit-target="44" aria-label="Retry" style="margin-inline-start:4px"></button>`,
        ),
      ).toEqual([]);
    });
  });
});
