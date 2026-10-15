import {
  announcementText,
  bytes,
  expect,
  exportedText,
  focusTerminal,
  frames,
  lastScreenRow,
  screenRows,
  screenText,
  sentBytes,
  sideEffects,
  test,
  write,
  writeChunks,
} from './terminal-support.ts';

const ESC = '\u001b';
const BEL = '\u0007';
const quiet = { quiet: true } as const;

test.describe('ANSI and VT state', () => {
  test('styles, colors, cursor movement and erasing leave exactly the screen the bytes describe', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(
      page,
      [
        'plain',
        `${ESC}[1;31mred bold${ESC}[0m`,
        `${ESC}[38;2;255;128;0mtruecolor${ESC}[0m${ESC}[4munder${ESC}[0m`,
        `A${ESC}[5CB${ESC}[2;1HZ`,
      ].join('\r\n'),
    );
    expect(await exportedText(page)).toBe('plain\nZed bold\ntruecolorunder\nA     B');
    const spans = await page
      .locator('.cinder-terminal__viewport .xterm-rows span')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          className: element.className,
          color: (element as HTMLElement).style.color,
          text: element.textContent ?? '',
        })),
      );
    expect(spans.find((span) => span.text === 'd bold')?.className).toContain('xterm-bold');
    expect(spans.find((span) => span.text === 'd bold')?.className).toContain('xterm-fg-9');
    expect(spans.find((span) => span.text === 'truecolor')?.color).toBe('rgb(255, 128, 0)');
    expect(spans.find((span) => span.text === 'under')?.className).toContain('xterm-underline-1');

    await write(page, `${ESC}[2J${ESC}[1;1Hcleared${ESC}[1;3H${ESC}[K`);
    expect(await exportedText(page)).toBe('cl');
  });

  test('the alternate screen is separate: leaving it restores the primary screen untouched', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(page, 'primary line one\r\nprimary line two');
    await write(
      page,
      `${ESC}[?1049h${ESC}[2J${ESC}[1;1HALT BODY${ESC}[3;1H${ESC}[7m STATUS ${ESC}[0m`,
    );
    expect(await exportedText(page)).toBe('ALT BODY\n\n STATUS ');
    await write(page, `${ESC}[?1049l`);
    expect(await exportedText(page)).toBe('primary line one\nprimary line two');
  });

  test('a full reset returns modes and the screen to their start state', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(page, `${ESC}[?2004h${ESC}[?1000hscreen text`);
    await write(page, `${ESC}c`);
    expect(await exportedText(page)).toBe('');
    await focusTerminal(page);
    await page.evaluate(() => {
      const target = document.querySelector('textarea.xterm-helper-textarea')!;
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: () => 'plain' },
      });
      target.dispatchEvent(event);
    });
    // Bracketed paste is off again, so a plain line needs no review and carries no markers.
    expect(await sentBytes(page)).toEqual(bytes('plain'));
  });
});

test.describe('Unicode', () => {
  const SAMPLE = 'é日本🙂👨‍👩‍👧x';

  test('text split at every byte boundary renders the same as text written whole', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(page, SAMPLE);
    const whole = await exportedText(page);
    expect(whole).toBe(SAMPLE);
    await write(page, `${ESC}c`);
    await writeChunks(
      page,
      bytes(SAMPLE).map((byte) => [byte]),
    );
    expect(await exportedText(page)).toBe(SAMPLE);
  });

  test('wide characters take two cells, combining marks and joiners take none', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    // Report the cursor column after each sample, so the width is read from the engine's own state.
    await write(page, '日');
    await write(page, `${ESC}[6n`);
    await write(page, `${ESC}[2J${ESC}[1;1Hé`);
    await write(page, `${ESC}[6n`);
    expect(String.fromCharCode(...(await sentBytes(page)))).toBe(`${ESC}[1;3R${ESC}[1;2R`);
  });

  test('a multi-byte character split across writes is never torn or dropped', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    const zeroWidthSpace = bytes('​');
    await writeChunks(page, ['a', zeroWidthSpace.slice(0, 2), zeroWidthSpace.slice(2), 'b']);
    expect(await exportedText(page)).toBe('a​b');
  });
});

test.describe('queries and what hostile output cannot do', () => {
  test('a writable view answers terminal queries with the engine’s exact replies', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(page, `${ESC}[c${ESC}[6n${ESC}[5n${ESC}[>c`);
    expect(String.fromCharCode(...(await sentBytes(page)))).toBe(
      `${ESC}[?1;2c${ESC}[1;1R${ESC}[0n${ESC}[>0;276;0c`,
    );
  });

  test('window reports, clipboard requests, links, markup and string sequences have no effect', async ({
    terminalPage,
  }) => {
    const urls: string[] = [];
    const dialogs: string[] = [];
    const popups: string[] = [];
    const page = await terminalPage.open({
      query: { quiet: true, links: true },
      prepare: async (target) => {
        target.on('dialog', async (dialog) => {
          dialogs.push(dialog.message());
          await dialog.dismiss();
        });
        target.on('popup', (popup) => popups.push(popup.url()));
        target.on('request', (request) => urls.push(request.url()));
      },
    });
    const origin = page.url();
    const before = urls.length;
    await write(
      page,
      [
        `${ESC}]52;c;aGVsbG8=${BEL}`,
        `${ESC}]52;c;?${BEL}`,
        `${ESC}]8;;javascript:window.__pwned=1${BEL}hidden script link${ESC}]8;;${BEL}`,
        `${ESC}]8;;https://evil.example/hidden${BEL}hidden https target${ESC}]8;;${BEL}`,
        '<script>window.__pwned = 1</script><img src="https://evil.example/pixel" onerror="window.__pwned=1">',
        `${ESC}[18t${ESC}[21t${ESC}[8;40;100t${ESC}[1t`,
        `${ESC}Pq#0;2;0;0;0#0~~~${ESC}\\${ESC}_Gf=100;AAAA${ESC}\\${ESC}^privacy${ESC}\\`,
        `${ESC}]7;file:///etc/passwd${BEL}${ESC}]1337;File=name=eC5leGU=:AAAA${BEL}`,
      ].join('\r\n'),
    );
    await frames(page, 3);

    const effects = await sideEffects(page);
    expect(effects).toMatchObject({
      clipboardWrites: [],
      clipboardReads: 0,
      opened: [],
      dialogs: [],
      fetches: [],
      beacons: [],
      sockets: [],
      workers: [],
      eventSources: [],
      downloads: [],
    });
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
      undefined,
    );
    expect(page.url()).toBe(origin);
    expect(dialogs).toEqual([]);
    expect(popups).toEqual([]);
    expect(urls.slice(before), 'output starts no request').toEqual([]);
    expect(
      await page.locator('.cinder-terminal__viewport').locator('script, img, a, iframe').count(),
    ).toBe(0);
    const shown = await exportedText(page);
    expect(shown).toContain('<script>window.__pwned = 1</script>');
    expect(shown).toContain('hidden script link');
    // The engine answers none of the window reports, so nothing but queries it supports is sent.
    expect(await sentBytes(page)).toEqual([]);

    // Links are on, and still only deliberate activation of visible https text opens one.
    await write(page, `${ESC}[2J${ESC}[1;1Hsee https://example.com/docs for more`);
    const row = page.locator('.cinder-terminal__viewport .xterm-rows > div').first();
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.move(box.x + 100, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.terminalLab!.events.links))
      .toEqual(['https://example.com/docs']);
    expect(await sideEffects(page)).toMatchObject({ opened: [], clipboardWrites: [] });
    expect(page.url()).toBe(origin);
  });

  test('links are off unless the host opts in, and the snapshot lists only visible https text', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(
      page,
      `see https://example.com/docs ${ESC}]8;;https://evil.example/x${BEL}here${ESC}]8;;${BEL}`,
    );
    const row = page.locator('.cinder-terminal__viewport .xterm-rows > div').first();
    const box = (await row.boundingBox())!;
    await page.mouse.click(box.x + 100, box.y + box.height / 2);
    expect(await page.evaluate(() => window.terminalLab!.events.links)).toEqual([]);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByText('Links in this output')).toHaveCount(0);
  });

  test('a program-set title reaches the host as bounded plain text', async ({ terminalPage }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(page, `${ESC}]0;${'t'.repeat(300)}${BEL}${ESC}]2;build\u0001 <b>done</b>${BEL}`);
    const titles = await page.evaluate(() => window.terminalLab!.events.titles);
    expect(titles[0]).toBe('t'.repeat(256));
    expect(titles.at(-1)).toBe('build <b>done</b>');
  });
});

test.describe('scroll anchoring and bounded announcements', () => {
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`).join('\r\n');

  test('output follows the end until the reader scrolls away, then the position holds', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: quiet });
    await write(page, lines(1, 200));
    expect(await lastScreenRow(page)).toContain('line 200');
    const viewport = page.locator('.cinder-terminal__viewport');
    await viewport.hover();
    await page.mouse.wheel(0, -1200);
    await frames(page, 4);
    const away = await screenRows(page);
    expect(away.join('|')).not.toContain('line 200');
    await write(page, `\r\n${lines(201, 260)}`);
    await frames(page, 4);
    expect(await screenRows(page), 'a reader who scrolled away is not moved').toEqual(away);

    // Wheel distances differ between engines, so keep scrolling until the end is showing.
    for (let step = 0; step < 40; step += 1) {
      const showing = await screenText(page);
      if (showing.includes('line 260')) break;
      await page.mouse.wheel(0, 1200);
      await frames(page, 2);
    }
    expect(await screenText(page)).toContain('line 260');
    await write(page, '\r\nline 261');
    await frames(page, 4);
    expect(await screenText(page), 'returning to the end resumes following').toContain('line 261');
  });

  test('screen-reader output is off by default and bounded when the host turns it on', async ({
    terminalPage,
  }) => {
    const quietPage = await terminalPage.open({ query: quiet });
    await write(quietPage, lines(1, 300));
    expect(await quietPage.locator('.xterm-accessibility, .xterm-live-region').count()).toBe(0);

    const page = await terminalPage.open({ query: { quiet: true, announce: true } });
    await write(page, lines(1, 5000));
    const live = await page
      .locator('.xterm-accessibility')
      .first()
      .evaluate((element) => ({
        text: element.textContent?.length ?? 0,
        rows: element.querySelectorAll('*').length,
      }));
    expect(live.text, 'the mirror holds the visible rows, not the whole output').toBeLessThan(4000);
    expect(live.rows).toBeLessThan(200);
    // The component's own polite region is not used for output.
    expect(await announcementText(page)).not.toContain('line 5000');
  });
});
