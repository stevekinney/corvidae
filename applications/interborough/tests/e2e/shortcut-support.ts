/**
 * Presses a `g` shortcut the way a person types it. The shell measures the chord window
 * (`CHORD_WINDOW_MS`, one second) between the key events' own `timeStamp`s, the times the browser
 * received them, so a page whose main thread is busy between two presses still takes a quick
 * chord. `page.keyboard.press` cannot type one: it sends the second key only once the page has
 * handled the first, so while a page is still painting the last destination (an open chat's
 * transcript holds the main thread for over a second on a loaded host), the second key is stamped
 * after the window has closed and the shortcut goes nowhere (COR-2633, COR-2638). Here each key is
 * sent with the time it is pressed at, so the window is measured between the presses themselves.
 *
 * @module shortcut-support
 */
import type { CDPSession, Page } from '@playwright/test';

/** A keyboard that presses `g` chords at times it sets, and the session it sends them on. */
export interface ChordKeyboard {
  /**
   * Presses `g`, then `letter` `intervalMilliseconds` later. Each chord is stamped after the last
   * one, so two chords never overlap.
   */
  press(letter: string, intervalMilliseconds?: number): Promise<void>;
  /** Ends the session the keys are sent on. */
  detach(): Promise<void>;
}

/** The time between the two keys of a chord a person types quickly. */
const QUICK_CHORD_MILLISECONDS = 50;

/**
 * Presses `g`, then `letter`, once, as {@link ChordKeyboard.press} does, on a session opened for it
 * and closed after.
 */
export async function pressChord(page: Page, letter: string): Promise<void> {
  const keyboard = await chordKeyboard(page);
  try {
    await keyboard.press(letter);
  } finally {
    await keyboard.detach();
  }
}

/** A keyboard for `page` that types `g` chords at the times it sets (see the module). */
export async function chordKeyboard(page: Page): Promise<ChordKeyboard> {
  const session: CDPSession = await page.context().newCDPSession(page);
  /** The earliest time the next chord may start at, so chords stay in order. */
  let nextKeyTime = 0;
  return {
    async press(letter, intervalMilliseconds = QUICK_CHORD_MILLISECONDS) {
      // Chromium delivers trusted key events at the input times they carry, in milliseconds since
      // the epoch here and seconds on the wire. A chord starts at the present on this machine's
      // clock, which the browser shares, never the page's: a spec may fix the page's clock
      // (`page.clock.setFixedTime`), and a key stamped at a fixed time weeks off never arrives.
      const start = Math.max(Date.now(), nextKeyTime);
      for (const [index, key] of ['g', letter].entries()) {
        const capital = key.toUpperCase();
        const event = {
          key,
          code: `Key${capital}`,
          windowsVirtualKeyCode: capital.charCodeAt(0),
          timestamp: (start + index * intervalMilliseconds) / 1000,
        };
        await session.send('Input.dispatchKeyEvent', {
          ...event,
          type: 'keyDown',
          text: key,
          unmodifiedText: key,
        });
        await session.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
      }
      nextKeyTime = start + intervalMilliseconds + 100;
    },
    detach: () => session.detach(),
  };
}
