import type { Page } from '@playwright/test';

import { probeFont } from './terminal-probe-font.ts';
import {
  captureKeys,
  expect,
  exportedText,
  focusTerminal,
  frames,
  terminalInput,
  terminalRegion,
  test,
  write,
} from './terminal-support.ts';

const ESC = '\u001b';
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;

const geometry = (page: Page) => page.evaluate(() => window.terminalLab!.events.geometry);

async function geometryCount(page: Page): Promise<number> {
  const reports = await geometry(page);
  return reports.length;
}

async function lastGeometry(page: Page) {
  const reports = await geometry(page);
  return reports.at(-1)!;
}

async function lastColumns(page: Page): Promise<number> {
  const report = await lastGeometry(page);
  return report.columns;
}

async function cellWidth(page: Page): Promise<number> {
  return page
    .locator('.xterm-char-measure-element')
    .first()
    .evaluate(
      (element) => element.getBoundingClientRect().width / (element.textContent?.length ?? 1),
    );
}

function expectSaneGeometry(reports: Array<{ columns: number; rows: number }>): void {
  expect(reports.length).toBeGreaterThan(0);
  for (const report of reports) {
    expect(Number.isInteger(report.columns) && report.columns > 0, JSON.stringify(report)).toBe(
      true,
    );
    expect(Number.isInteger(report.rows) && report.rows > 0, JSON.stringify(report)).toBe(true);
  }
}

test.describe('fitting', () => {
  test('the first grid is measured before anything else, and resizing reports new ones', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    const first = await geometry(page);
    expect(first).toHaveLength(1);
    await page.setViewportSize({ width: 600, height: 900 });
    await expect.poll(async () => await geometryCount(page)).toBeGreaterThan(1);
    await frames(page, 4);
    const reports = await geometry(page);
    expectSaneGeometry(reports);
    expect(reports.at(-1)!.columns).toBeLessThan(reports[0]!.columns);
    reports.slice(1).forEach((report, index) => {
      expect(report, 'only a changed grid is reported').not.toEqual(reports[index]);
    });
  });

  test('a web font that loads late re-fits the grid to the new cell size', async ({
    terminalPage,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = await terminalPage.open({
      query: { quiet: true },
      // The browser's load event waits for a font the page uses, and this one is held back.
      waitUntil: 'domcontentloaded',
      prepare: async (target) => {
        // The page names the web font from the start; the file arrives only when the test lets it.
        await target.route('**/probe-font.ttf', async (route) => {
          await gate;
          await route.fulfill({
            body: Buffer.from(probeFont(1500)),
            contentType: 'font/ttf',
            headers: { 'access-control-allow-origin': '*' },
          });
        });
        await target.addInitScript(() => {
          document.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent =
              "@font-face { font-family: 'TerminalProbe'; src: url('/probe-font.ttf') format('truetype'); } #terminal-stage { --cinder-font-mono: 'TerminalProbe', monospace; }";
            document.head.append(style);
          });
        });
      },
    });
    const before = await lastGeometry(page);
    const widthBefore = await cellWidth(page);
    release();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(async () => await geometryCount(page)).toBeGreaterThan(1);
    const after = await lastGeometry(page);
    expect(await cellWidth(page)).toBeGreaterThan(widthBefore * 1.5);
    expect(after.columns).toBeLessThan(before.columns * 0.7);
    expectSaneGeometry(await geometry(page));
    await write(page, 'still readable after the font loaded');
    expect(await exportedText(page)).toContain('still readable after the font loaded');
  });

  test('browser zoom re-fits the grid: a narrower layout viewport and a denser display', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    await write(page, 'zoom test line');
    const before = await lastGeometry(page);
    // Zooming to 200 percent halves the layout viewport in CSS pixels.
    await page.setViewportSize({ width: 640, height: 450 });
    await expect.poll(async () => await lastColumns(page)).toBeLessThan(before.columns);
    expectSaneGeometry(await geometry(page));
    expect(await exportedText(page)).toBe('zoom test line');

    // A denser display keeps the grid and the content.
    const dense = await terminalPage.open({
      query: { quiet: true },
      context: { deviceScaleFactor: 2 },
    });
    await write(dense, 'zoom test line');
    const denseGrid = await lastGeometry(dense);
    expect(Math.abs(denseGrid.columns - before.columns)).toBeLessThanOrEqual(3);
    expect(await exportedText(dense)).toBe('zoom test line');
  });

  test('a hidden terminal reports nothing, and showing it again reports one fresh valid grid', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    const initial = await geometryCount(page);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.terminal-host')!.style.display = 'none';
    });
    await page.setViewportSize({ width: 700, height: 700 });
    await write(page, 'written while hidden');
    await frames(page, 4);
    expect(await geometry(page), 'no resize is invented for a hidden terminal').toHaveLength(
      initial,
    );
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.terminal-host')!.style.display = '';
    });
    await expect.poll(async () => await geometryCount(page)).toBeGreaterThan(initial);
    expectSaneGeometry(await geometry(page));
    expect(await exportedText(page)).toBe('written while hidden');
  });

  test('a zero-size container never produces a zero or fractional grid', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.terminal-host')!;
      host.style.height = '0px';
      host.style.overflow = 'hidden';
    });
    await frames(page, 4);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('.terminal-host')!.style.height = '20rem';
    });
    await expect.poll(async () => await geometryCount(page)).toBeGreaterThan(0);
    expectSaneGeometry(await geometry(page));
  });
});

test.describe('lifecycle', () => {
  test('repeated unmount and mount leaves one engine, one subscription and no leftovers', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    for (let round = 1; round <= 6; round += 1) {
      await page.evaluate(() => window.terminalLab!.unmount());
      await expect(page.locator('.xterm')).toHaveCount(0);
      await expect(page.locator('textarea.xterm-helper-textarea')).toHaveCount(0);
      expect(await page.evaluate(() => window.terminalLab!.session.subscriptions.live)).toBe(0);
      await page.evaluate(() => window.terminalLab!.mount());
      await expect(page.locator('.xterm')).toHaveCount(1);
      await expect(page.locator('.cinder-terminal__viewport:not([inert])')).toHaveCount(1);
      const counts = await page.evaluate(() => window.terminalLab!.session.subscriptions);
      expect(counts, `round ${round}`).toEqual({ total: round + 1, live: 1 });
    }
    expect(await exportedText(page)).toMatch(/bun run build/);
    expect(await page.evaluate(() => window.terminalLab!.session.failures)).toEqual([]);
  });

  test('a new session replaces the old one without leaving it subscribed', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    const old = await page.evaluate(() => {
      const lab = window.terminalLab!;
      const first = lab.session;
      lab.newSession();
      return { same: lab.session === first };
    });
    expect(old.same).toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.terminalLab!.session.subscriptions.live))
      .toBe(1);
  });
});

test.describe('look', () => {
  test('the inset around the screen is the themed surface, never the engine’s default black', async ({
    terminalPage,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await terminalPage.open({ theme, query: { quiet: true } });
      const colors = await page.evaluate(() => {
        const read = (selector: string) =>
          getComputedStyle(document.querySelector(selector)!).backgroundColor;
        return {
          viewport: read('.cinder-terminal__viewport'),
          scrollable: read('.cinder-terminal__viewport .xterm-viewport'),
        };
      });
      expect(colors.scrollable, theme).toBe(colors.viewport);
    }
  });

  test('every control stays inside the frame at the narrowest viewport', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({
      viewport: 'mobile',
      query: { mouse: true },
    });
    await write(page, MOUSE_ON);
    await captureKeys(page);
    await expect(
      page.locator('.cinder-terminal__actions').getByText('Mouse reporting on'),
    ).toBeVisible();
    const overflow = await page.evaluate(() => {
      const frame = document.querySelector('.cinder-terminal-frame')!.getBoundingClientRect();
      const stray = [
        ...document.querySelectorAll(
          '.cinder-terminal__actions button, .cinder-terminal__inspection button',
        ),
      ]
        .filter((button) => {
          const box = button.getBoundingClientRect();
          return box.right > frame.right + 0.5 || box.left < frame.left - 0.5;
        })
        .map((button) => button.textContent?.trim());
      return {
        stray,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(overflow.stray).toEqual([]);
    expect(overflow.page).toBeLessThanOrEqual(0);
  });

  test('a visible ring surrounds the whole viewport while focus is inside it', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    const viewport = page.locator('.cinder-terminal__viewport');
    const edge = async () => {
      const box = (await viewport.boundingBox())!;
      // A strip along the left edge, inside the viewport, where the engine's surface sits.
      return page.screenshot({
        clip: { x: box.x, y: box.y + 4, width: 2, height: box.height - 8 },
      });
    };
    const resting = await edge();
    await focusTerminal(page);
    const focused = await edge();
    expect(focused.equals(resting), 'the ring paints over the engine surface').toBe(false);
    const ring = await viewport.evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      return { position: style.position, shadow: style.boxShadow };
    });
    expect(ring.position).toBe('absolute');
    expect(ring.shadow).not.toBe('none');
  });

  test('theme colors keep text legible: default text and the colors programs use meet AA', async ({
    terminalPage,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await terminalPage.open({ theme, query: { quiet: true } });
      const ratios = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        const rgb = (css: string): [number, number, number] => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = '#000';
          context.fillStyle = css;
          context.fillRect(0, 0, 1, 1);
          const data = context.getImageData(0, 0, 1, 1).data;
          return [data[0]!, data[1]!, data[2]!];
        };
        const luminance = ([r, g, b]: [number, number, number]) => {
          const channel = (value: number) => {
            const scaled = value / 255;
            return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const resolve = (token: string) => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          document.querySelector('.cinder-terminal__viewport')!.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        const background = rgb(resolve('--cinder-surface-inset'));
        const names = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
        const tokens = [
          '--cinder-text-default',
          ...names.map((name) => `--cinder-terminal-ansi-${name}`),
          ...names.map((name) => `--cinder-terminal-ansi-bright-${name}`),
        ];
        return tokens.map((token) => {
          const a = luminance(rgb(resolve(token)));
          const b = luminance(background);
          return { token, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
      });
      for (const { token, ratio } of ratios) {
        expect(ratio, `${theme} ${token}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

test.describe('reduced motion', () => {
  test('reduced motion stops the cursor blinking and every animation in the terminal', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    await frames(page, 3);
    expect(await page.locator('.xterm-cursor-blink').count()).toBe(0);
    const running = await terminalRegion(page).evaluate(
      (region) =>
        region.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
    );
    expect(running).toBe(0);
  });

  test('without the preference the cursor blinks, and status and focus still change at once', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ context: { reducedMotion: 'no-preference' } });
    await focusTerminal(page);
    await expect(page.locator('.xterm-cursor-blink')).toHaveCount(1);
    await page.evaluate(() => window.terminalLab!.setProps({ state: 'read-only' }));
    await expect(page.getByText('Read-only', { exact: true }).first()).toBeVisible();
    await expect(terminalInput(page)).toBeFocused();
  });
});
