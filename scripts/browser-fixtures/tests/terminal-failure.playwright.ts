import { prepareSvelteServerSource, renderSvelteOnServer } from '@lostgradient/testing';
import type { Browser, Page, Route } from '@playwright/test';
import { resolve } from 'node:path';

import { environmentConfiguration } from '../environment-configuration.ts';

import {
  captureButton,
  expect,
  focusTerminal,
  frames,
  sentBytes,
  sideEffects,
  terminalEntry,
  terminalInput,
  terminalReady,
  test,
  write,
} from './terminal-support.ts';

const terminalSource = resolve(
  import.meta.dirname,
  '../../../components/terminal/src/lib/components/terminal/terminal.svelte',
);

// The server render runs in a child process that compiles Svelte for development unless NODE_ENV
// says otherwise, and a mix of development and production output cannot render. The unit suites
// run under `bun test`, which sets it.
process.env['NODE_ENV'] ??= 'test';

// The server render is a DOM-free process; compile its graph once, outside any timed test.
await prepareSvelteServerSource(terminalSource);

const ENGINE_MARKER = 'xterm-helper-textarea';
const FAILURE_DIAGNOSTICS = [
  /Failed to load resource/i,
  /Refused to (load|execute)/i,
  /Content[ -]Security[ -]Policy/i,
  /Loading failed for the module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Load failed/i,
  /TypeError/i,
  /Failed to fetch dynamically imported module/i,
  /fetch/i,
];

type Scripts = { engine: string[]; other: string[] };

/** The script files the page loads, split by whether they carry the engine. */
async function scoutScripts(browser: Browser): Promise<Scripts> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const urls = new Set<string>();
    page.on('response', (response) => {
      if (response.url().endsWith('.js')) urls.add(response.url());
    });
    const entry = terminalEntry();
    const hash = entry.fixtures!.find((fixture) => fixture.name === 'lab')!.fixtureContentHash;
    const base = environmentConfiguration().browserFixtureUrl ?? '';
    await page.goto(`${base}${entry.route}?fixture=lab&fixtureContentHash=${hash}&quiet=1`);
    await terminalReady(page);
    const scripts: Scripts = { engine: [], other: [] };
    for (const url of urls) {
      const response = await page.request.get(url);
      const body = await response.text();
      (body.includes(ENGINE_MARKER) ? scripts.engine : scripts.other).push(url);
    }
    return scripts;
  } finally {
    await context.close();
  }
}

/** Answer every request for an engine script with `handle`, and let everything else through. */
async function interceptEngine(
  page: Page,
  engine: string[],
  handle: (route: Route) => Promise<void>,
): Promise<void> {
  for (const url of engine) await page.route(url, handle);
}

const failureOptions = { quiet: true, recovery: true } as const;
const failureMessage = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Terminal engine unavailable' });

async function expectCleanFailure(page: Page, phase: string): Promise<void> {
  await expect(failureMessage(page).first()).toBeVisible();
  await expect(page.locator('.cinder-terminal-frame')).toHaveAttribute(
    'data-cinder-status',
    'error',
  );
  await expect(page.locator('.xterm')).toHaveCount(0);
  await expect(terminalInput(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  const lab = await page.evaluate(() => ({
    failures: window.terminalLab!.session.failures,
    live: window.terminalLab!.session.subscriptions.live,
    calls: window.terminalLab!.session.inputCalls,
  }));
  expect(lab.failures.map((failure) => failure.phase)).toEqual([phase]);
  expect(lab.live, 'the output subscription was released').toBe(0);
  await page.keyboard.type('keys with nowhere to go');
  expect(await sentBytes(page)).toEqual([]);
  expect(lab.calls).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
}

test.describe('server render and hydration', () => {
  test('the server markup is inert, and hydrating it adopts it without a second engine or any process', async ({
    terminalPage,
  }) => {
    const markup = await renderSvelteOnServer(terminalSource, {
      title: 'Build shell',
      state: 'writable',
    });
    expect(markup).toContain('Loading terminal…');
    expect(markup).not.toContain('xterm');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('<script');

    const requests: string[] = [];
    const page = await terminalPage.open({
      query: { hydrate: true, gate: false, quiet: true },
      prepare: async (target) => {
        await target.addInitScript((html) => {
          (window as unknown as { terminalServerMarkup: string }).terminalServerMarkup = html;
        }, markup);
        target.on('request', (request) => requests.push(request.url()));
      },
    });
    await expect(page.locator('.cinder-terminal__viewport:not([inert])')).toHaveCount(1);
    await expect(page.locator('.xterm')).toHaveCount(1);
    await expect(terminalInput(page)).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Build shell' })).toHaveCount(1);
    await expect(page.locator('.cinder-terminal__message')).toHaveCount(1);
    await expect(page.locator('.cinder-terminal__message')).toHaveText('Connected');

    const state = await page.evaluate(() => ({
      subscriptions: window.terminalLab!.session.subscriptions,
      calls: window.terminalLab!.session.inputCalls,
      sent: window.terminalLab!.session.sent.length,
      mounts: window.terminalLab!.lifecycle.mounts,
      grids: window.terminalLab!.events.geometry.length,
    }));
    expect(state).toEqual({
      subscriptions: { total: 1, live: 1 },
      calls: 0,
      sent: 0,
      mounts: 1,
      grids: 1,
    });
    const effects = await sideEffects(page);
    expect(effects.sockets).toEqual([]);
    expect(effects.workers).toEqual([]);
    expect(effects.eventSources).toEqual([]);
    expect(effects.beacons).toEqual([]);
    expect(requests.filter((url) => !url.startsWith(new URL(page.url()).origin))).toEqual([]);
    // The hydrated terminal is the live one: output reaches it and a key reaches the session.
    await write(page, 'hydrated');
    await focusTerminal(page);
    await page.keyboard.type('x');
    expect(await sentBytes(page)).toEqual([0x78]);
  });
});

test.describe('negative controls', () => {
  test('a 404 for the engine shows the specified failure and cleans up', async ({
    terminalPage,
    browser,
  }) => {
    const { engine } = await scoutScripts(browser);
    expect(engine.length, 'the engine is a separate script the control can deny').toBeGreaterThan(
      0,
    );
    const page = await terminalPage.open({
      query: failureOptions,
      expectedDiagnostics: FAILURE_DIAGNOSTICS,
      prepare: (target) =>
        interceptEngine(target, engine, (route) =>
          route.fulfill({ status: 404, body: 'Not found' }),
        ),
    });
    await expectCleanFailure(page, 'load');
  });

  test('a Content Security Policy that denies the engine shows the same failure', async ({
    terminalPage,
    browser,
  }) => {
    const { engine, other } = await scoutScripts(browser);
    const violations: string[] = [];
    const page = await terminalPage.open({
      query: failureOptions,
      expectedDiagnostics: FAILURE_DIAGNOSTICS,
      prepare: async (target) => {
        await target.addInitScript(() => {
          document.addEventListener('securitypolicyviolation', (event) => {
            (window as unknown as { __violations: string[] }).__violations ??= [];
            (window as unknown as { __violations: string[] }).__violations.push(event.blockedURI);
          });
        });
        // Every script but the engine's is allowed, by exact address.
        await target.route('**/page/terminal*', async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            headers: {
              ...response.headers(),
              'content-security-policy': `script-src 'unsafe-inline' ${other.join(' ')}`,
            },
          });
        });
      },
    });
    await expectCleanFailure(page, 'load');
    violations.push(
      ...(await page.evaluate(
        () => (window as unknown as { __violations?: string[] }).__violations ?? [],
      )),
    );
    expect(violations.length, 'the browser reported the denial').toBeGreaterThan(0);
    expect(engine).toEqual(expect.arrayContaining([violations[0]!]));
  });

  test('canceling initialization before the engine arrives leaves nothing behind', async ({
    terminalPage,
    browser,
  }) => {
    const { engine } = await scoutScripts(browser);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held: Route[] = [];
    const page = await terminalPage.open({
      query: { gate: false },
      // Firefox holds the load event for a module import that is still in flight.
      waitUntil: 'domcontentloaded',
      waitForReady: false,
      prepare: (target) =>
        interceptEngine(target, engine, async (route) => {
          held.push(route);
          await gate;
          await route.continue();
        }),
    });
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(page.getByText('Loading terminal…').first()).toBeVisible();
    // The host cancels: the terminal leaves the state that mounts an engine, then the engine arrives.
    await page.evaluate(() => window.terminalLab!.setProps({ state: 'empty' }));
    await expect(page.getByText('No terminal session').first()).toBeVisible();
    release();
    await frames(page, 6);
    await page.evaluate(() => window.terminalLab!.unmount());
    await frames(page, 3);
    await expect(page.locator('.xterm')).toHaveCount(0);
    await expect(terminalInput(page)).toHaveCount(0);
    const lab = await page.evaluate(() => ({
      failures: window.terminalLab!.session.failures,
      subscriptions: window.terminalLab!.session.subscriptions,
    }));
    expect(lab.failures).toEqual([]);
    expect(lab.subscriptions.live).toBe(0);
  });

  test('a host handler that throws while the engine renders fails closed, and Retry waits for the host', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({
      query: { ...failureOptions, throwOn: 'geometry' },
      waitForReady: false,
    });
    await expectCleanFailure(page, 'render');
    // Retry hands the decision to the host, which supplies a new session; only then is it live.
    await page.getByRole('button', { name: 'Retry' }).click();
    expect(await page.evaluate(() => window.terminalLab!.events.recoveryRequests)).toBe(1);
    await expect(page.locator('.xterm')).toHaveCount(0);
  });

  test('a program that makes a host handler throw mid-session fails closed', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({
      query: { ...failureOptions, throwOn: 'title' },
    });
    await focusTerminal(page);
    // The engine never acknowledges a chunk that failed it, so this does not wait for one.
    await page.evaluate(() => window.terminalLab!.session.write('\u001b]0;boom\u0007'));
    await expect(failureMessage(page).first()).toBeVisible();
    await expect(page.locator('.xterm')).toHaveCount(0);
    const lab = await page.evaluate(() => ({
      failures: window.terminalLab!.session.failures.map((failure) => failure.phase),
      live: window.terminalLab!.session.subscriptions.live,
    }));
    expect(lab.failures).toEqual(['parse']);
    expect(lab.live).toBe(0);
    await expect(captureButton(page)).toHaveCount(0);
    await page.keyboard.type('nothing');
    expect(await sentBytes(page)).toEqual([]);
  });
});
