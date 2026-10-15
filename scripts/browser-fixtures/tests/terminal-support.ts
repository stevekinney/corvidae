import type { ComponentEntry, Theme, Viewport } from '@lostgradient/testing';
import {
  loadManifest,
  THEME_STORAGE_KEY,
  themeContextOptions,
  VIEWPORTS,
} from '@lostgradient/testing';
import {
  test as base,
  expect,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from '@playwright/test';

import { environmentConfiguration } from '../environment-configuration.ts';

/**
 * Shared helpers for the terminal browser specs. Every spec drives the terminal fixture host
 * (`src/fixtures/terminal.svelte`) through the page like a reader and asserts on exact bytes: what
 * the scripted session was written, and what the component offered back to it.
 */

export type OpenTerminalOptions = {
  fixture?: string;
  theme?: Theme;
  viewport?: Viewport['name'] | { width: number; height: number };
  /** Knobs the host reads from the URL: `state`, `mouse`, `links`, `recovery`, `probes`, and more. */
  query?: Record<string, string | number | boolean>;
  context?: BrowserContextOptions;
  /** Runs against the page before it navigates, for init scripts and routes. */
  prepare?: (page: Page) => void | Promise<void>;
  waitUntil?: 'load' | 'domcontentloaded' | 'commit';
  /** Wait for the terminal to be ready before returning. Default true. */
  waitForReady?: boolean;
  /** Diagnostics the spec expects; anything else the page logs fails the test. */
  expectedDiagnostics?: RegExp[];
};

export type SideEffects = {
  clipboardWrites: string[];
  clipboardReads: number;
  opened: string[];
  dialogs: string[];
  fetches: string[];
  beacons: string[];
  sockets: string[];
  workers: string[];
  eventSources: string[];
  downloads: string[];
  /** Every distinct message the polite live regions showed, in order. */
  announced: string[];
};

declare global {
  interface Window {
    __sideEffects?: SideEffects;
  }
}

type TerminalPageFixture = {
  open(options?: OpenTerminalOptions): Promise<Page>;
  diagnostics: string[];
};

export function terminalEntry(): ComponentEntry {
  const entry = loadManifest().find((candidate) => candidate.slug === 'terminal');
  if (entry === undefined) throw new Error('The terminal fixture group is not in the manifest.');
  return entry;
}

function fixtureRoute(options: OpenTerminalOptions): string {
  const entry = terminalEntry();
  const name = options.fixture ?? 'lab';
  const fixture = entry.fixtures?.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`Terminal fixture '${name}' is not declared.`);
  const params = new URLSearchParams({
    fixture: name,
    fixtureContentHash: fixture.fixtureContentHash,
  });
  for (const [key, value] of Object.entries(options.query ?? {})) {
    params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  return `${entry.route}?${params.toString()}`;
}

/** Records every way the page could affect anything outside the terminal, for the hostile specs. */
function installSideEffectRecorder(): void {
  // The emulated Chrome device sends a Windows user agent from whatever host runs it, while the
  // engine reads `navigator.platform`. Make the two agree, as they do in a real browser, so the
  // engine and the component pick the same selection modifier.
  const hints = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  if (hints?.platform === 'Windows') {
    Object.defineProperty(Navigator.prototype, 'platform', {
      get: () => 'Win32',
      configurable: true,
    });
  }
  const effects: SideEffects = {
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
    announced: [],
  };
  window.__sideEffects = effects;
  // A live region's text is replaced by the next message, and the announcer clears it first so a
  // repeated message is heard again. Record every message the region took, in order, including
  // repeats, by rebuilding each text node's history from the observer's old values.
  const insideRegion = (node: Node): boolean =>
    node.parentElement?.closest('[aria-live="polite"]') != null;
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((records) => {
      const olds = new Map<Node, string[]>();
      for (const record of records) {
        if (record.type === 'characterData') {
          const list = olds.get(record.target) ?? [];
          list.push(record.oldValue ?? '');
          olds.set(record.target, list);
        } else if (insideRegion(record.target) || record.target.nodeType === 1) {
          for (const added of record.addedNodes) {
            const text = added.textContent?.trim() ?? '';
            if (text !== '' && insideRegion(added)) effects.announced.push(text);
          }
        }
      }
      for (const [node, history] of olds) {
        if (!insideRegion(node)) continue;
        const values = [...history.slice(1), (node as CharacterData).data];
        let previous = history[0] ?? '';
        for (const value of values) {
          if (value.trim() !== '' && value !== previous) effects.announced.push(value.trim());
          previous = value;
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText(text: string) {
        effects.clipboardWrites.push(text);
        return Promise.resolve();
      },
      write() {
        effects.clipboardWrites.push('[clipboard.write]');
        return Promise.resolve();
      },
      readText() {
        effects.clipboardReads += 1;
        return Promise.resolve('');
      },
      read() {
        effects.clipboardReads += 1;
        return Promise.resolve([]);
      },
    },
  });
  window.open = (url) => {
    effects.opened.push(String(url));
    return null;
  };
  for (const name of ['alert', 'confirm', 'prompt'] as const) {
    window[name] = ((message?: unknown) => {
      effects.dialogs.push(`${name}:${String(message)}`);
      return name === 'prompt' ? null : name === 'confirm' ? false : undefined;
    }) as never;
  }
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    effects.fetches.push(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    return originalFetch(input, init);
  }) as typeof fetch;
  navigator.sendBeacon = (url) => {
    effects.beacons.push(String(url));
    return true;
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      effects.sockets.push(String(url));
      super(url, protocols);
    }
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      effects.workers.push(String(url));
      super(url, options);
    }
  };
  const NativeEventSource = window.EventSource;
  window.EventSource = class extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      effects.eventSources.push(String(url));
      super(url, init);
    }
  };
}

export const test = base.extend<{ terminalPage: TerminalPageFixture }>({
  terminalPage: async ({ browser }, use) => {
    const baseURL = environmentConfiguration().browserFixtureUrl;
    if (baseURL === undefined || baseURL.length === 0) {
      throw new Error('BROWSER_FIXTURE_URL must identify the fixture host.');
    }
    const contexts: BrowserContext[] = [];
    const diagnostics: string[] = [];
    const expected: RegExp[] = [];
    try {
      await use({
        diagnostics,
        async open(options = {}) {
          const theme = options.theme ?? 'light';
          const viewport =
            typeof options.viewport === 'object'
              ? options.viewport
              : (VIEWPORTS.find(
                  (candidate) => candidate.name === (options.viewport ?? 'desktop'),
                ) ?? VIEWPORTS[2]!);
          const context = await browser.newContext({
            ...themeContextOptions(theme),
            viewport: { width: viewport.width, height: viewport.height },
            baseURL,
            ...options.context,
          });
          await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
            THEME_STORAGE_KEY,
            theme,
          ] as const);
          await context.addInitScript(installSideEffectRecorder);
          contexts.push(context);
          expected.push(...(options.expectedDiagnostics ?? []));
          const page = await context.newPage();
          page.on('pageerror', (error) => diagnostics.push(`Page error: ${error.message}`));
          page.on('console', (message) => {
            if (message.type() === 'error' || message.type() === 'warning') {
              diagnostics.push(`Console ${message.type()}: ${message.text()}`);
            }
          });
          await options.prepare?.(page);
          await page.goto(fixtureRoute(options), { waitUntil: options.waitUntil ?? 'load' });
          if (options.waitForReady !== false) await terminalReady(page);
          return page;
        },
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
    const unexpected = diagnostics.filter(
      (line) => !expected.some((pattern) => pattern.test(line)),
    );
    expect(unexpected, `Unexpected page diagnostics:\n${unexpected.join('\n')}`).toEqual([]);
  },
});

export { expect };

// ---------------------------------------------------------------------------
// Page and session helpers
// ---------------------------------------------------------------------------

export async function terminalReady(page: Page): Promise<void> {
  await expect(page.locator('#terminal-stage')).toHaveAttribute('data-terminal-ready', 'true');
}

/** Two animation frames, so a paint or a Svelte flush that was queued has happened. */
export async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (total) => {
    for (let index = 0; index < total; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

export type ByteSource = string | readonly number[];

export function bytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

/** Write each piece to the scripted session as its own chunk and wait until the engine parsed all. */
export async function writeChunks(page: Page, pieces: readonly ByteSource[]): Promise<void> {
  await page.evaluate(async (chunks) => {
    const lab = window.terminalLab!;
    for (const chunk of chunks) {
      lab.session.write(typeof chunk === 'string' ? chunk : Uint8Array.from(chunk));
    }
    await lab.session.settled();
  }, pieces as ByteSource[]);
  await frames(page);
}

export async function write(page: Page, data: ByteSource): Promise<void> {
  await writeChunks(page, [data]);
}

/** Every byte the component offered to the session so far, flattened in order. */
export async function sentBytes(page: Page): Promise<number[]> {
  return page.evaluate(() => window.terminalLab!.session.sent.flat());
}

/** The chunks the component offered, one array per input operation. */
export async function sentOperations(page: Page): Promise<number[][]> {
  return page.evaluate(() => window.terminalLab!.session.sent.map((chunk) => [...chunk]));
}

export async function resetSent(page: Page): Promise<void> {
  await page.evaluate(() => window.terminalLab!.session.resetSent());
}

export async function sideEffects(page: Page): Promise<SideEffects> {
  return page.evaluate(() => structuredClone(window.__sideEffects!));
}

export function terminalInput(page: Page): Locator {
  return page.locator('textarea.xterm-helper-textarea');
}

export function terminalRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Build shell' });
}

export function captureButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Capture terminal keys' });
}

/** Put focus in the terminal's input surface without turning capture on. */
export async function focusTerminal(page: Page): Promise<void> {
  await terminalInput(page).focus();
  await expect(terminalInput(page)).toBeFocused();
}

/** Turn key capture on through the button, the way the experience spec says a reader does. */
export async function captureKeys(page: Page): Promise<void> {
  await captureButton(page).click();
  await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(terminalInput(page)).toBeFocused();
}

/** Whether the page runs on a Mac, by the same rule the component uses to pick its chords. */
export async function isMac(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? '');
  });
}

/** Open the Export dialog, return the snapshot text it shows, and close it again. */
export async function exportedText(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const snapshot = page.getByRole('textbox', { name: 'Terminal output snapshot' });
  await expect(snapshot).toBeVisible();
  const text = await snapshot.inputValue();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(snapshot).toBeHidden();
  return text;
}

/** The text of the engine's screen rows, as the reader sees them. */
export async function screenRows(page: Page): Promise<string[]> {
  return page
    .locator('.cinder-terminal__viewport .xterm-rows > div')
    .evaluateAll((rows) => rows.map((row) => row.textContent ?? ''));
}

/** A paste event carrying `text` as plain-text clipboard data, aimed at the input surface. */
export async function paste(page: Page, text: string): Promise<void> {
  await terminalInput(page).evaluate((target, value) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? value : '') },
    });
    target.dispatchEvent(event);
  }, text);
}

/** The text of the component's polite status regions, which is what a screen reader is told. */
export async function announcements(page: Page): Promise<string[]> {
  return terminalRegion(page)
    .locator('[aria-live="polite"]')
    .evaluateAll((regions) => regions.map((region) => region.textContent?.trim() ?? ''));
}

/** The key that moves focus to the next control: Safari on a Mac needs Option for that. */
export function navigationKey(browserName: string): string {
  return browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
}

/** How many times the polite regions took exactly this message. */
export async function announcedCount(page: Page, message: string): Promise<number> {
  const effects = await sideEffects(page);
  return effects.announced.filter((entry) => entry === message).length;
}

/** Every message the polite regions showed so far, joined, for polling on. */
export async function announcementText(page: Page): Promise<string> {
  const effects = await sideEffects(page);
  return effects.announced.join('|');
}

export async function screenText(page: Page): Promise<string> {
  const rows = await screenRows(page);
  return rows.join('|');
}

/** All the screen's text with the row breaks and surrounding space gone. */
export async function screenContent(page: Page): Promise<string> {
  const rows = await screenRows(page);
  return rows.join('').trim();
}

export async function lastScreenRow(page: Page): Promise<string | undefined> {
  const rows = await screenRows(page);
  return rows.at(-1);
}

export async function lastClipboardWrite(page: Page): Promise<string> {
  const effects = await sideEffects(page);
  return effects.clipboardWrites.at(-1) ?? '';
}

/**
 * The text the engine's selection holds, read the way the browser's own copy command reads it: the
 * engine answers a `copy` event with its selection. Line breaks are normalized, because the engine
 * uses CRLF when it believes it runs on Windows. Empty when nothing is selected.
 */
export async function selectedText(page: Page): Promise<string> {
  const copied = await page.evaluate(() => {
    const seen: string[] = [];
    const listen = (event: ClipboardEvent) => {
      seen.push(event.clipboardData?.getData('text/plain') ?? '');
    };
    document.addEventListener('copy', listen);
    document.querySelector<HTMLElement>('textarea.xterm-helper-textarea')?.focus();
    document.execCommand('copy');
    document.removeEventListener('copy', listen);
    return seen;
  });
  return (copied.at(-1) ?? '').replaceAll('\r\n', '\n');
}
