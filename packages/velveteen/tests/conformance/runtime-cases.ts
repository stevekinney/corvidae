import { runtimeActions } from "./runtime-actions.ts";
import { runtimeActionTransport } from "./runtime-action-transport.ts";
import { runtimeRaces } from "./runtime-races.ts";
import { runOptionalRestCase } from "./runtime-optional-rest.ts";
import { runtimeShallow } from "./runtime-shallow.ts";
import { runtimeSnapshots } from "./runtime-snapshots.ts";
import { runtimeRouteAnnouncements } from "./runtime-route-announcements.ts";
import { runtimeRouteEscapes } from "./runtime-route-escapes.ts";
import { runtimeRemoteForms, runtimeRemoteQueries } from "./runtime-remotes.ts";
import {
  runtimeCustomTransport,
  runtimeTransportSnapshots,
} from "./runtime-custom-transport.ts";
import { expect, type Browser, type Page } from "@playwright/test";
export type RuntimeCase = {
  id: string;
  group: "server" | "navigation" | "actions";
  expectedHttpErrors?: number[];
  upstream: string;
  run: (input: {
    url: string;
    browser: Browser;
    page: Page;
    boundary: "candidate" | "reference";
    mode: "development" | "production";
  }) => Promise<void>;
};
const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;
export const runtimeCases: RuntimeCase[] = [
  runtimeRemoteQueries,
  runtimeRemoteForms,
  runtimeRouteEscapes,
  runtimeCustomTransport,
  runtimeTransportSnapshots,
  runtimeRouteAnnouncements,
  ...runtimeShallow,
  runtimeSnapshots,
  ...runtimeRaces,
  ...runtimeActions,
  runtimeActionTransport,
  {
    id: "M-optional-rest-matchers",
    group: "navigation",
    upstream:
      "packages/kit/src/utils/routing.spec.js: optional and rest params; standard schema rejection",
    run: runOptionalRestCase,
  },
  {
    id: "H01-route-options",
    group: "server",
    upstream: "basics/test/playwright/test.js: trailing slash",
    async run({ url }) {
      for (const [from, to] of [
        ["/options", "/options/"],
        ["/options/never/", "/options/never"],
      ]) {
        const response = await fetch(path(url, from), { redirect: "manual" });
        expect(response.status).toBe(308);
        expect(
          new URL(response.headers.get("location")!, path(url, from)).pathname,
        ).toBe(`/runtime${to}`);
        const rendered = await fetch(path(url, to));
        expect(rendered.status).toBe(200);
        expect(await rendered.text()).toContain("Trailing slash");
      }
      for (const suffix of ["", "/"])
        expect(
          (
            await fetch(path(url, `/options/ignore${suffix}`), {
              redirect: "manual",
            })
          ).status,
        ).toBe(200);
    },
  },
  {
    id: "L-typed-matchers",
    group: "navigation",
    upstream:
      "packages/kit/src/utils/routing.spec.js: respects matchers; validates and transforms params with a standard schema; rejects params when a standard schema fails validation; respects matchers with hyphenated names; decodes params",
    async run({ url, page }) {
      const initial = await fetch(path(url, "/typed-matchers/static"));
      expect(initial.status).toBe(200);
      expect(await initial.text()).toContain("static precedence");
      expect((await fetch(path(url, "/typed-matchers/a/b"))).status).toBe(404);
      expect(
        (await fetch(path(url, "/typed-matchers/bigint/not-a-number"))).status,
      ).toBe(404);
      const serverRendered = await fetch(path(url, "/typed-matchers/a"));
      expect(serverRendered.status).toBe(200);
      expect(await serverRendered.text()).toContain("lowercase: a (string)");
      await page.goto(path(url, "/typed-matchers/a"));
      await expect(
        page.getByRole("heading", { name: "lowercase: a (string)" }),
      ).toBeVisible();
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      const goto = async (route: string) => {
        await page.evaluate(
          (value) => Reflect.get(window, "runtime").goto(value),
          route,
        );
        await page.waitForURL(new URL(route, url).href);
      };
      await goto("/runtime/typed-matchers/B");
      await expect(
        page.getByRole("heading", { name: "uppercase: B (string)" }),
      ).toBeVisible();
      await goto("/runtime/typed-matchers/number/0");
      await expect(
        page.getByRole("heading", { name: "number: 0 (number)" }),
      ).toBeVisible();
      const zeroRuns = await page.locator("[data-runs]").textContent();
      await goto("/runtime/typed-matchers/number/00");
      expect(await page.locator("[data-runs]").textContent()).toBe(zeroRuns);
      await goto("/runtime/typed-matchers/number/1");
      await expect(
        page.getByRole("heading", { name: "number: 1 (number)" }),
      ).toBeVisible();
      expect(
        Number(await page.locator("[data-runs]").textContent()),
      ).toBeGreaterThan(Number(zeroRuns));
      await goto("/runtime/typed-matchers/boolean/false");
      await expect(
        page.getByRole("heading", { name: "boolean: false (boolean)" }),
      ).toBeVisible();
      await goto("/runtime/typed-matchers/bigint/9007199254740993");
      await expect(
        page.getByRole("heading", {
          name: "bigint: 9007199254740993 (bigint)",
        }),
      ).toBeVisible();
      await goto("/runtime/typed-matchers/hyphen/42");
      await expect(
        page.getByRole("heading", { name: "positive-integer: 42 (string)" }),
      ).toBeVisible();
      await goto("/runtime/typed-matchers/echo/a%2Fb");
      await expect(
        page.getByRole("heading", { name: "echo: a/b (string)" }),
      ).toBeVisible();
      await goto("/runtime/typed-matchers/echo/%E2%9C%93");
      await expect(
        page.getByRole("heading", { name: "echo: ✓ (string)" }),
      ).toBeVisible();
      await goto("/runtime/typed-matchers/echo/%252F");
      await expect(
        page.getByRole("heading", { name: "echo: %2F (string)" }),
      ).toBeVisible();
      await goto("/runtime/typed-matchers/everything-else");
      await expect(
        page.getByRole("heading", {
          name: "fallback: everything-else (string)",
        }),
      ).toBeVisible();
    },
  },
  {
    id: "K-layout-inheritance",
    group: "navigation",
    upstream:
      "basics/test/playwright/test.js: resets layout; src/core/sync/create_manifest_data/index.spec.js: creates routes with named layouts",
    async run({ url, page }) {
      const reset = path(url, "/layout-k/branch/reset/");
      const direct = await fetch(reset);
      expect(direct.status).toBe(200);
      const html = await direct.text();
      expect(html).toContain("Layout reset");
      expect(html).toContain('data-k-root="">Hello</h2>');
      expect(html, "K root reset excludes the ordinary layout").not.toContain(
        "data-k-layout",
      );
      expect(html).not.toContain("data-named-layout");
      expect(html).not.toContain("data-skipped-layout");
      expect(html).not.toContain("data-k-local");
      const counts = await (await fetch(path(url, "/counts"))).json();
      expect(counts.skipped).toBe(0);

      let documentRequests = 0;
      page.on("request", (request) => {
        if (request.resourceType() === "document") documentRequests++;
      });
      await page.goto(path(url, "/layout-k/ordinary/"));
      await expect(
        page.getByRole("heading", { name: "Ordinary inheritance" }),
      ).toBeVisible();
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      expect(await page.locator("[data-k-ordinary]").textContent()).toBe(
        "k-layout/named-layout",
      );
      expect(await page.locator("[data-k-parent]").textContent()).toBe(
        "k-layout",
      );
      expect(await page.locator("[data-named-parent]").textContent()).toBe(
        "named-layout",
      );
      const beforeClientNavigation = documentRequests;
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto(
          "/runtime/layout-k/branch/named-reset/",
        ),
      );
      await expect(
        page.getByRole("heading", { name: "Named reset" }),
      ).toBeVisible();
      expect(await page.locator("[data-k-named]").textContent()).toBe(
        "named-layout",
      );
      expect(await page.locator("[data-skipped-layout]").count()).toBe(0);
      expect(documentRequests).toBe(beforeClientNavigation);
      expect(await page.locator("[data-k-ordinary]").count()).toBe(0);

      const error = await fetch(path(url, "/layout-k/branch/error/"));
      expect(error.status).toBe(418);
      const errorHtml = await error.text();
      expect(errorHtml).toContain("data-error");
      expect(errorHtml).toContain("K child failure");
      expect(errorHtml).not.toContain("data-k-branch-error");

      const options = await fetch(path(url, "/layout-k/branch/options"), {
        redirect: "manual",
      });
      expect(options.status).toBe(308);
      expect(
        new URL(options.headers.get("location")!, options.url).pathname,
      ).toBe("/runtime/layout-k/branch/options/");
      const layoutReset = await fetch(path(url, "/layout-k/branch/options/"));
      expect(layoutReset.status).toBe(200);
      const layoutHtml = await layoutReset.text();
      expect(layoutHtml).toContain("Reset options");
      expect(layoutHtml).toContain("data-k-rebound");
      expect(layoutHtml).toContain("data-k-layout");
      expect(layoutHtml).not.toContain("data-named-layout");
      expect(layoutHtml).not.toContain("data-skipped-layout");
      const finalCounts = await (await fetch(path(url, "/counts"))).json();
      expect(finalCounts.skipped).toBe(counts.skipped);
    },
  },
  {
    id: "E03-document",
    group: "server",
    upstream:
      "packages/kit/test/apps/basics/test/vitest/server.spec.js: load and render",
    async run({ url }) {
      const response = await fetch(path(url, "/items/one"), {
        headers: { accept: "text/html" },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Item one");
      expect(html).toContain("server-layout");
      expect(html).toContain("universal-layout/fetched/");
      expect(html).toContain("<title>Item one</title>");
      expect(html).not.toContain("PRIVATE_RUNTIME_SENTINEL");
      expect(await (await fetch(path(url, "/proof.txt"))).text()).toBe(
        "Static proof",
      );
      const post = await fetch(path(url, "/endpoint"), {
        method: "POST",
        body: "request body",
        headers: { accept: "application/json", origin: new URL(url).origin },
      });
      expect(post.status).toBe(200);
      expect(await post.text()).toBe("request body");
      const head = await fetch(path(url, "/endpoint"), {
        method: "HEAD",
        headers: { accept: "application/json" },
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    },
  },
  {
    id: "E03-errors",
    group: "server",
    upstream:
      "packages/kit/test/apps/basics/test/vitest/server.spec.js: errors and redirects",
    async run({ url }) {
      const redirect = await fetch(path(url, "/items/redirect"), {
        redirect: "manual",
        headers: { accept: "text/html" },
      });
      expect(redirect.status).toBe(303);
      expect(new URL(redirect.headers.get("location")!, url).pathname).toBe(
        "/runtime/items/two",
      );
      for (const [route, status, message] of [
        ["/items/error", 418, "Teapot"],
        ["/items/private", 500, "Internal Error"],
        ["/items/render", 500, "Internal Error"],
      ] as const) {
        const response = await fetch(path(url, route), {
          headers: { accept: "text/html" },
        });
        expect(response.status).toBe(status);
        const html = await response.text();
        expect(html).toContain(message);
        expect(html).toContain("data-nested-error");
        expect(html).not.toContain("PRIVATE_RUNTIME_SENTINEL");
        expect(html).not.toContain("PRIVATE_RENDER_SENTINEL");
      }
      expect((await fetch(path(url, "/missing"))).status).toBe(404);
    },
  },
  {
    id: "F01-hydration",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: hydration and parent data",
    async run({ url, page }) {
      let endpointRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/runtime/endpoint")
          endpointRequests++;
      });
      await page.goto(path(url, "/items/one"));
      await expect(
        page.getByRole("heading", { name: "Item one", exact: true }),
      ).toBeVisible();
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      expect(endpointRequests).toBe(0);
      expect(await page.title()).toBe("Item one");
      await expect(
        page.getByRole("heading", { name: "Item one", exact: true }),
      ).toHaveCSS("color", "rgb(120, 30, 60)");
      await page.getByRole("button", { name: "Layout 0", exact: true }).click();
      await page.getByRole("button", { name: "Nested 0", exact: true }).click();
      const root = await page.locator("[data-root]").textContent();
      await page.getByRole("link", { name: "Two", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Item two", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Layout 1", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Nested 1", exact: true }),
      ).toBeVisible();
      expect(await page.locator("[data-root]").textContent()).toBe(root);
    },
  },
  {
    id: "F02-preload-invalidate",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: preloadData; invalidate; refreshAll",
    async run({ url, page }) {
      await page.goto(path(url, "/items/one"));
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      await page.evaluate(async () => {
        const runtime = Reflect.get(window, "runtime");
        await runtime.preloadCode("/items/[id]");
        await runtime.preloadData("/runtime/items/three");
      });
      const before: Record<string, number> = await (
        await fetch(path(url, "/counts"))
      ).json();
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/three"),
      );
      await expect(
        page.getByRole("heading", { name: "Item three", exact: true }),
      ).toBeVisible();
      const after: Record<string, number> = await (
        await fetch(path(url, "/counts"))
      ).json();
      expect(after.page).toBe(before.page);
      const runs = Number(await page.locator("[data-page-runs]").textContent()),
        root = await page.locator("[data-root]").textContent();
      await page.evaluate(() =>
        Reflect.get(window, "runtime").invalidate("app:item"),
      );
      await expect(page.locator("[data-page-runs]")).not.toHaveText(
        String(runs),
      );
      expect(await page.locator("[data-root]").textContent()).toBe(root);
      await page.evaluate(() => Reflect.get(window, "runtime").invalidateAll());
      await expect(page.locator("[data-root]")).not.toHaveText(root!);
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/three?q=changed", {
          replace: true,
        }),
      );
      await expect(page.locator("[data-page]")).toHaveText(
        "universal-layout/fetched/changed",
      );
    },
  },
  {
    id: "F01-modes",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: ssr=false and csr=false",
    async run({ url, page, browser }) {
      const html = await (await fetch(path(url, "/spa"))).text();
      expect(html).not.toContain("<h1>Mounted SPA</h1>");
      await page.goto(path(url, "/spa"));
      await expect(
        page.getByRole("heading", { name: "Mounted SPA" }),
      ).toBeVisible();
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        const disabled = await context.newPage();
        await disabled.goto(path(url, "/static"));
        await expect(
          disabled.getByRole("heading", { name: "No client" }),
        ).toBeVisible();
      } finally {
        await context.close();
      }
      const noClient = await (await fetch(path(url, "/static"))).text();
      expect(noClient).toContain("No client");
      expect(noClient).not.toContain("<script");
    },
  },
  {
    id: "E04-deferred",
    group: "server",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: streaming",
    async run({ url, page }) {
      const key = crypto.randomUUID();
      await page.goto(path(url, `/deferred?key=${key}`), {
        waitUntil: "commit",
      });
      await expect(page.locator("[data-pending]")).toHaveText("Pending");
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      expect(
        (
          await fetch(path(url, `/release?key=${key}`), {
            method: "POST",
            headers: { origin: new URL(url).origin },
          })
        ).status,
      ).toBe(200);
      await expect(
        page.getByRole("heading", { name: "Deferred complete" }),
      ).toBeVisible();
    },
  },
  {
    id: "F03-history",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: history, scroll and focus",
    async run({ url, page }) {
      await page.goto(path(url, "/items/one"));
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      await page.evaluate(() => scrollTo(0, 500));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(500);
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/two"),
      );
      await expect(
        page.getByRole("heading", { name: "Item two", exact: true }),
      ).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      expect(
        await page.evaluate(() => document.activeElement === document.body),
      ).toBe(true);
      await page.goBack();
      await expect(
        page.getByRole("heading", { name: "Item one", exact: true }),
      ).toBeVisible();
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(500);
      await page.goForward();
      await expect(
        page.getByRole("heading", { name: "Item two", exact: true }),
      ).toBeVisible();
      await page.evaluate(() =>
        Reflect.get(window, "runtime").goto("/runtime/items/one#target"),
      );
      await expect
        .poll(() => page.evaluate(() => scrollY))
        .toBeGreaterThan(1000);
    },
  },
];
