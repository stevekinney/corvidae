/**
 * The suite fails a test whose page reports an error (COR-1643): a console error, an uncaught
 * exception, or a request that dies. Each case here makes the page report one, and expects the
 * fixture in `fixtures.ts` to fail the test for it (`test.fail`), so a change that stops the fixture
 * collecting turns a passing test into a failing one. The last two show what it lets through.
 */
import { EventEmitter } from 'node:events';

import type { BrowserContext, Page } from '@playwright/test';

import { expect, loggedFailedResponse, PageErrorLog, test } from './fixtures.ts';

test.describe('a page that reports an error fails its test', () => {
  test('for a console error', async ({ page }) => {
    test.fail(true, 'the fixture must fail a test whose page logged a console error');
    await page.goto('/chat');
    await page.evaluate(() => console.error('something broke'));
  });

  test('for an uncaught exception', async ({ page }) => {
    test.fail(true, 'the fixture must fail a test whose page threw');
    await page.goto('/chat');
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('uncaught');
      }, 0);
    });
    await page.waitForTimeout(100);
  });

  test('for a request that dies', async ({ page }) => {
    test.fail(true, 'the fixture must fail a test whose page had a request fail');
    await page.goto('/chat');
    // Nothing listens on port 1: the connection is refused, which is not an abort.
    await page.evaluate(() => fetch('http://127.0.0.1:1/').catch(() => undefined));
  });

  test('for a response with an error status the test did not declare', async ({ page }) => {
    test.fail(true, 'the fixture must fail a test whose page logged a failed response');
    await page.goto('/chat');
    await page.evaluate(() => fetch('/bureau/missing'));
  });
});

test.describe('a declaration covers only what it says', () => {
  test('a second matching report fails the test', async ({ page, pageErrors }) => {
    test.fail(true, 'one declaration covers one report, so the second is unexpected');
    pageErrors.expect({
      pattern: loggedFailedResponse(404, /\/bureau\/missing/),
      reason: 'the test asks the Bureau for a path it does not serve',
    });
    await page.goto('/chat');
    await page.evaluate(async () => {
      await fetch('/bureau/missing');
      await fetch('/bureau/missing');
    });
  });

  test('a declaration its pages never made fails the test', async ({ page, pageErrors }) => {
    test.fail(true, 'a declared report that never happened is a failure');
    pageErrors.expect({
      pattern: loggedFailedResponse(404, /\/bureau\/missing/),
      reason: 'the test declares a failure it does not cause',
    });
    await page.goto('/chat');
  });

  test('a declaration with a count covers that many', async ({ page, pageErrors }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(404, /\/bureau\/missing/),
      reason: 'the test asks the Bureau twice for a path it does not serve',
      count: 2,
    });
    await page.goto('/chat');
    await page.evaluate(async () => {
      await fetch('/bureau/missing');
      await fetch('/bureau/missing');
    });
  });
});

test.describe('every page of the context is watched', () => {
  test('a second tab that logs an error fails the test', async ({ context, page }) => {
    test.fail(true, 'the fixture must fail a test whose second tab logged a console error');
    await page.goto('/chat');
    const second = await context.newPage();
    await second.goto('/chat');
    await second.evaluate(() => console.error('the second tab broke'));
  });

  test('a declaration covers a report from a second tab', async ({ context, page, pageErrors }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(404, /\/bureau\/missing/),
      reason: 'the second tab asks the Bureau for a path it does not serve',
    });
    await page.goto('/chat');
    const second = await context.newPage();
    await second.goto('/chat');
    await second.evaluate(() => fetch('/bureau/missing'));
  });
});

/** A page that only emits what the log listens for, so the log's own counting can be asserted. */
function fakePage(): Page & EventEmitter {
  return new EventEmitter() as Page & EventEmitter;
}

function fakeContext(pages: Page[]): BrowserContext & EventEmitter {
  const context = new EventEmitter() as BrowserContext & EventEmitter;
  Object.assign(context, { pages: () => pages });
  return context;
}

function consoleError(text: string): unknown {
  return { type: () => 'error', text: () => text, location: () => ({ url: '', lineNumber: 0 }) };
}

const NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

test.describe('the log counts reports against declarations', () => {
  const declaration = {
    pattern: /status of 404/,
    reason: 'the test asks for a path nothing serves',
  };

  test('one declaration covers one report and leaves the next unexpected', () => {
    const first = fakePage();
    const context = fakeContext([first]);
    const log = new PageErrorLog(context);
    log.expect(declaration);
    first.emit('console', consoleError(NOT_FOUND));
    first.emit('console', consoleError(NOT_FOUND));
    expect(log.unexpected()).toHaveLength(1);
    expect(log.unused()).toEqual([]);
  });

  test('a count covers that many reports and no more', () => {
    const first = fakePage();
    const log = new PageErrorLog(fakeContext([first]));
    log.expect({ ...declaration, count: 2 });
    for (let report = 0; report < 3; report += 1) {
      first.emit('console', consoleError(NOT_FOUND));
    }
    expect(log.unexpected()).toHaveLength(1);
  });

  test('a declaration nothing matched is reported as unused', () => {
    const log = new PageErrorLog(fakeContext([fakePage()]));
    log.expect(declaration);
    expect(log.unexpected()).toEqual([]);
    expect(log.unused()).toHaveLength(1);
    expect(log.unused()[0]).toContain('expected 1, saw 0');
  });

  test('a page created later is watched, and the first page is not watched twice', () => {
    const first = fakePage();
    const context = fakeContext([first]);
    const log = new PageErrorLog(context);
    const later = fakePage();
    context.emit('page', later);
    // The context announcing a page the log already holds must not add a second listener.
    context.emit('page', first);
    first.emit('console', consoleError('first'));
    later.emit('console', consoleError('later'));
    expect(log.unexpected()).toHaveLength(2);
    expect(first.listenerCount('console')).toBe(1);
    expect(later.listenerCount('console')).toBe(1);
  });
});

test.describe('what the fixture lets through', () => {
  test('a report the test declares it caused', async ({ page, pageErrors }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(404, /\/bureau\/missing/),
      reason: 'the test asks the Bureau for a path it does not serve',
    });
    await page.goto('/chat');
    const status = await page.evaluate(async () => {
      const response = await fetch('/bureau/missing');
      return response.status;
    });
    expect(status).toBe(404);
  });

  test('a request the page cancels itself, which Chromium does not log', async ({ page }) => {
    await page.goto('/chat');
    await page.evaluate(async () => {
      const controller = new AbortController();
      const pending = fetch('/bureau/v1/health', { signal: controller.signal }).catch(
        () => undefined,
      );
      controller.abort();
      await pending;
    });
  });
});
