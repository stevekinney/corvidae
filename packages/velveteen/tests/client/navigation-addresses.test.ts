import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { readDataResponse } from "../../src/data/transport.ts";
import {
  addressIdentifierPath,
  startNavigationAddressRuntime,
  type NavigationAddressRuntime,
} from "./navigation-addresses-fixture.ts";

declare global {
  interface Window {
    addressNavigation: {
      goto(url: string, options?: { replace?: boolean }): Promise<void>;
    };
  }
}

let browser: Browser;
const runtimes: NavigationAddressRuntime[] = [];
const contexts: BrowserContext[] = [];
const pages: Page[] = [];
const browserDiagnostics: string[] = [];
const expectText = async (page: Page, selector: string, value: string) => {
  await page.waitForFunction(
    ([candidate, expected]) =>
      document.querySelector(candidate)?.textContent === expected,
    [selector, value],
  );
};

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  for (const mode of ["development", "production"] as const) {
    const runtime = await startNavigationAddressRuntime(mode);
    runtimes.push(runtime);
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) =>
      browserDiagnostics.push(`${mode}:pageerror:${error.message}`),
    );
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        browserDiagnostics.push(`${mode}:console:${message.text()}`);
    });
    await page.goto(new URL(`${runtime.basePath}/`, runtime.server.url).href);
    await page.waitForFunction(() => "addressNavigation" in window);
  }
});

afterAll(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  for (const runtime of runtimes) await runtime.stop();
});

for (const [index, mode] of (
  ["development", "production"] as const
).entries()) {
  test(`${mode} preserves literal precedence and dynamic identifiers`, async () => {
    const page = pages[index];
    await page.getByRole("link", { name: "static new" }).click();
    await expectText(page, "[data-page]", "Static new");
    const token = await page.locator("[data-layout-token]").textContent();
    await page.evaluate(() =>
      window.addressNavigation.goto(
        "/address-fixture/addresses/%E2%9C%93%2F%25%7E",
      ),
    );
    await expectText(page, "[data-page]", "dynamic: ✓/%~");
    await page.evaluate(() =>
      window.addressNavigation.goto("/address-fixture/addresses/%252F"),
    );
    await expectText(page, "[data-page]", "dynamic: %2F");
    expect(await page.locator("[data-layout-token]").textContent()).toBe(token);
  });

  test(`${mode} preserves query duplicates, empties, and query-only replace`, async () => {
    const page = pages[index];
    await page.evaluate(() =>
      window.addressNavigation.goto(
        "/address-fixture/search?tag=one&tag=two&empty=&page=2&size=10&selected=alpha",
      ),
    );
    await expectText(
      page,
      "[data-query]",
      "tag=one|tag=two|empty=|page=2|size=10|selected=alpha",
    );
    await expectText(page, "[data-values]", "one,two");
    await expectText(page, "[data-empty]", "empty");
    const token = await page.locator("[data-layout-token]").textContent();
    await page.evaluate(() =>
      window.addressNavigation.goto("?tag=three&empty=", { replace: true }),
    );
    await expectText(page, "[data-values]", "three");
    expect(await page.locator("[data-layout-token]").textContent()).toBe(token);
  });

  test(`${mode} carries special identifiers and plugin rest paths`, async () => {
    const page = pages[index];
    await page.evaluate(
      (path) => window.addressNavigation.goto(`/address-fixture${path}`),
      addressIdentifierPath("item", "."),
    );
    await expectText(page, "[data-page]", "Item .");
    await page.evaluate(
      (path) => window.addressNavigation.goto(`/address-fixture${path}`),
      addressIdentifierPath("item", ".."),
    );
    await expectText(page, "[data-page]", "Item ..");
    await page.evaluate(() =>
      window.addressNavigation.goto(
        "/address-fixture/items/_?__fixture_item_id=wrong",
      ),
    );
    await expectText(page, "[data-page]", "Item _");
    await page.evaluate(() =>
      window.addressNavigation.goto(
        "/address-fixture/items/real?__fixture_item_id=..",
      ),
    );
    await expectText(page, "[data-page]", "Item real");
    await page.evaluate(
      (path) => window.addressNavigation.goto(`/address-fixture${path}`),
      addressIdentifierPath("address", "new"),
    );
    await expectText(page, "[data-page]", "dynamic: new");
    await page.evaluate(() =>
      window.addressNavigation.goto(
        "/address-fixture/plugins/demo/reviews/queue?page=2&size=10",
      ),
    );
    await expectText(page, "[data-page]", "Plugin demo/reviews/queue");
    const historyBeforeRedirect = await page.evaluate(() => history.length);
    await page.evaluate(() =>
      window.addressNavigation.goto("/address-fixture/redirect"),
    );
    await page.waitForFunction(
      () =>
        location.pathname.endsWith("/addresses/new") &&
        location.search === "?from=redirect",
    );
    await expectText(page, "[data-page]", "Static new");
    await page.evaluate(() => history.back());
    await page.waitForFunction(() =>
      location.pathname.endsWith("/plugins/demo/reviews/queue"),
    );
    expect(await page.evaluate(() => history.length)).toBe(
      historyBeforeRedirect + 1,
    );
    await expectText(page, "[data-page]", "Plugin demo/reviews/queue");
    await page.evaluate(() => history.forward());
    await expectText(page, "[data-page]", "Static new");
    expect(new URL(page.url()).pathname).toBe("/address-fixture/addresses/new");
    await page.evaluate(() =>
      window.addressNavigation.goto("/address-fixture/plugins/missing/reviews"),
    );
    await expectText(page, "[data-error]", "404: Not Found");
    await page.evaluate(() =>
      window.addressNavigation.goto("/address-fixture/plugins/demo"),
    );
    await expectText(page, "[data-error]", "404: Not Found");
  });
}

test("browser navigation emits no unexpected diagnostics", () => {
  expect(browserDiagnostics).toEqual([]);
});

test("malformed percent returns Kit-compatible 400", async () => {
  for (const runtime of runtimes) {
    const response = await fetch(
      `${runtime.server.url}${runtime.basePath}/address/%E0`,
    );
    expect(response.status).toBe(400);
    await response.text();
    const data = await fetch(
      `${runtime.server.url}${runtime.basePath}/address/%E0`,
      { headers: { accept: "application/x-velveteen-data" } },
    );
    expect(data.status).toBe(200);
    const decoded = await readDataResponse(data);
    expect(decoded.payload.status).toBe(400);
    await decoded.done;
  }
});
