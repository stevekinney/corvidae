import {
  announcedCount,
  announcementText,
  bytes,
  captureButton,
  captureKeys,
  expect,
  focusTerminal,
  frames,
  isMac,
  navigationKey,
  paste,
  resetSent,
  sentBytes,
  sentOperations,
  terminalInput,
  test,
  write,
} from './terminal-support.ts';

const ESC = '\u001b';

test.describe('typed input reaches the session as exact bytes', () => {
  test('printable text, composed text and Unicode are sent as UTF-8 in order', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    await page.keyboard.type('ls -la');
    await page.keyboard.insertText('é日🙂');
    expect(await sentBytes(page)).toEqual(bytes('ls -laé日🙂'));
  });

  const KEYS: Array<[string, string]> = [
    ['Enter', '\r'],
    ['Backspace', '\u007f'],
    ['Escape', ESC],
    ['ArrowUp', `${ESC}[A`],
    ['ArrowDown', `${ESC}[B`],
    ['ArrowRight', `${ESC}[C`],
    ['ArrowLeft', `${ESC}[D`],
    ['Home', `${ESC}[H`],
    ['End', `${ESC}[F`],
    ['PageUp', `${ESC}[5~`],
    ['PageDown', `${ESC}[6~`],
    ['Delete', `${ESC}[3~`],
    ['F1', `${ESC}OP`],
    ['F2', `${ESC}OQ`],
    ['F3', `${ESC}OR`],
    ['F4', `${ESC}OS`],
    ['F5', `${ESC}[15~`],
    ['F6', `${ESC}[17~`],
    ['F7', `${ESC}[18~`],
    ['F8', `${ESC}[19~`],
    ['F9', `${ESC}[20~`],
    ['F10', `${ESC}[21~`],
    ['F11', `${ESC}[23~`],
    ['F12', `${ESC}[24~`],
    ['Control+a', '\u0001'],
    ['Control+d', '\u0004'],
    ['Control+ArrowRight', `${ESC}[1;5C`],
    ['Shift+ArrowUp', `${ESC}[1;2A`],
  ];

  test('function keys, navigation keys and modifier chords keep their exact sequences', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    for (const [key, expected] of KEYS) {
      await resetSent(page);
      await page.keyboard.press(key);
      expect(await sentBytes(page), `${key} must send ${JSON.stringify(expected)}`).toEqual(
        bytes(expected),
      );
    }
  });

  test('dead keys send only the committed character, never the accent or the physical key', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    // A layout that commits the composed character as plain text input, as a Linux layout does.
    await page.keyboard.insertText('é');
    expect(await sentBytes(page)).toEqual(bytes('é'));
    // A dead key produces no input of its own; the composition commits the character, the way
    // macOS reports it: key `Dead`, composition events, then the commit.
    await resetSent(page);
    await terminalInput(page).evaluate(async (target) => {
      const field = target as HTMLTextAreaElement;
      field.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Dead',
          code: 'Quote',
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      );
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      field.value = '´';
      field.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '´' }));
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'n', keyCode: 229, bubbles: true, cancelable: true }),
      );
      field.value = 'ñ';
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ñ' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await frames(page);
    expect(await sentBytes(page)).toEqual(bytes('ñ'));
  });

  test('an input method sends nothing until it commits, and then only the committed text', async ({
    terminalPage,
    browserName,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    await terminalInput(page).evaluate((target) => {
      const field = target as HTMLTextAreaElement;
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      field.value = 'に';
      field.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'に' }));
      for (const key of ['n', 'i']) {
        field.dispatchEvent(
          new KeyboardEvent('keydown', { key, keyCode: 229, bubbles: true, cancelable: true }),
        );
      }
    });
    await frames(page);
    expect(await sentBytes(page), 'preedit text is not input').toEqual([]);
    await terminalInput(page).evaluate(async (target) => {
      const field = target as HTMLTextAreaElement;
      field.value = '日本';
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await frames(page);
    expect(await sentBytes(page)).toEqual(bytes('日本'));

    if (browserName === 'chromium') {
      // Chromium also exposes the real input-method pipeline, so the same commit is driven
      // through it: a composition in progress sends nothing, its commit sends the text.
      await resetSent(page);
      const session = await page.context().newCDPSession(page);
      await session.send('Input.imeSetComposition', {
        text: 'かな',
        selectionStart: 2,
        selectionEnd: 2,
      });
      await frames(page);
      expect(await sentBytes(page)).toEqual([]);
      await session.send('Input.insertText', { text: '仮名' });
      await frames(page);
      expect(await sentBytes(page)).toEqual(bytes('仮名'));
    }
  });
});

test.describe('capture, focus and page navigation', () => {
  test('Tab moves through the page while capture is off and goes to the shell while it is on', async ({
    terminalPage,
    browserName,
  }) => {
    const page = await terminalPage.open({ query: { probes: true } });
    await focusTerminal(page);
    await page.keyboard.press(navigationKey(browserName));
    await expect(terminalInput(page)).not.toBeFocused();
    expect(await sentBytes(page), 'page navigation sends no bytes').toEqual([]);

    await captureKeys(page);
    await page.keyboard.press('Tab');
    await expect(terminalInput(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(terminalInput(page)).toBeFocused();
    expect(await sentBytes(page)).toEqual(bytes(`\t${ESC}[Z`));
  });

  test('on a Mac, Option+Tab leaves the terminal while capture is off and goes to the shell while it is on', async ({
    terminalPage,
    browserName,
  }) => {
    const page = await terminalPage.open({
      query: { probes: true },
      prepare: async (target) => {
        await target.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'platform', {
            get: () => 'MacIntel',
            configurable: true,
          });
          Object.defineProperty(navigator, 'userAgentData', {
            get: () => ({ platform: 'macOS' }),
            configurable: true,
          });
        });
      },
    });
    expect(await isMac(page)).toBe(true);
    // What the page's own default action would be: whether anything cancelled the key.
    await page.evaluate(() => {
      const seen: boolean[] = [];
      (window as unknown as { altTabCancelled: boolean[] }).altTabCancelled = seen;
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Tab' && event.altKey) {
          queueMicrotask(() => seen.push(event.defaultPrevented));
        }
      });
    });
    const cancelled = () =>
      page.evaluate(() => (window as unknown as { altTabCancelled: boolean[] }).altTabCancelled);
    await focusTerminal(page);
    await page.keyboard.press('Alt+Tab');
    expect(
      await cancelled(),
      'the terminal leaves Option+Tab to the page while capture is off',
    ).toEqual([false]);
    expect(await sentBytes(page)).toEqual([]);
    // Only Safari moves focus on Option+Tab on every host: Firefox never does, and Chromium does
    // not on Linux, where the window manager owns the chord. The page's own handling is asserted above.
    if (browserName === 'webkit') {
      await expect(terminalInput(page)).not.toBeFocused();
    }

    await captureKeys(page);
    await page.keyboard.press('Alt+Tab');
    const shellBytes = await sentBytes(page);
    expect(shellBytes.length, 'with capture on the shell owns it').toBeGreaterThan(0);
    await expect(terminalInput(page)).toBeFocused();
  });

  test('Ctrl+Shift+Escape releases capture, bare Escape does not, and each is said once', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await captureKeys(page);
    await page.keyboard.press('Escape');
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await sentBytes(page)).toEqual(bytes(ESC));
    await resetSent(page);
    await page.keyboard.press('Control+Shift+Escape');
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'false');
    expect(await sentBytes(page), 'the release chord is not shell input').toEqual([]);
    await expect(terminalInput(page)).toBeFocused();
    await expect.poll(() => announcedCount(page, 'Terminal key capture off')).toBe(1);
    expect(await announcedCount(page, 'Terminal key capture on')).toBe(1);
  });

  test('keys typed outside the terminal reach nothing, and capture ends when focus leaves', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { probes: true } });
    await page.locator('#before-terminal').focus();
    await page.keyboard.type('outside');
    await page.keyboard.press('Control+c');
    expect(await sentBytes(page)).toEqual([]);
    await captureKeys(page);
    await page.locator('#before-terminal').focus();
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('still outside');
    expect(await sentBytes(page)).toEqual([]);
  });

  test('capture belongs to the live session: a replaced session starts with it off', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await captureKeys(page);
    await page.evaluate(() => {
      window.terminalLab!.newSession();
    });
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('interrupt and copy', () => {
  test('the Interrupt control sends one ETX byte and keeps capture and focus', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await captureKeys(page);
    await page.getByRole('button', { name: 'Interrupt' }).click();
    expect(await sentOperations(page)).toEqual([[3]]);
    await expect(terminalInput(page)).toBeFocused();
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('the copy chord interrupts only when nothing is selected', async ({ terminalPage }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    const mac = await isMac(page);
    const chord = mac ? 'Meta+c' : 'Control+c';
    await page.keyboard.press(chord);
    expect(await sentBytes(page), 'no selection: the intentional interrupt').toEqual([3]);

    await resetSent(page);
    await page.evaluate(() => {
      (window as unknown as { __copied: string[] }).__copied = [];
      document.addEventListener('copy', (event) => {
        (window as unknown as { __copied: string[] }).__copied.push(
          event.clipboardData?.getData('text/plain') ?? '',
        );
      });
    });
    const row = page.locator('.cinder-terminal__viewport .xterm-rows > div').first();
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await focusTerminal(page);
    await page.keyboard.press(chord);
    expect(await sentBytes(page), 'a selection wins: native copy, no interrupt').toEqual([]);
    await expect(page.locator('.xterm-selection div').first()).toBeVisible();
    const copied = await page.evaluate(
      () => (window as unknown as { __copied: string[] }).__copied,
    );
    // Chromium does not raise `copy` for the engine's empty helper field, so the payload is
    // checked wherever the browser reports it; the byte assertion above holds in every engine.
    if (copied.length > 0) expect(copied.at(-1)).toMatch(/^developer@/);
  });

  test('copying the selection announces it once and sends nothing', async ({ terminalPage }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    const mac = await isMac(page);
    const chord = mac ? 'Meta+c' : 'Control+c';
    await resetSent(page);
    const row = page.locator('.cinder-terminal__viewport .xterm-rows > div').first();
    const box = (await row.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await focusTerminal(page);
    await expect(page.locator('.xterm-selection div').first()).toBeVisible();
    expect(await announcementText(page), 'selecting alone announces nothing').not.toContain(
      'Terminal selection copied',
    );
    await page.keyboard.press(chord);
    await expect
      .poll(async () => await announcementText(page))
      .toContain('Terminal selection copied');
    expect(await sentBytes(page), 'a copy sends no terminal byte').toEqual([]);
  });
});

test.describe('paste review', () => {
  test('a plain single line is sent at once when bracketed paste is off', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    await paste(page, 'echo hello');
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(await sentBytes(page)).toEqual(bytes('echo hello'));
  });

  test('multiline and control text is reviewed, cancel sends nothing, accept sends it exactly', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    await paste(page, `one\ntwo${ESC}[31m\n`);
    const dialog = page.getByRole('dialog', { name: 'Review paste' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2 lines');
    await expect(dialog).toContainText('Ends with a newline');
    await expect(dialog).toContainText('Contains 1 control character');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await sentBytes(page), 'a cancelled paste sends nothing').toEqual([]);
    await expect(terminalInput(page)).toBeFocused();

    await paste(page, `one\ntwo${ESC}[31m\n`);
    await dialog.getByRole('button', { name: 'Paste' }).click();
    await expect(dialog).toBeHidden();
    // The engine turns each line break into a carriage return and nothing else changes.
    expect(await sentBytes(page)).toEqual(bytes(`one\rtwo${ESC}[31m\r`));
    await frames(page);
    expect(await sentOperations(page)).toHaveLength(1);
  });

  test('every bracketed paste is reviewed, and its payload goes out exactly between the markers', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await write(page, `${ESC}[?2004h`);
    await focusTerminal(page);
    await paste(page, 'ls');
    const dialog = page.getByRole('dialog', { name: 'Review paste' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Paste' }).click();
    expect(await sentBytes(page)).toEqual(bytes(`${ESC}[200~ls${ESC}[201~`));

    await resetSent(page);
    const payload = `a${ESC}[201~b\n`;
    await paste(page, payload);
    await expect(dialog).toContainText('bracketed paste terminator');
    await dialog.getByRole('button', { name: 'Paste' }).click();
    expect(await sentBytes(page)).toEqual(bytes(`${ESC}[200~a${ESC}[201~b\r${ESC}[201~`));
  });

  test('a paste over the limit is refused whole and nothing is sent', async ({ terminalPage }) => {
    const page = await terminalPage.open({ query: { maxPaste: 8 } });
    await focusTerminal(page);
    await paste(page, 'this is much longer than eight bytes');
    const dialog = page.getByRole('dialog', { name: 'Paste is too large' });
    await expect(dialog).toContainText('Nothing was sent');
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    expect(await sentBytes(page)).toEqual([]);
  });

  test('capture comes back after the review closes, and the review keys do not reach the shell', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await captureKeys(page);
    await paste(page, 'a\nb');
    const dialog = page.getByRole('dialog', { name: 'Review paste' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await sentBytes(page)).toEqual([]);
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(terminalInput(page)).toBeFocused();
  });
});

test.describe('read-only and refused input', () => {
  test('a read-only view sends nothing for typing, paste, queries or interrupts', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { state: 'read-only' } });
    await focusTerminal(page);
    await page.keyboard.type('nothing');
    await page.keyboard.press('Enter');
    await paste(page, 'pasted');
    await write(page, `${ESC}[c${ESC}[6n${ESC}[5n`);
    await expect(captureButton(page)).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(await sentBytes(page)).toEqual([]);
    expect(await page.evaluate(() => window.terminalLab!.session.inputCalls)).toBe(0);
    await expect(page.getByRole('status').filter({ hasText: 'Read-only' }).first()).toBeVisible();
    // A paste was asked for on purpose, so it is answered; typing is not announced.
    await expect
      .poll(async () => await announcementText(page))
      .toContain('The terminal is read-only. Nothing was sent.');
  });

  test('a full operation queue refuses input, says so once, and resumes only after the state cycles', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    await page.evaluate(() => {
      window.terminalLab!.session.inputMode = 'fifo-full';
    });
    await page.keyboard.type('ab');
    await page.evaluate(() => {
      window.terminalLab!.session.inputMode = 'accept';
    });
    await page.keyboard.type('c');
    expect(await sentBytes(page), 'input stays paused even though the queue drained').toEqual([]);
    const refusals = await page.evaluate(() => window.terminalLab!.events.refusals);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['paused', 'paused', 'paused']);
    await expect
      .poll(async () => await announcementText(page))
      .toContain('Terminal input paused. Keystrokes are not being sent.');
    await page.evaluate(() => window.terminalLab!.setProps({ state: 'backpressured' }));
    await expect(page.getByText('Backpressure: input paused')).toBeVisible();
    await page.evaluate(() => window.terminalLab!.setProps({ state: 'writable' }));
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await focusTerminal(page);
    await page.keyboard.type('d');
    expect(await sentBytes(page)).toEqual(bytes('d'));
  });

  test('an unknown delivery freezes input for the life of the session and is never replayed', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await focusTerminal(page);
    await page.evaluate(() => {
      window.terminalLab!.session.inputMode = 'throw';
    });
    await page.keyboard.type('x');
    await page.evaluate(() => {
      window.terminalLab!.session.inputMode = 'accept';
    });
    await page.keyboard.type('yz');
    const lab = await page.evaluate(() => ({
      calls: window.terminalLab!.session.inputCalls,
      reasons: window.terminalLab!.events.refusals.map((refusal) => refusal.reason),
    }));
    expect(lab.calls, 'nothing is retried or replayed').toBe(1);
    expect(lab.reasons).toEqual(['unknown-delivery', 'frozen', 'frozen']);
    expect(await sentBytes(page)).toEqual([]);
  });

  test('revoked authority refuses input and ends capture', async ({ terminalPage }) => {
    const page = await terminalPage.open();
    await captureKeys(page);
    await page.evaluate(() => window.terminalLab!.session.revoke());
    await page.keyboard.type('q');
    expect(await sentBytes(page)).toEqual([]);
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'false');
  });
});
