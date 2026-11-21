import { expect } from "@playwright/test";
import type { RuntimeCase } from "./runtime-cases.ts";

const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;

/** Verify action results use the application transport on both submission paths. */
export const runtimeActionTransport: RuntimeCase = {
  id: "U-action-custom-transport",
  group: "actions",
  upstream:
    "packages/kit/test/apps/basics/test/playwright/test.js: A custom data type can be serialized/deserialized on POST; A custom data type can be serialized/deserialized on POST with use:enhance",
  async run({ url, browser, page }) {
    await page.goto(path(url, "/actions/native"));
    await page.waitForFunction(() => !!Reflect.get(window, "runtime"));
    await page.evaluate(() =>
      Reflect.set(window, "documentMarker", "native-source"),
    );
    await page.getByLabel("Name", { exact: true }).fill("U-Native");
    const [nativePost] = await Promise.all([
      page.waitForRequest(
        (request) =>
          request.isNavigationRequest() && request.method() === "POST",
      ),
      page.getByRole("button", { name: "Native submit", exact: true }).click(),
    ]);
    expect(new URL(nativePost.url()).pathname).toBe("/runtime/actions/native");
    await page.waitForFunction(() => !!Reflect.get(window, "runtime"));
    expect(
      await page.evaluate(() => Reflect.get(window, "documentMarker")),
    ).toBeUndefined();
    await expect(page.locator("[data-custom-instance]")).toHaveText("true");
    await page
      .getByRole("button", { name: "Use custom result", exact: true })
      .click();
    await expect(page.locator("[data-custom-interaction]")).toHaveText(
      "transport value: Action U-Native",
    );

    const nativeContext = await browser.newContext({
      javaScriptEnabled: false,
    });
    const nativePage = await nativeContext.newPage();
    try {
      await nativePage.goto(path(url, "/actions/native"));
      await nativePage.getByLabel("Name", { exact: true }).fill("U-Native");
      await nativePage
        .getByRole("button", { name: "Native submit", exact: true })
        .click();
      await expect(nativePage.locator("[data-custom-method]")).toHaveText(
        "transport value: Action U-Native",
      );
      await expect(nativePage.locator("[data-custom-instance]")).toHaveText(
        "true",
      );
    } finally {
      await nativeContext.close();
    }

    await page.goto(path(url, "/actions"));
    await page.waitForFunction(() => !!Reflect.get(window, "runtime"));
    await page.evaluate(() =>
      Object.assign(window, { documentMarker: "u-retained" }),
    );
    await page.getByLabel("Name", { exact: true }).fill("U-Enhanced");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.locator("[data-custom-instance]"),
      "U enhanced instance",
    ).toHaveText("true");
    await page
      .getByRole("button", { name: "Use custom result", exact: true })
      .click();
    await expect(page.locator("[data-custom-interaction]")).toHaveText(
      "transport value: Action U-Enhanced",
    );
    expect(
      await page.evaluate(() => Reflect.get(window, "documentMarker")),
    ).toBe("u-retained");
  },
};
