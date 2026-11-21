import { expect } from "@playwright/test";
import type { RuntimeCase } from "./runtime-cases.ts";
const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;
export const runtimeActions: RuntimeCase[] = [
  {
    id: "G01-enhanced-error",
    group: "actions",
    upstream: "basics/test/playwright/test.js: action error boundary",
    expectedHttpErrors: [418],
    async run({ url, page }) {
      await page.goto(path(url, "/actions"));
      await page.waitForFunction(() => !!Reflect.get(window, "runtime"));
      await page.getByRole("button", { name: "Error", exact: true }).click();
      await expect(page.locator("[data-error]")).toHaveText(
        "418: Action teapot",
      );
    },
  },
  {
    id: "G01-enhanced",
    group: "actions",
    upstream:
      "basics/test/playwright/test.js: form success, files, validation and submitter",
    expectedHttpErrors: [422],
    async run({ url, page }) {
      await page.goto(path(url, "/actions"));
      await page.waitForFunction(() => !!Reflect.get(window, "runtime"));
      await page.getByRole("button", { name: "Layout 0" }).click();
      await expect(
        page.getByRole("button", { name: "Layout 1" }),
      ).toBeVisible();
      await page.evaluate(() =>
        Object.assign(window, { documentMarker: "retained" }),
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("[data-result]")).toHaveText("Name required");
      await expect(page.locator("[data-status]")).toHaveText("422");
      await page.getByLabel("Name", { exact: true }).fill("Alice");
      await page.getByLabel("File", { exact: true }).setInputFiles({
        name: "proof.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("File content"),
      });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.locator("[data-result]")).toHaveText("Saved Alice");
      await expect(page.locator("[data-file]")).toHaveText(
        "proof.txt:File content",
      );
      await expect(page.locator("[data-submitter]")).toHaveText("save");
      await expect(page.locator("[data-saved]")).toHaveText("Alice");
      await expect(page.locator("[data-status]")).toHaveText("200");
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
      expect(
        await page.evaluate(() => Reflect.get(window, "documentMarker")),
      ).toBe("retained");
      await expect(
        page.getByRole("button", { name: "Layout 1" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Redirect", exact: true }).click();
      await expect(page.locator("h1")).toHaveText("Default action");
      await page.getByLabel("Name", { exact: true }).fill("Bob");
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await expect(page.locator("[data-result]")).toHaveText("Default Bob");
      expect(
        await page.evaluate(() => Reflect.get(window, "documentMarker")),
      ).toBe("retained");
      await page.getByLabel("Name", { exact: true }).fill("Carol");
      await page
        .getByRole("button", { name: "Cross-page", exact: true })
        .click();
      await expect(page.locator("[data-result]")).toHaveText("Saved Carol");
      await expect(page.locator("[data-saved]")).toHaveText("Carol");
      expect(new URL(page.url()).pathname).toBe("/runtime/actions");
      expect(new URL(page.url()).search).toBe("");
      expect(
        await page.evaluate(() => Reflect.get(window, "documentMarker")),
      ).toBe("retained");
    },
  },
  {
    id: "G01-native",
    group: "actions",
    upstream: "basics/test/playwright/test.js: forms without JavaScript",
    async run({ url, browser }) {
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      try {
        await page.goto(path(url, "/actions"));
        const invalid = page.waitForResponse(
          (response) => response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Save", exact: true }).click();
        expect((await invalid).status()).toBe(422);
        await expect(page.locator("[data-result]")).toHaveText("Name required");
        await page.getByLabel("Name", { exact: true }).fill("Native");
        await page.getByLabel("File", { exact: true }).setInputFiles({
          name: "native.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Native file"),
        });
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("[data-result]")).toHaveText("Saved Native");
        await expect(page.locator("[data-saved]")).toHaveText("Native");
        await expect(page.locator("[data-file]")).toHaveText(
          "native.txt:Native file",
        );
        await page
          .getByRole("button", { name: "Redirect", exact: true })
          .click();
        await expect(page.locator("h1")).toHaveText("Default action");
        await page.getByLabel("Name", { exact: true }).fill("NoJS");
        await page.getByRole("button", { name: "Submit", exact: true }).click();
        await expect(page.locator("[data-result]")).toHaveText("Default NoJS");
      } finally {
        await context.close();
      }
    },
  },
  {
    id: "G01-errors",
    group: "actions",
    upstream:
      "basics/test/playwright/test.js: action HTTP errors and validation",
    async run({ url, boundary, mode }) {
      const origin = new URL(url).origin;
      for (const [query, content, status, message] of [
        ["/missing", "application/x-www-form-urlencoded", 404, "Not Found"],
        ["/save", "application/json", 415, "Unsupported Media Type"],
        ["/broken", "application/x-www-form-urlencoded", 418, "Action teapot"],
      ] as const) {
        const response = await fetch(path(url, `/actions?${query}`), {
          method: "POST",
          headers: { origin, accept: "text/html", "content-type": content },
          body: content === "application/json" ? "{}" : "name=X",
        });
        expect(response.status).toBe(status);
        expect(await response.text()).toContain(message);
      }
      const forbidden = await fetch(path(url, "/actions?/save"), {
        method: "POST",
        headers: { origin: "https://foreign.invalid", accept: "text/html" },
        body: new URLSearchParams({ name: "no" }),
      });
      // Pinned Kit respond.js gates CSRF on !__SVELTEKIT_DEV__. Candidate deliberately enforces it in both modes.
      const developmentReference =
        boundary === "reference" && mode === "development";
      expect(forbidden.status).toBe(developmentReference ? 200 : 403);
      const forbiddenBody = await forbidden.text();
      if (developmentReference) expect(forbiddenBody).toContain("Saved no");
      else expect(forbiddenBody).not.toContain("Saved no");
      const endpoint = await fetch(path(url, "/actions"), {
        method: "POST",
        headers: {
          origin,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(await endpoint.text()).toBe("Endpoint POST");
    },
  },
];
