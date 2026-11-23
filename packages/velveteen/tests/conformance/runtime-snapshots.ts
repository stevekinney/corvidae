import { expect } from "@playwright/test";
import type { RuntimeCase } from "./runtime-cases.ts";

const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;

export const runtimeSnapshots: RuntimeCase = {
  id: "O-snapshots",
  group: "navigation",
  upstream:
    "packages/kit/test/apps/basics/test/playwright/client.test.js: snapshots, shallow navigation and abandoned history entries",
  async run({ url, page }) {
    await page.goto(path(url, "/snapshot-o/one"));
    await expect(page.locator("[data-snapshot-ready]")).toHaveText("ready");
    const input = page.locator("[data-snapshot-input]");
    await input.fill("one");
    await page
      .locator("[data-snapshot-one]")
      .getByRole("link", { name: "Two" })
      .click();
    await expect(page.locator("[data-snapshot-two]")).toBeVisible();
    await page.goBack();
    await expect(input).toHaveValue("one");
    await expect(page.locator("[data-snapshot-order]")).toHaveText(
      "afterNavigate,restore",
    );

    await page.getByRole("button", { name: "shallow" }).click();
    await page.waitForURL(/\/snapshot-o\/one\?shallow=1$/);
    await input.fill("two");
    await page.goBack();
    await page.waitForURL(/\/snapshot-o\/one$/);
    await expect(input).toHaveValue("one");
    await page.goForward();
    await page.waitForURL(/\/snapshot-o\/one\?shallow=1$/);
    await expect(input).toHaveValue("two");

    await page.goto(path(url, "/snapshot-o/one"));
    await expect(page.locator("[data-snapshot-ready]")).toHaveText("ready");
    await page.locator("[data-snapshot-input]").fill("reload value");
    await page.reload();
    await expect(page.locator("[data-snapshot-input]")).toHaveValue(
      "reload value",
    );
    await expect(page.locator("[data-snapshot-order]")).toHaveText(
      "afterNavigate,restore",
    );

    await page.goto(path(url, "/snapshot-o/branch/a"));
    await expect(page.locator("[data-snapshot-branch-nav]")).not.toHaveText(
      "0",
    );
    await page
      .locator("[data-snapshot-branch-a]")
      .getByRole("link", { name: "Branch B" })
      .click();
    await page.locator("[data-snapshot-branch-input]").fill("abandoned value");
    await page.getByRole("link", { name: "Branch A" }).click();
    await expect(page.locator("[data-snapshot-branch-nav]")).toBeVisible();
    const before = await page.evaluate(() =>
      Number(
        (globalThis as Record<string, unknown>).__oSnapshotNavigations ?? 0,
      ),
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          addEventListener("popstate", () => resolve(), { once: true });
          history.go(-2);
        }),
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number(
            (globalThis as Record<string, unknown>).__oSnapshotNavigations ?? 0,
          ),
        ),
      )
      .toBeGreaterThan(before);
    await page
      .locator("[data-snapshot-branch-a]")
      .getByRole("link", { name: "Branch B" })
      .click();
    await expect(page.locator("[data-snapshot-branch-input]")).toHaveValue("");
  },
};
