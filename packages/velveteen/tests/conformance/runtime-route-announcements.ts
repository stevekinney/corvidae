import { expect } from "@playwright/test";
import { readVelveteenTestEnvironment } from "../environment-configuration.ts";
import { resolve } from "node:path";
import type { RuntimeCase } from "./runtime-cases.ts";
import type { RuntimeBoundary } from "./runtime-fixture.ts";

const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;

/** Adds the P route-announcement pages to an already assembled runtime fixture. */
export function routeAnnouncementFixtures(
  boundary: RuntimeBoundary,
): Record<string, string> {
  const navigation =
    boundary === "reference"
      ? "import * as navigation from '$app/navigation';"
      : `import { getNavigation } from ${JSON.stringify(resolve(import.meta.dir, "../../src/client/navigation-context.ts"))}; const navigation = getNavigation();`;
  const staleTitle =
    boundary === "candidate" &&
    readVelveteenTestEnvironment().announcerStaleTitle;

  return {
    "src/routes/announcements/+page.svelte": `<script lang="ts">
      import { onMount } from 'svelte';
      onMount(() => {
        ${
          staleTitle
            ? `const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
        if (!descriptor?.get || !descriptor.set) return;
        let stale = true;
        Object.defineProperty(document, 'title', {
          configurable: true,
          get() {
            const value = descriptor.get!.call(document);
            if (!stale || value !== 'Announcements destination') return value;
            stale = false;
            queueMicrotask(() => Reflect.deleteProperty(document, 'title'));
            return 'Announcements source';
          },
          set(value: string) { descriptor.set!.call(document, value); }
        });`
            : ""
        }
      });
    </script>
    <svelte:head><title>Announcements source</title></svelte:head>
    <h1 data-announcement-page>Announcements source</h1>
    <p data-document-marker></p>
    <nav>
      <a href="/runtime/announcements/destination">Destination</a>
      <a href="/runtime/announcements/untitled">Untitled</a>
      <a href="/runtime/announcements/same">Same title</a>
    </nav>`,
    "src/routes/announcements/destination/+page.svelte": `<svelte:head><title>Announcements destination</title></svelte:head>
    <h1 data-announcement-page>Announcements destination</h1>
    <a href="/runtime/announcements">Back</a>`,
    "src/routes/announcements/untitled/+page.svelte": `<svelte:head><title>{''}</title></svelte:head>
    <h1 data-announcement-page>Announcements untitled</h1>
    <a href="/runtime/announcements">Back</a>`,
    "src/routes/announcements/same/+page.svelte": `<script lang="ts">
      ${navigation}
      let step = $state('one');
      async function shallow() {
        step = 'two';
        await navigation.goto('/runtime/announcements/same?step=two', { shallow: true, replace: true });
        Reflect.set(window, 'announcementShallowPhase', 'settled');
      }
    </script>
    <svelte:head><title>Announcements same</title></svelte:head>
    <h1 data-announcement-page>Announcements same {step}</h1>
    <button onclick={shallow}>Shallow same title</button>`,
  };
}

export const runtimeRouteAnnouncements: RuntimeCase = {
  id: "P-route-announcements",
  group: "navigation",
  upstream:
    "packages/kit/test/apps/basics/test/playwright/cross-platform/client.test.js: announces client-side navigation; packages/kit/src/runtime/components/root.svelte: route announcement lifecycle",
  async run({ url, browser, page }) {
    await page.goto(path(url, "/announcements"));
    const announcer = page.locator("#svelte-announcer");
    await expect(announcer, "P initial announcer exists").toHaveAttribute(
      "aria-live",
      "assertive",
    );
    await expect(announcer, "P initial announcer is atomic").toHaveAttribute(
      "aria-atomic",
      "true",
    );
    await expect(announcer, "P initial hydrated announcer is empty").toHaveText(
      "",
    );
    await expect(announcer, "P initial announcer is visually hidden").toHaveCSS(
      "position",
      "absolute",
    );

    await page.evaluate(() =>
      Reflect.set(document.body, "announcementMarker", "retained"),
    );
    await page.getByRole("link", { name: "Destination" }).click();
    await expect(page).toHaveURL(path(url, "/announcements/destination"));
    await expect(page.locator("[data-announcement-page]")).toHaveText(
      "Announcements destination",
    );
    await expect(page).toHaveTitle("Announcements destination");
    await expect(announcer, "P destination announcement value").toHaveText(
      "Announcements destination",
    );
    expect(
      await page.evaluate(() =>
        Reflect.get(document.body, "announcementMarker"),
      ),
      "P destination retains the document",
    ).toBe("retained");

    await page.goBack();
    await expect(page).toHaveURL(path(url, "/announcements"));
    await expect(page.locator("[data-announcement-page]")).toHaveText(
      "Announcements source",
    );
    await expect(page).toHaveTitle("Announcements source");
    await expect(announcer, "P back announcement value").toHaveText(
      "Announcements source",
    );

    await page.getByRole("link", { name: "Untitled" }).click();
    await expect(page).toHaveURL(path(url, "/announcements/untitled"));
    await expect(page.locator("[data-announcement-page]")).toHaveText(
      "Announcements untitled",
    );
    await expect(page).toHaveTitle("");
    await expect(
      announcer,
      "P untitled fallback announcement value",
    ).toHaveText("untitled page");

    await page.goto(path(url, "/announcements/same"));
    await expect(page).toHaveTitle("Announcements same");
    await expect(
      announcer,
      "P same-title shallow starts with empty phase",
    ).toHaveText("");
    await page.evaluate(() =>
      Reflect.set(window, "announcementShallowPhase", "started"),
    );
    await page.getByRole("button", { name: "Shallow same title" }).click();
    await expect(page).toHaveURL(path(url, "/announcements/same?step=two"));
    await expect(page.locator("[data-announcement-page]")).toHaveText(
      "Announcements same two",
    );
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, "announcementShallowPhase")),
      )
      .toBe("settled");
    await expect(
      page,
      "P same-title shallow keeps the destination title",
    ).toHaveTitle("Announcements same");
    await expect(
      announcer,
      "P same-title shallow post-settlement announcement value",
    ).toHaveText("Announcements same");

    const noJavaScriptContext = await browser.newContext({
      javaScriptEnabled: false,
    });
    try {
      const noJavaScriptPage = await noJavaScriptContext.newPage();
      await noJavaScriptPage.goto(path(url, "/announcements"));
      await expect(noJavaScriptPage).toHaveTitle("Announcements source");
      await expect(
        noJavaScriptPage.locator("#svelte-announcer"),
        "P JavaScript-disabled initial navigation has no announcer",
      ).toHaveCount(0);
      await noJavaScriptPage.getByRole("link", { name: "Destination" }).click();
      await expect(noJavaScriptPage).toHaveURL(
        path(url, "/announcements/destination"),
      );
      await expect(noJavaScriptPage).toHaveTitle("Announcements destination");
      await expect(
        noJavaScriptPage.locator("#svelte-announcer"),
        "P JavaScript-disabled navigation has no announcer",
      ).toHaveCount(0);
    } finally {
      await noJavaScriptContext.close();
    }
  },
};
