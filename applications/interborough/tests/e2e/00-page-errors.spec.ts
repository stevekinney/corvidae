/**
 * The suite fails a test whose page reports an error (COR-1643): a console error, an uncaught
 * exception, or a request that dies. Each case here makes the page report one, and expects the
 * fixture in `fixtures.ts` to fail the test for it (`test.fail`), so a change that stops the fixture
 * collecting turns a passing test into a failing one. The last two show what it lets through.
 */
import { expect, loggedFailedResponse, test } from './fixtures.ts';

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
