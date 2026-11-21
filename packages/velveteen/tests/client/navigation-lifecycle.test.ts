import { afterEach, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { startNavigationLifecycleRuntime } from "./navigation-lifecycle-fixture.ts";
import {
  createPageIdentity,
  sameRenderedBranch,
} from "../../src/client/navigation-retention.ts";
import type { PagePayload, RenderNode } from "../../src/data/contract.ts";

declare global {
  var lifecycle: {
    goto(
      url: string,
      options?: { replace?: boolean; keepView?: boolean },
    ): Promise<void>;
    invalidateAll(): Promise<void>;
    dispose(): Promise<void>;
  };
  var lifecycleBlock: boolean;
  var lifecycleBeforeUnload: boolean;
  var lifecycleBeforeAttempts: number;
  var heldNavigation: Promise<void>;
  var lifecyclePopCount: number;
  var lifecycleEvents: Array<{
    stage: string;
    routeId: string | null;
    params: Record<string, unknown> | null;
    to: string;
  }>;
}

const diagnostics: string[] = [];
async function createPage(browser: Browser) {
  const page = await browser.newPage();
  page.on("pageerror", (error) =>
    diagnostics.push(`pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()))
      diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  return page;
}
let browser: Browser | undefined;
let page: Page | undefined;
let runtime:
  Awaited<ReturnType<typeof startNavigationLifecycleRuntime>> | undefined;

afterEach(async () => {
  await page?.close();
  await browser?.close();
  await runtime?.stop();
  page = undefined;
  browser = undefined;
  runtime = undefined;
  expect(diagnostics.splice(0)).toEqual([]);
});

test("retention rejects a changed parent even when the leaf constructor is shared", () => {
  const layout = () => undefined;
  const changedLayout = () => undefined;
  const leaf = () => undefined;
  const branch = (parent: () => undefined) =>
    [
      { node: 0, role: "layout" as const, data: {}, component: parent },
      { node: 1, role: "page" as const, data: {}, component: leaf },
    ] as unknown as RenderNode[];
  expect(sameRenderedBranch(branch(layout), branch(layout))).toBe(true);
  expect(sameRenderedBranch(branch(layout), branch(changedLayout))).toBe(false);
});

test("page identity preserves repeated replacements and ends retention without key collisions", () => {
  // These are identity-unit inputs only; browser tests below always use emitted
  // routes and real application data responses.
  const payload = (id: string): PagePayload => ({
    version: 1,
    url: `http://identity.test/${encodeURIComponent(id)}`,
    basePath: "",
    stylesheets: [],
    routeId: "/[id]",
    params: { id },
    status: 200,
    error: null,
    options: { ssr: false, csr: true },
    nodes: [],
    branch: [],
    fetched: [],
  });
  const identity = createPageIdentity(
    (page) => String(page.params.id),
    payload("new"),
  );
  const original = identity.current();
  expect(identity.commit(payload("saved"), { keepView: true })).toBe(original);
  expect(identity.commit(payload("saved-again"), { keepView: true })).toBe(
    original,
  );
  const fresh = identity.commit(payload("new"));
  expect(fresh).not.toBe(original);
  expect(identity.commit(payload("new"))).toBe(fresh);
  expect(identity.commit(payload("saved"), { keepView: true })).toBe(fresh);
  const saved = identity.commit(payload("saved"));
  expect(saved).not.toBe(fresh);
  expect(identity.commit(payload("saved"))).toBe(saved);
  expect(identity.commit(payload(saved!))).not.toBe(saved);
  const defaultIdentity = createPageIdentity(undefined, payload("new"));
  expect(() =>
    defaultIdentity.commit(payload("saved"), { keepView: true }),
  ).toThrow("requires pageKey");
  expect(defaultIdentity.current()).toBeUndefined();
});

for (const mode of ["development", "production"] as const)
  describe(`navigation lifecycle (${mode})`, () => {
    if (mode === "development")
      test("ordinary hooks expose route metadata after a server reroute", async () => {
        runtime = await startNavigationLifecycleRuntime(mode);
        browser = await chromium.launch({ headless: true });
        page = await createPage(browser);
        await page.goto(
          new URL(`${runtime.basePath}/chat/new`, runtime.server.url).href,
        );
        const reroutedUrl = new URL(
          `${runtime.basePath}/rerouted`,
          runtime.server.url,
        ).href;
        await page.evaluate(() =>
          globalThis.lifecycle.goto("/lifecycle-fixture/rerouted"),
        );
        await page.waitForURL("**/rerouted");
        expect(await page.locator("[data-other]").textContent()).toBe("target");
        expect(await page.evaluate(() => globalThis.lifecycleEvents)).toEqual([
          {
            stage: "before",
            routeId: "/rerouted",
            params: {},
            to: reroutedUrl,
          },
          {
            stage: "after",
            routeId: "/other/[id]",
            params: { id: "target" },
            to: reroutedUrl,
          },
        ]);
      });

    test("remounts by page identity, retains keepView, and ends retention on ordinary navigation", async () => {
      runtime = await startNavigationLifecycleRuntime(mode);
      browser = await chromium.launch({ headless: true });
      page = await createPage(browser);
      await page.goto(
        new URL(`${runtime.basePath}/chat/new`, runtime.server.url).href,
      );
      await page.locator("[data-dirty]").fill("draft");
      const mounts = await page.evaluate(() =>
        Number(sessionStorage.getItem("lifecycle-mounts")),
      );
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/new?view=compact", {
          replace: true,
        }),
      );
      await page.waitForURL("**/chat/new?view=compact");
      expect(await page.locator("[data-dirty]").inputValue()).toBe("draft");
      expect(
        await page.evaluate(() =>
          Number(sessionStorage.getItem("lifecycle-mounts")),
        ),
      ).toBe(mounts);
      await page.waitForFunction(
        () => Number(document.querySelector("[data-ticks]")?.textContent) > 1,
      );
      const ticks = Number(await page.locator("[data-ticks]").textContent());
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/saved", {
          replace: true,
          keepView: true,
        }),
      );
      await page.waitForURL("**/chat/saved");
      expect(await page.locator("[data-dirty]").inputValue()).toBe("draft");
      expect(
        await page.evaluate(() =>
          Number(sessionStorage.getItem("lifecycle-mounts")),
        ),
      ).toBe(mounts);
      await page.waitForFunction(
        (previous) =>
          Number(document.querySelector("[data-ticks]")?.textContent) >
          previous,
        ticks,
      );
      await page.evaluate(() => globalThis.lifecycle.invalidateAll());
      expect(await page.locator("[data-dirty]").inputValue()).toBe("draft");
      expect(
        await page.evaluate(() =>
          Number(sessionStorage.getItem("lifecycle-mounts")),
        ),
      ).toBe(mounts);
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/new"),
      );
      await page.waitForURL("**/chat/new");
      expect(await page.locator("[data-dirty]").inputValue()).toBe("");
      expect(
        await page.evaluate(() =>
          Number(sessionStorage.getItem("lifecycle-mounts")),
        ),
      ).toBeGreaterThan(mounts);
      const freshMounts = await page.evaluate(() =>
        Number(sessionStorage.getItem("lifecycle-mounts")),
      );
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/new?view=wide", {
          replace: true,
        }),
      );
      await page.waitForURL("**/chat/new?view=wide");
      expect(await page.locator("[data-dirty]").inputValue()).toBe("");
      expect(
        await page.evaluate(() =>
          Number(sessionStorage.getItem("lifecycle-mounts")),
        ),
      ).toBe(freshMounts);
    });

    test("cancels links, goto, and back without changing the settled page, then disarms", async () => {
      runtime = await startNavigationLifecycleRuntime(mode);
      browser = await chromium.launch({ headless: true });
      page = await createPage(browser);
      await page.goto(
        new URL(`${runtime.basePath}/chat/new`, runtime.server.url).href,
      );
      await page.waitForFunction(() => Boolean(globalThis.lifecycle));
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/saved"),
      );
      await page.waitForURL("**/chat/saved");
      await page.evaluate(() => {
        globalThis.lifecycleBlock = true;
      });
      await page.locator("#lifecycle-link").click();
      await page.waitForFunction(
        () => globalThis.lifecycleBeforeAttempts === 2,
      );
      expect(new URL(page.url()).pathname).toBe(
        `${runtime.basePath}/chat/saved`,
      );
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/blocked"),
      );
      await page.waitForFunction(
        () => globalThis.lifecycleBeforeAttempts === 3,
      );
      expect(new URL(page.url()).pathname).toBe(
        `${runtime.basePath}/chat/saved`,
      );
      await page.evaluate(() => {
        globalThis.lifecyclePopCount = 0;
        addEventListener("popstate", () => globalThis.lifecyclePopCount++);
        history.back();
      });
      await page.waitForFunction(
        () =>
          globalThis.lifecycleBeforeAttempts === 4 &&
          globalThis.lifecyclePopCount === 2 &&
          location.pathname.endsWith("/chat/saved"),
      );
      expect(new URL(page.url()).pathname).toBe(
        `${runtime.basePath}/chat/saved`,
      );
      await page.evaluate(() => {
        globalThis.lifecycleBlock = false;
      });
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/continued"),
      );
      await page.waitForURL("**/chat/continued");
      await page.evaluate(() => {
        globalThis.lifecycleBeforeUnload = false;
        globalThis.lifecycleBlock = true;
        const event = new Event("beforeunload", { cancelable: true });
        dispatchEvent(event);
        if (!event.defaultPrevented)
          throw new Error("Before-unload guard did not cancel");
      });
      expect(await page.evaluate(() => globalThis.lifecycleBeforeUnload)).toBe(
        true,
      );
      await page.evaluate(() => globalThis.lifecycle.dispose());
      await page.evaluate(() => {
        globalThis.lifecycleBeforeUnload = false;
        dispatchEvent(new Event("beforeunload"));
      });
      expect(await page.evaluate(() => globalThis.lifecycleBeforeUnload)).toBe(
        false,
      );
      const attempts = await page.evaluate(
        () => globalThis.lifecycleBeforeAttempts,
      );
      expect(await page.locator("[data-page]").count()).toBe(0);
      const previousPopCount = await page.evaluate(
        () => globalThis.lifecyclePopCount,
      );
      await page.evaluate(() => history.back());
      await page.waitForFunction(
        (previous) =>
          globalThis.lifecyclePopCount === previous + 1 &&
          location.pathname.endsWith("/chat/saved"),
        previousPopCount,
      );
      expect(
        await page.evaluate(() => globalThis.lifecycleBeforeAttempts),
      ).toBe(attempts);
      expect(await page.locator("[data-page]").count()).toBe(0);
    });

    test("repeated retained replacements end on history traversal or ordinary same-address navigation", async () => {
      runtime = await startNavigationLifecycleRuntime(mode);
      browser = await chromium.launch({ headless: true });
      page = await createPage(browser);
      await page.goto(
        new URL(`${runtime.basePath}/chat/previous`, runtime.server.url).href,
      );
      await page.waitForFunction(() => Boolean(globalThis.lifecycle));
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/new"),
      );
      await page.locator("[data-dirty]").fill("draft");
      const mounts = await page.evaluate(() =>
        sessionStorage.getItem("lifecycle-mounts"),
      );
      await page.evaluate(async () => {
        await globalThis.lifecycle.goto("/lifecycle-fixture/chat/saved", {
          replace: true,
          keepView: true,
        });
        await globalThis.lifecycle.goto("/lifecycle-fixture/chat/saved-again", {
          replace: true,
          keepView: true,
        });
      });
      expect(await page.locator("[data-dirty]").inputValue()).toBe("draft");
      expect(
        await page.evaluate(() => sessionStorage.getItem("lifecycle-mounts")),
      ).toBe(mounts);
      await page.evaluate(() => history.back());
      await page.waitForFunction(
        () => document.querySelector("[data-page]")?.textContent === "previous",
      );
      expect(new URL(page.url()).pathname).toBe(
        "/lifecycle-fixture/chat/previous",
      );
      expect(await page.locator("[data-dirty]").inputValue()).toBe("");
      await page.evaluate(() => history.forward());
      await page.waitForFunction(
        () =>
          document.querySelector("[data-page]")?.textContent === "saved-again",
      );
      expect(new URL(page.url()).pathname).toBe(
        "/lifecycle-fixture/chat/saved-again",
      );
      expect(await page.locator("[data-dirty]").inputValue()).toBe("");
      await page.locator("[data-dirty]").fill("another draft");
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/final", {
          replace: true,
          keepView: true,
        }),
      );
      expect(await page.locator("[data-dirty]").inputValue()).toBe(
        "another draft",
      );
      await page.evaluate(() =>
        globalThis.lifecycle.goto("/lifecycle-fixture/chat/final"),
      );
      expect(await page.locator("[data-dirty]").inputValue()).toBe("");
    });

    test("does not let a held stale load overwrite a newer navigation", async () => {
      runtime = await startNavigationLifecycleRuntime(mode);
      browser = await chromium.launch({ headless: true });
      page = await createPage(browser);
      await page.goto(
        new URL(`${runtime.basePath}/chat/new`, runtime.server.url).href,
      );
      await page.waitForFunction(() => Boolean(globalThis.lifecycle));
      await page.evaluate(() => {
        globalThis.heldNavigation = globalThis.lifecycle.goto(
          "/lifecycle-fixture/chat/held?hold=1",
        );
      });
      await page.waitForFunction(
        async () =>
          (
            await fetch("/lifecycle-fixture/__fixture_state").then((response) =>
              response.json(),
            )
          ).entered === true,
      );
      expect(await page.locator("#lifecycle-pending").isVisible()).toBe(true);
      await page.evaluate(
        () => void globalThis.lifecycle.goto("/lifecycle-fixture/chat/fast"),
      );
      await page.waitForURL("**/chat/fast");
      expect(await page.locator("[data-page]").textContent()).toBe("fast");
      const release = await page.evaluate(() =>
        fetch("/lifecycle-fixture/__fixture_release", { method: "POST" }).then(
          (response) => response.json(),
        ),
      );
      const repeatedRelease = await page.evaluate(() =>
        fetch("/lifecycle-fixture/__fixture_release", { method: "POST" }).then(
          (response) => response.json(),
        ),
      );
      expect(release.released).toBe(true);
      expect(repeatedRelease.released).toBe(false);
      await page.evaluate(() => globalThis.heldNavigation);
      await page.waitForFunction(() =>
        document.querySelector("#lifecycle-pending")?.hasAttribute("hidden"),
      );
      expect(await page.locator("[data-page]").textContent()).toBe("fast");
    });

    test("rejects keepView without replace before committing", async () => {
      runtime = await startNavigationLifecycleRuntime(mode);
      browser = await chromium.launch({ headless: true });
      page = await createPage(browser);
      await page.goto(
        new URL(`${runtime.basePath}/chat/new`, runtime.server.url).href,
      );
      await page.waitForFunction(() => Boolean(globalThis.lifecycle));
      const historyLength = await page.evaluate(() => history.length);
      const dirtyInput = await page.locator("[data-dirty]").elementHandle();
      await page.locator("[data-dirty]").fill("retain after rejection");
      const result = await page.evaluate(async () => {
        try {
          await globalThis.lifecycle.goto("/lifecycle-fixture/chat/saved", {
            keepView: true,
          });
          return "accepted";
        } catch (error) {
          return String(error);
        }
      });
      expect(result).toContain("replace: true");
      expect(new URL(page.url()).pathname).toBe(`${runtime.basePath}/chat/new`);
      const branchResult = await page.evaluate(async () => {
        try {
          await globalThis.lifecycle.goto("/lifecycle-fixture/parent/view", {
            replace: true,
            keepView: true,
          });
          return "accepted";
        } catch (error) {
          return String(error);
        }
      });
      expect(branchResult).toContain("same resolved component branch");
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(
        await dirtyInput!.evaluate(
          (element) => element === document.querySelector("[data-dirty]"),
        ),
      ).toBe(true);
      expect(await page.locator("[data-dirty]").inputValue()).toBe(
        "retain after rejection",
      );
      expect(new URL(page.url()).pathname).toBe(`${runtime.basePath}/chat/new`);
    });
  });
