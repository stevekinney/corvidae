import { chromium } from '@playwright/test';
import { describe, expect, it } from 'bun:test';

import {
  locate,
  measureInPage,
  readActionRowProblems,
  readAttachmentStripProblems,
  readCalloutGaps,
  readCalloutSpacingProblems,
  readFailureSummaryProblems,
  readIconCentreProblems,
  readIconSizeProblems,
  readLabelFitProblems,
  readNarrationFoldProblems,
  readNarrationStyleProblems,
  readQuestionStepsProblems,
  readRepeatedSummaryProblems,
  readStepRowSpacing,
  readWithdrawal,
  revealScrollableControls,
  runStep,
  stepRowSpacingProblems,
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

  describe('question steps guard', () => {
    // The real mechanism of the dock's header with several questions: a wrapping row, the tag at
    // the leading end, the progress with its two compact buttons pushed to the trailing end, and
    // the question taking the full width on its own line.
    const dock = (options: {
      progress?: string;
      previousDisabled?: boolean;
      nextDisabled?: boolean;
      width?: number;
      stepsFirst?: boolean;
    }): string => {
      const tag =
        '<span class="chat-question-dock-needs" data-chat-question-needs>Needs you</span>';
      const steps = `<div class="chat-question-dock-steps"><span data-chat-question-progress>${options.progress ?? 'Question 2 of 4'}</span><button data-chat-question-previous ${options.previousDisabled ? 'disabled' : ''}>p</button><button data-chat-question-next ${options.nextDisabled ? 'disabled' : ''}>n</button></div>`;
      return `
        <style>
          body { margin: 0; font: 13px sans-serif; }
          * { box-sizing: border-box; }
          [data-chat-question-heading] { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; width: ${options.width ?? 296}px; }
          .chat-question-dock-needs { flex: none; white-space: nowrap; padding: 2px 8px; }
          .chat-question-dock-steps { display: inline-flex; margin-inline-start: auto; gap: 4px; align-items: center; }
          .chat-question-dock-steps button { width: 28px; height: 28px; padding: 0; }
          .chat-question-dock-question { flex: 1 0 100%; margin: 0; }
        </style>
        <div data-chat-question-dock>
          <div data-chat-question-heading data-chat-question-several>
            ${options.stepsFirst ? steps + tag : tag + steps}
            <p class="chat-question-dock-question">Which region?</p>
          </div>
          <div role="radio" aria-checked="false">East</div>
        </div>`;
    };

    const problemsFor = async (markup: string, position = 2, total = 4): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
        await page.setContent(markup);
        return await readQuestionStepsProblems(page, position, total);
      } finally {
        await browser.close();
      }
    };

    it('passes for the second of four, with both buttons on', async () => {
      expect(await problemsFor(dock({}))).toEqual([]);
    });

    it('passes for the first, with previous off, and the last, with next off', async () => {
      expect(
        await problemsFor(dock({ progress: 'Question 1 of 4', previousDisabled: true }), 1, 4),
      ).toEqual([]);
      expect(
        await problemsFor(dock({ progress: 'Question 4 of 4', nextDisabled: true }), 4, 4),
      ).toEqual([]);
    });

    it('fails when the progress reads another question', async () => {
      expect(await problemsFor(dock({ progress: 'Question 3 of 4' }))).toEqual([
        expect.stringContaining('the progress reads'),
      ]);
    });

    it('fails when previous stays on at the first question or next at the last', async () => {
      expect(await problemsFor(dock({ progress: 'Question 1 of 4' }), 1, 4)).toContain(
        'previous is on at question 1',
      );
      expect(await problemsFor(dock({ progress: 'Question 4 of 4' }), 4, 4)).toContain(
        'next is on at question 4',
      );
    });

    it('fails when a button is off in the middle', async () => {
      expect(await problemsFor(dock({ nextDisabled: true }))).toContain(
        'next is off at question 2',
      );
    });

    it('fails when the progress comes before the tag in the document', async () => {
      expect(await problemsFor(dock({ stepsFirst: true }))).toContain(
        'the tag, progress, buttons and choices are not in that order',
      );
    });

    it('fails when the row is too narrow and the buttons wrap below the tag', async () => {
      expect(await problemsFor(dock({ width: 150 }))).toContain(
        'the tag, the progress and the buttons are not on one line',
      );
    });
  });

  describe('label fit guard', () => {
    // The real mechanism of the approval card's action row: the note toggle's tooltip wrapper is
    // centred, Deny and the primary stretch, a visually hidden live region sits one pixel above the
    // line, and InlineConfirm's wrapper makes no box of its own. The words are a nowrap label; the
    // attribute hides them.
    const actionRow = (width: number, attribute: string): string => `
      <style>
        body { margin: 0; }
        .cinder-approval-card__row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; gap: 4px; row-gap: 12px; width: ${width}px; font: 13px monospace; }
        .cinder-tooltip-wrapper { flex: none; align-self: center; margin-inline-end: auto; padding-inline-end: 8px; }
        .cinder-approval-card__note-toggle { display: inline-flex; height: 28px; white-space: nowrap; }
        .cinder-approval-card__note-toggle[data-cinder-note-compact] .cinder-button__label { display: none; }
        .cinder-button { align-self: stretch; padding: 0 12px; }
        .cinder-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; }
        .cinder-inline-confirm__two-press { display: contents; }
      </style>
      <main data-testid="chat-stress-shell">
        <div class="cinder-approval-card__row-actions">
          <span class="cinder-tooltip-wrapper"><button class="cinder-approval-card__note-toggle" ${attribute}>ico <span class="cinder-button__label">Add note</span></button></span>
          <button class="cinder-button">Deny</button>
          <span class="cinder-sr-only">live</span>
          <span class="cinder-inline-confirm__two-press"><button class="cinder-button">Refund $42.00</button></span>
        </div>
      </main>`;

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(markup);
        return await readLabelFitProblems(page);
      } finally {
        await browser.close();
      }
    };

    // Runs the shipped attachment (its TypeScript with the exports dropped) on the row, starting
    // from the opposite state, and reports whether the control ended icon-only.
    const compactAfterFitting = async (width: number): Promise<boolean> => {
      const source = await Bun.file(
        new URL('../../../components/cinder/src/utilities/fit-label-to-row.ts', import.meta.url),
      ).text();
      const script = new Bun.Transpiler({ loader: 'ts' })
        .transformSync(source)
        .replace(/^export /gmu, '');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(actionRow(width, ''));
        await page.addScriptTag({ content: script });
        return await page.evaluate(() => {
          const fit = (
            window as unknown as {
              createLabelFit: (options: {
                control: string;
                attribute: string;
              }) => (row: HTMLElement) => unknown;
            }
          ).createLabelFit;
          const row = document.querySelector<HTMLElement>('.cinder-approval-card__row-actions')!;
          const control = row.querySelector('.cinder-approval-card__note-toggle')!;
          control.setAttribute('data-cinder-note-compact', '');
          fit({
            control: '.cinder-approval-card__note-toggle',
            attribute: 'data-cinder-note-compact',
          })(row);
          return control.hasAttribute('data-cinder-note-compact');
        });
      } finally {
        await browser.close();
      }
    };

    it('the shipped attachment shows the words on a row that holds them, though a centred control and a hidden live region sit at other tops', async () => {
      expect(await compactAfterFitting(390)).toBe(false);
    });

    it('the shipped attachment goes icon-only on a row that cannot hold the words', async () => {
      expect(await compactAfterFitting(200)).toBe(true);
    });

    it('passes when the words show and the row holds them on one line', async () => {
      expect(await problemsFor(actionRow(390, ''))).toEqual([]);
    });

    it('fails when the control is icon-only although the row has room for its words', async () => {
      expect(await problemsFor(actionRow(390, 'data-cinder-note-compact'))).toEqual([
        expect.stringContaining('is icon-only with room for its words'),
      ]);
    });

    it('fails when the words stay while the row is too narrow to hold them', async () => {
      expect(await problemsFor(actionRow(200, ''))).toEqual([
        expect.stringContaining('keeps its words while the row cannot hold them'),
      ]);
    });

    it('passes when the control is icon-only because the row is too narrow', async () => {
      expect(await problemsFor(actionRow(200, 'data-cinder-note-compact'))).toEqual([]);
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

  it('reveals a control no scroller clips when a floating button covers it, and not one that stays covered', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
      const scroller = (identifier: string) => `
        <div style="height:300px; overflow:auto">
          <div style="height:200px"></div>
          <button data-chat-stress-control-id="${identifier}" aria-label="Copy" style="width:80px; height:32px; margin-top:20px">Copy</button>
          <div style="height:800px"></div>
        </div>`;
      // Positive control: the button is inside the scrollport (not clipped) at y 220, and a floating
      // corner button covers its lower edge there; at the centre of the scroller nothing floats.
      await page.setContent(`
        <style>*, *::before, *::after { box-sizing:border-box } body { margin:0 }</style>
        <main data-testid="chat-stress-shell">
          ${scroller('under-pill')}
          <div style="position:fixed; left:0; top:236px; width:200px; height:44px"></div>
        </main>
      `);
      expect(await page.evaluate(revealScrollableControls, ['under-pill'])).toEqual([
        expect.objectContaining({
          controlId: 'under-pill',
          initiallyClipped: false,
          revealed: true,
          samplesHitTarget: true,
        }),
      ]);
      // Negative control: a control nothing covers and nothing clips needs no proof.
      await page.setContent(`
        <style>*, *::before, *::after { box-sizing:border-box } body { margin:0 }</style>
        <main data-testid="chat-stress-shell">${scroller('free')}</main>
      `);
      expect(await page.evaluate(revealScrollableControls, ['free'])).toEqual([]);
      // Negative control: a cover that stays over every scroll position is still reported missed.
      await page.setContent(`
        <style>*, *::before, *::after { box-sizing:border-box } body { margin:0 }</style>
        <main data-testid="chat-stress-shell">
          ${scroller('always-covered')}
          <div style="position:fixed; left:0; top:0; width:200px; height:300px"></div>
        </main>
      `);
      expect(await page.evaluate(revealScrollableControls, ['always-covered'])).toEqual([
        expect.objectContaining({ controlId: 'always-covered', samplesHitTarget: false }),
      ]);
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

  it('recognizes the next remaining source row as the withdrawal focus', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.setContent(
        '<main data-testid="chat-stress-shell"><section class="cinder-citation__panel"><a class="cinder-citation__row" href="/support-playbook">Support playbook</a></section></main><style>.cinder-citation__row:focus-visible { outline: 2px solid #06f; }</style>',
      );
      await page.locator('a').focus();
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

    it('passes a button whose 44px hit area meets a plain positioned block within a third of a pixel', async () => {
      // The block starts 9.7px under the face, 0.3px short of where the 44px area ends, and paints
      // above it. The probe sits half a pixel inside the area, within the engine's shared-edge
      // tolerance of the block's edge, so it answers the block: the same shared edge two touching
      // controls have, not a hit area cut short.
      expect(
        await smallTargetsFor(
          `<div style="height:24px;margin-block-end:9.7px"><button class="cinder-button" data-cinder-hit-target="44" aria-label="Copy"></button></div><div style="position:relative;height:20px">Details</div>`,
        ),
      ).toEqual([]);
    });

    it('fails a button whose hit area is cut short by a plain positioned block starting well inside it', async () => {
      const targets = await smallTargetsFor(
        `<div style="height:24px;margin-block-end:4px"><button class="cinder-button" data-cinder-hit-target="44" aria-label="Copy"></button></div><div style="position:relative;height:20px">Details</div>`,
      );
      expect(targets[0]?.shortSides?.map((side) => side.split(' ')[0])).toEqual(['below']);
    });

    it('passes two adjacent 24px buttons at a 28px pitch, whose hit areas overlap by design', async () => {
      expect(
        await smallTargetsFor(
          `<button class="cinder-button" data-cinder-hit-target="44" aria-label="Copy"></button><button class="cinder-button" data-cinder-hit-target="44" aria-label="Retry" style="margin-inline-start:4px"></button>`,
        ),
      ).toEqual([]);
    });
  });

  describe('action row guard', () => {
    // The real mechanism of a notice's action row: a padded, bordered container holding the text
    // and a flex row whose buttons are positioned by `justify-content` and `direction`.
    const notice = (rowStyle: string, direction = 'ltr', extra = ''): string => `
      <style>
        body { margin: 0; }
        .cinder-callout { box-sizing: border-box; inline-size: 320px; padding: 12px; border: 1px solid #999; direction: ${direction}; }
        .cinder-callout__action { display: flex; flex-wrap: wrap; gap: 8px; ${rowStyle} }
        button { font: 12px sans-serif; padding: 4px 12px; }
      </style>
      <div class="cinder-callout">
        <p>Stopped. The answer above is partial.</p>
        <div class="cinder-callout__action"><button>Discard</button><button>Continue</button></div>
        ${extra}
      </div>`;

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(markup);
        return await readActionRowProblems(page);
      } finally {
        await browser.close();
      }
    };

    it('passes a row that ends at the trailing content edge, primary last', async () => {
      expect(await problemsFor(notice('justify-content: flex-end;'))).toEqual([]);
    });

    it('passes the mirrored row in right-to-left, ending at the left content edge', async () => {
      expect(await problemsFor(notice('justify-content: flex-end;', 'rtl'))).toEqual([]);
    });

    it('fails a row that starts at the leading edge', async () => {
      const problems = await problemsFor(notice('justify-content: flex-start;'));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('action row .cinder-callout__action ends');
    });

    it('fails a wrapped primary left on a leading line, though an earlier control touches the trailing edge', async () => {
      // Discard fills the first line edge to edge, so the trailing-most control of the row touches
      // the edge; Continue, the last control, wraps to a second line that starts at the leading edge.
      const filling =
        '<style>.cinder-callout__action button:first-child { flex: 1 1 100%; }</style>';
      const problems = await problemsFor(notice('justify-content: flex-start;', 'ltr', filling));
      expect(problems).toHaveLength(1);
      // The same wrap with the second line ending at the trailing edge passes.
      expect(await problemsFor(notice('justify-content: flex-end;', 'ltr', filling))).toEqual([]);
    });

    it('measures a control that is itself the row, such as a submit button', async () => {
      const submit = (placement: string): string => `
        <style>
          body { margin: 0; }
          .chat-question-stack { display: grid; inline-size: 320px; padding: 12px; box-sizing: border-box; }
          button { font: 12px sans-serif; padding: 4px 12px; ${placement} }
        </style>
        <form class="chat-question-stack"><input aria-label="Answer"><button type="submit">Send</button></form>`;
      expect(await problemsFor(submit('justify-self: end;'))).toEqual([]);
      expect(await problemsFor(submit('justify-self: start;'))).toHaveLength(1);
    });

    it('fails a right-to-left row that starts at its leading (right) edge', async () => {
      const problems = await problemsFor(notice('justify-content: flex-start;', 'rtl'));
      expect(problems).toHaveLength(1);
    });

    it('stops short of a dismiss button that owns the callout trailing track', async () => {
      const dismissed = (rowStyle: string): string =>
        notice(
          rowStyle,
          'ltr',
          '<button class="cinder-callout__dismiss" style="position:absolute;top:12px;left:263px;width:32px;margin-inline-start:12px">x</button>',
        ).replace(
          '.cinder-callout {',
          '.cinder-callout { position: relative; padding: 12px 55px 12px 12px !important;',
        );
      expect(await problemsFor(dismissed('justify-content: flex-end;'))).toEqual([]);
      expect(await problemsFor(dismissed('justify-content: flex-start;'))).toHaveLength(1);
    });
  });

  describe('notice progress spacing guard', () => {
    // The real mechanism of a Callout: text, a progress line in a flex wrapper, and an action row,
    // with the margin above the bar and the grid gap below it as the two inputs.
    const notice = (barMargin: number, actionGap: number): string => `
      <style>
        body { margin: 0; font: 14px/21px sans-serif; }
        .cinder-callout { display: grid; row-gap: ${actionGap}px; inline-size: 320px; padding: 12px; box-sizing: border-box; }
        .cinder-callout__content p { margin: 0; }
        .cinder-callout__progress { display: flex; flex-direction: column; margin-block-start: ${barMargin}px; }
        .cinder-progress { block-size: 4px; background: #999; }
        .cinder-callout__action { display: flex; justify-content: flex-end; }
        button { font: 13px sans-serif; padding: 4px 12px; }
      </style>
      <div class="cinder-callout">
        <div class="cinder-callout__content">
          <p>Connection lost. Trying again in a moment.</p>
          <div class="cinder-callout__progress"><div class="cinder-progress" role="progressbar"></div></div>
        </div>
        <div class="cinder-callout__action"><button>Retry now</button></div>
      </div>`;

    const withPage = async <T>(
      markup: string,
      read: (page: import('@playwright/test').Page) => Promise<T>,
    ) => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(markup);
        return await read(page);
      } finally {
        await browser.close();
      }
    };

    it('passes a bar as far under the letters as above the action row', async () => {
      // 14px sans-serif on a 21px line leaves about 2px of leading under the letters.
      const gaps = await withPage(notice(10, 12), readCalloutGaps);
      expect(gaps).toHaveLength(1);
      expect(Math.abs(gaps[0]!.textToBar - gaps[0]!.barToAction)).toBeLessThanOrEqual(1);
      expect(await withPage(notice(10, 12), readCalloutSpacingProblems)).toEqual([]);
    });

    it('fails a bar that sits much nearer the action row than the text', async () => {
      const problems = await withPage(notice(22, 8), readCalloutSpacingProblems);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('under the text');
    });

    it('fails a bar that sits much nearer the text than the action row', async () => {
      expect(await withPage(notice(2, 24), readCalloutSpacingProblems)).toHaveLength(1);
    });
  });

  describe('icon size guard', () => {
    const row = (iconSize: number, extra = ''): string => `
      <style>
        body { margin: 0; font: 14px/20px sans-serif; }
        .row { display: flex; align-items: flex-start; gap: 8px; ${extra} }
        button { font: inherit; padding: 0; border: 0; }
        svg { flex: none; inline-size: ${iconSize}px; block-size: ${iconSize}px; }
      </style>
      <button class="row"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg><span>Read the October ledger</span></button>`;

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(markup);
        return await readIconSizeProblems(page);
      } finally {
        await browser.close();
      }
    };

    it('passes a 16px glyph beside 14px text on a 20px line', async () => {
      expect(await problemsFor(row(16))).toEqual([]);
    });

    it('fails a glyph taller than the text line beside it', async () => {
      const problems = await problemsFor(row(28));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('icon is 28.0px tall beside 14px text with a 20.0px line');
    });

    it('fails a glyph inside its own wrapper beside the text', async () => {
      const wrapped = row(28)
        .replace('<svg', '<span class="wrap"><svg')
        .replace('</svg>', '</svg></span>');
      expect(await problemsFor(wrapped)).toHaveLength(1);
    });

    it("does not measure an icon-only button against the next button's label", async () => {
      const neighbours = `
        <style>
          body { margin: 0; font: 13px/13px sans-serif; }
          .actions { display: flex; gap: 8px; align-items: center; }
          button { display: inline-flex; align-items: center; font: inherit; }
          svg { inline-size: 14px; block-size: 14px; }
        </style>
        <div class="actions">
          <button aria-label="Copy"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg></button>
          <button>Retry</button>
        </div>`;
      expect(await problemsFor(neighbours)).toEqual([]);
    });

    it('does not measure a glyph stacked above its text or a decorative one with no text beside it', async () => {
      expect(await problemsFor(row(48, 'flex-direction: column;'))).toEqual([]);
      const alone = row(48).replace('<span>Read the October ledger</span>', '');
      expect(await problemsFor(alone)).toEqual([]);
    });
  });

  describe('step row spacing guard', () => {
    const transcript = (stepToAnswer: number): string => `
      <style>
        body { margin: 0; font: 14px/20px sans-serif; }
        .chat-message-wrapper { display: block }
        .chat-message-body p { margin: 0 }
        .chat-message-line { margin-block-start: 12px; font: 12px/normal sans-serif }
        .chat-tool-call-toggle { display: block; padding: 0; border: 0; font: inherit }
        .answer { margin-block-start: ${stepToAnswer}px }
      </style>
      <div class="chat-message-wrapper">
        <div class="chat-message-body"><p>Check the refund queue.</p></div>
        <div class="chat-message-line"><time>8:00 AM</time></div>
      </div>
      <div><button class="chat-tool-call-toggle" aria-expanded="false">Compared 20 recent orders…</button></div>
      <div class="chat-message-wrapper answer">
        <div class="chat-message-body"><p>All of them match the ledger.</p></div>
      </div>`;

    const spacingFor = async (markup: string) => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(markup);
        return await readStepRowSpacing(page);
      } finally {
        await browser.close();
      }
    };

    it('measures the answer under the row and a message above its time, from the letters', async () => {
      const spacing = await spacingFor(transcript(14));
      expect(spacing).toBeDefined();
      expect(spacing!.stepToAnswer).toBeGreaterThan(14);
      expect(spacing!.betweenParts).toBeGreaterThan(12);
    });

    it('passes when the two distances are within a pixel and fails when they are not', async () => {
      const equal = await spacingFor(transcript(14));
      const gap = equal!.betweenParts - equal!.stepToAnswer;
      const matched = await spacingFor(transcript(14 + gap));
      expect(stepRowSpacingProblems(matched)).toEqual([]);
      const tooFar = await spacingFor(transcript(14 + gap + 3));
      expect(stepRowSpacingProblems(tooFar)).toEqual([
        expect.stringContaining("under the step row's text but a message's text is"),
      ]);
      const tooNear = await spacingFor(transcript(14 + gap - 3));
      expect(stepRowSpacingProblems(tooNear)).toHaveLength(1);
    });

    it('reports a page with no collapsed step row, and does not measure an open one', async () => {
      expect(await spacingFor('<p>No steps.</p>')).toBeUndefined();
      expect(stepRowSpacingProblems(undefined)).toHaveLength(1);
      expect(
        await spacingFor(transcript(14).replace('aria-expanded="false"', 'aria-expanded="true"')),
      ).toBeUndefined();
    });
  });

  describe('narration fold guard', () => {
    const lines = ['Reading the refund policy first.', 'Now the recent orders.'];
    // The real mechanism of the settled turn: one step row whose list holds the lines (hidden while
    // the row is closed), then the answer as a message of its own.
    const turn = (parts: { rows?: number; outside?: string; inside?: boolean }): string => {
      const timeline = `
        <section class="chat-tool-call-timeline">
          <button class="chat-tool-call-toggle" aria-expanded="false">2 steps</button>
          <ol class="chat-tool-call-list" hidden>
            ${parts.inside === false ? '' : lines.map((line) => `<li class="chat-tool-call-narration">${line}</li>`).join('')}
            <li class="chat-tool-call-item">a step</li>
          </ol>
        </section>`;
      return `
        <main data-testid="chat-stress-shell">
          ${parts.outside ?? ''}
          ${timeline.repeat(parts.rows ?? 1)}
          <div class="chat-message-wrapper" data-role="assistant"><div class="chat-message-body">All of them agree.</div></div>
        </main>`;
    };

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
        await page.setContent(markup);
        return await readNarrationFoldProblems(page, lines);
      } finally {
        await browser.close();
      }
    };

    it('passes one step row that holds every line, with none shown outside it', async () => {
      expect(await problemsFor(turn({}))).toEqual([]);
    });

    it('fails a line still shown as a message outside the step row', async () => {
      const outside = `<div class="chat-message-wrapper" data-narration><div class="chat-message-body">${lines[0]}</div></div>`;
      expect(await problemsFor(turn({ outside }))).toEqual([
        `the narration "${lines[0]}" is visible outside the step row`,
      ]);
    });

    it('does not count a line that is hidden outside the step row as shown', async () => {
      const outside = `<div hidden>${lines[0]}</div><div style="display:none">${lines[1]}</div>`;
      expect(await problemsFor(turn({ outside }))).toEqual([]);
    });

    it('fails a turn with two step rows', async () => {
      expect(await problemsFor(turn({ rows: 2 }))).toContain(
        'a settled turn shows 2 step rows, not one',
      );
    });

    it('fails a line that is in neither the step row nor the page', async () => {
      expect(await problemsFor(turn({ inside: false }))).toEqual([
        `the narration "${lines[0]}" is not inside the step row`,
        `the narration "${lines[1]}" is not inside the step row`,
      ]);
    });
  });

  describe('narration style guard', () => {
    // The real mechanism: narration is muted and 13px inside the opened row; the answer is body
    // colour at 14px.
    const opened = (narrationStyle: string, hidden = false): string => `
      <style>
        body { margin: 0; font: 14px/20px sans-serif; color: rgb(20, 20, 20); }
        .chat-tool-call-narration { ${narrationStyle} }
      </style>
      <section class="chat-tool-call-timeline">
        <ol class="chat-tool-call-list"${hidden ? ' hidden' : ''}>
          <li class="chat-tool-call-narration"><p>Reading the refund policy first.</p></li>
        </ol>
      </section>
      <div class="chat-message-wrapper"><div class="chat-message-body"><p>All of them agree.</p></div></div>`;

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(markup);
        return await readNarrationStyleProblems(page);
      } finally {
        await browser.close();
      }
    };

    it('passes narration that is muted and one step smaller than the answer', async () => {
      expect(await problemsFor(opened('color: rgb(110, 110, 110); font-size: 13px;'))).toEqual([]);
    });

    it("fails narration in the answer's colour", async () => {
      const problems = await problemsFor(opened('font-size: 13px;'));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("has the answer's colour");
    });

    it("fails narration at the answer's size, and larger", async () => {
      const same = await problemsFor(opened('color: rgb(110, 110, 110);'));
      expect(same).toHaveLength(1);
      expect(same[0]).toContain("has the answer's size 14px");
      const larger = await problemsFor(opened('color: rgb(110, 110, 110); font-size: 16px;'));
      expect(larger).toHaveLength(1);
      expect(larger[0]).toContain("larger than the answer's 14px");
    });

    it('fails when no line is visible, as in a closed row', async () => {
      expect(
        await problemsFor(opened('color: rgb(110, 110, 110); font-size: 13px;', true)),
      ).toEqual(['no narration line is visible in the opened step row']);
    });
  });

  describe('icon centre guard', () => {
    const row = (offset: number): string => `
      <style>
        body { margin: 0; font: 14px/20px sans-serif; }
        .row { display: flex; align-items: flex-start; gap: 8px; }
        button { font: inherit; padding: 0; border: 0; }
        svg { flex: none; inline-size: 16px; block-size: 16px; margin-block-start: ${offset}px; }
      </style>
      <button class="row"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg><span>Read the October ledger</span></button>`;

    const problemsFor = async (markup: string): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
        await page.setContent(markup);
        return await readIconCentreProblems(page);
      } finally {
        await browser.close();
      }
    };

    it('passes a 16px glyph centred on a 20px line', async () => {
      expect(await problemsFor(row(2))).toEqual([]);
    });

    it('fails a glyph hanging from the top of the line', async () => {
      const problems = await problemsFor(row(0));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('glyph centre is 2.00px off its text');
    });

    it('reads no text where the label is visually hidden by a 1px clip, and still reads one that shows', async () => {
      const labelled = (hidden: boolean): string => `
        <style>
          body { margin: 0; font: 14px/20px sans-serif; }
          button { display: flex; align-items: center; gap: 8px; font: inherit; padding: 0; border: 0; height: 28px; }
          svg { flex: none; inline-size: 16px; block-size: 16px; }
          .label { display: block; ${hidden ? 'position: absolute; inline-size: 1px; block-size: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%);' : 'margin-block-start: 6px;'} }
        </style>
        <button><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg><span class="label">Add note</span></button>`;
      // Negative control: the same words, shown and 6px lower than the glyph, are a failure.
      const shown = await problemsFor(labelled(false));
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain('glyph centre is');
      // Positive control: clipped to a pixel, the words are not on the row at all.
      expect(await problemsFor(labelled(true))).toEqual([]);
    });

    it('allows half a pixel and no more', async () => {
      expect(await problemsFor(row(2.5))).toEqual([]);
      expect(await problemsFor(row(3))).toHaveLength(1);
    });

    it('reads text that is a flex item itself by its line box, not the 0.75px its letters ride above it', async () => {
      const bare = (align: string, offset: number): string => `
        <style>
          body { margin: 0; font: 13px/19.5px sans-serif; }
          button { display: flex; align-items: ${align}; gap: 8px; font: inherit; padding: 0; border: 0; }
          svg { flex: none; inline-size: 16px; block-size: 16px; margin-block-start: ${offset}px; }
        </style>
        <button><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>Read the October ledger</button>`;
      expect(await problemsFor(bare('center', 0))).toEqual([]);
      expect(await problemsFor(bare('flex-start', 1.75))).toEqual([]);
      expect(await problemsFor(bare('flex-start', 0))).toHaveLength(1);
    });

    it('measures a glyph in a labelled row that is not a control', async () => {
      const labelled = row(0)
        .replace('<button class="row">', '<li class="row" aria-label="Ledger">')
        .replace('</button>', '</li>');
      expect(await problemsFor(labelled)).toHaveLength(1);
    });

    it('does not measure a glyph in a plain row, or one with no text beside it', async () => {
      const plain = row(0)
        .replace('<button class="row">', '<div class="row">')
        .replace('</button>', '</div>');
      expect(await problemsFor(plain)).toEqual([]);
      expect(await problemsFor(row(0).replace('<span>Read the October ledger</span>', ''))).toEqual(
        [],
      );
    });
  });

  describe('attachment strip guard', () => {
    interface StripOptions {
      readonly chipHeights?: readonly number[];
      readonly extension?: string;
      readonly cutInMiddle?: boolean;
      readonly gap?: number;
      readonly actionInset?: number;
      readonly direction?: 'ltr' | 'rtl';
    }

    /** The strip's real mechanism: chips in a scrolling row, each with a stem, an extension and Remove. */
    const strip = (options: StripOptions = {}): string => {
      const heights = options.chipHeights ?? [28, 28, 28];
      const gap = options.gap ?? 8;
      const chip = (height: number, index: number): string => `
        <li class="item"><span class="chat-attachment-preview" title="report-${index}${options.extension ?? '.pdf'}" style="height:${height}px">
          <span class="chat-attachment-preview-name"><span class="chat-attachment-preview-stem">${
            options.cutInMiddle === true ? 'report…' : 'report'
          }-${index}</span><span class="chat-attachment-preview-extension">${options.extension ?? '.pdf'}</span></span>
          <button class="chat-input-attachment-remove" style="width:24px;height:24px;padding:0;border:0"></button>
        </span></li>`;
      return `
        <style>
          *, *::before, *::after { box-sizing: border-box }
          body { margin: 0; font: 13px/20px sans-serif; direction: ${options.direction ?? 'ltr'} }
          .chat-input-attachments { display: flex; gap: ${gap}px; list-style: none; margin: 0; padding: 8px; overflow-x: auto; width: 300px }
          .item { flex: none; display: flex }
          .chat-attachment-preview { display: flex; align-items: center; border: 1px solid #888; padding-inline-start: 8px }
          .chat-attachment-preview-name { display: flex }
          .chat-attachment-preview-stem { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
          .chat-input-attachment-reason { display: flex; align-items: center; justify-content: space-between; width: 300px; padding-inline: ${options.actionInset ?? 0}px 0; margin: 0 }
          .chat-input-attachment-reason button { width: 60px; height: 24px; padding: 0 }
        </style>
        <ul class="chat-input-attachments">${heights.map(chip).join('')}</ul>
        <p class="chat-input-attachment-reason"><span>report-0.pdf didn't upload.</span><button>Retry</button></p>`;
    };

    const problemsFor = async (markup: string, coarse = false): Promise<string[]> => {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({
          viewport: { width: 400, height: 300 },
          hasTouch: coarse,
          isMobile: coarse,
        });
        const page = await context.newPage();
        await page.setContent(markup);
        return await readAttachmentStripProblems(page);
      } finally {
        await browser.close();
      }
    };

    it('passes chips of one height with whole names, apart remove controls and a line ending at the edge', async () => {
      expect(await problemsFor(strip())).toEqual([]);
    });

    it('fails chips of different heights, down to a fraction of a pixel', async () => {
      expect(await problemsFor(strip({ chipHeights: [28, 28, 30] }))).toEqual([
        expect.stringContaining('not one height'),
      ]);
      expect(await problemsFor(strip({ chipHeights: [28, 28, 28.25] }))).toEqual([
        expect.stringContaining('not one height'),
      ]);
    });

    it('fails a name with an ellipsis in the page: a cut in the middle with a detached fragment', async () => {
      expect(await problemsFor(strip({ cutInMiddle: true }))).toContainEqual(
        expect.stringContaining('shows a name that is not the file'),
      );
    });

    it('fails an extension that is clipped inside its name', async () => {
      // A name box narrower than its stem and extension together pushes the extension past its end.
      const overflowing = strip().replace(
        '.chat-attachment-preview-name { display: flex }',
        '.chat-attachment-preview-name { display: block; width: 40px; white-space: nowrap }',
      );
      expect(await problemsFor(overflowing)).toContainEqual(
        expect.stringContaining('is cut inside its extension'),
      );
    });

    it('fails a stem cut with no ellipsis', async () => {
      const plain = strip().replace('text-overflow: ellipsis', 'text-overflow: clip');
      const narrow = plain.replace(
        '.chat-attachment-preview-stem {',
        '.chat-attachment-preview-stem { max-width: 20px;',
      );
      expect(await problemsFor(narrow)).toContainEqual(
        expect.stringContaining('is cut with no ellipsis'),
      );
    });

    it('fails coarse remove controls whose 44px hit areas overlap, and passes ones that stand apart', async () => {
      // Chips this narrow put two 24px controls less than 44px apart.
      const crowded = strip().replace(
        '.item { flex: none; display: flex }',
        '.item { flex: none; display: flex; width: 34px }',
      );
      expect(await problemsFor(crowded, true)).toContainEqual(
        expect.stringContaining('have overlapping hit areas'),
      );
      expect(await problemsFor(strip(), true)).toEqual([]);
    });

    it('fails a coarse hit area a strip clips', async () => {
      const clipped = strip().replace('padding: 8px; overflow-x', 'padding: 0; overflow-x');
      expect(await problemsFor(clipped, true)).toContainEqual(
        expect.stringContaining('is clipped by the strip'),
      );
    });

    it('fails a failure line whose action stops short of the trailing edge', async () => {
      const short = strip().replace(
        '.chat-input-attachment-reason button { width: 60px;',
        '.chat-input-attachment-reason button { margin-inline-end: 6px; width: 60px;',
      );
      expect(await problemsFor(short)).toContainEqual(
        expect.stringContaining('ends 6.00px from the trailing edge'),
      );
    });

    it('measures the line against the left edge when the text runs right to left', async () => {
      expect(await problemsFor(strip({ direction: 'rtl' }))).toEqual([]);
      const short = strip({ direction: 'rtl' }).replace(
        '.chat-input-attachment-reason button { width: 60px;',
        '.chat-input-attachment-reason button { margin-inline-end: 5px; width: 60px;',
      );
      expect(await problemsFor(short)).toContainEqual(
        expect.stringContaining('ends 5.00px from the trailing edge'),
      );
    });
  });
});
