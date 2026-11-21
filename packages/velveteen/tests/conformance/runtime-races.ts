import { expect } from "@playwright/test";
import type { RuntimeCase } from "./runtime-cases.ts";
const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;
const post = (url: string, route: string) =>
  fetch(path(url, route), {
    method: "POST",
    headers: { origin: new URL(url).origin },
  });
export const runtimeRaces: RuntimeCase[] = [
  {
    id: "F03-nested-errors",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: errors",
    async run({ url, page }) {
      await page.goto(path(url, "/items/one"));
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      await page.getByRole("button", { name: "Layout 0", exact: true }).click();
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/error"),
      );
      await expect(page.locator("[data-nested-error]")).toHaveText(
        "418: Teapot",
      );
      await expect(
        page.getByRole("button", { name: "Layout 1", exact: true }),
      ).toBeVisible();
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/redirect"),
      );
      await expect(
        page.getByRole("heading", { name: "Item two", exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/runtime/items/two");
    },
  },
  {
    id: "F03-stale-refresh",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: refreshAll finishing after navigation does not apply stale data",
    async run({ url, page }) {
      await page.goto(path(url, "/items/one"));
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      const key = crypto.randomUUID();
      expect((await post(url, `/arm?key=${key}`)).status).toBe(200);
      await page.evaluate(() => {
        Reflect.set(
          window,
          "refresh",
          Reflect.get(window, "runtime").refreshAll(),
        );
      });
      await expect
        .poll(async () => await (await fetch(path(url, "/pending"))).json())
        .toContain(key);
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/two"),
      );
      await expect(
        page.getByRole("heading", { name: "Item two", exact: true }),
      ).toBeVisible();
      expect((await post(url, `/release?key=${key}`)).status).toBe(200);
      await page.evaluate(() => Reflect.get(window, "refresh"));
      await expect(
        page.getByRole("heading", { name: "Item two", exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/runtime/items/two");
    },
  },
  {
    id: "F03-preload-race",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: data-sveltekit-preload does not abort ongoing navigation",
    async run({ url, page }) {
      await page.goto(path(url, "/items/one"));
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      const key = crypto.randomUUID();
      expect((await post(url, `/arm?key=${key}`)).status).toBe(200);
      await page.evaluate(() => {
        Reflect.set(
          window,
          "preloading",
          Reflect.get(window, "runtime").preloadData("/runtime/items/three"),
        );
      });
      await expect
        .poll(async () => await (await fetch(path(url, "/pending"))).json())
        .toContain(key);
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/two"),
      );
      await expect(
        page.getByRole("heading", { name: "Item two", exact: true }),
      ).toBeVisible();
      expect((await post(url, `/release?key=${key}`)).status).toBe(200);
      await page.evaluate(() => Reflect.get(window, "preloading"));
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/three"),
      );
      await expect(
        page.getByRole("heading", { name: "Item three", exact: true }),
      ).toBeVisible();
      await expect(page.locator("[data-page]")).toHaveText(
        "universal-layout/fetched/",
      );
    },
  },
  {
    id: "E04-rejection",
    group: "server",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: Works for server load functions (client nav)",
    async run({ url, page }) {
      await page.goto(path(url, "/items/one"));
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      const key = crypto.randomUUID();
      await page.evaluate(
        (route) => Reflect.get(window, "runtime").goto(route),
        `/runtime/deferred?key=${key}`,
      );
      await expect(page.locator("[data-pending]")).toHaveText("Pending");
      expect((await post(url, `/release?key=${key}&reject`)).status).toBe(200);
      await expect(page.locator("[data-rejected]")).toHaveText(
        "Internal Error",
      );
      expect(await page.content()).not.toContain("PRIVATE_DEFERRED_SENTINEL");
    },
  },
];
