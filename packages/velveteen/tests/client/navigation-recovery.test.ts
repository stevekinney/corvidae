import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page, type Request } from "playwright";
import { dataMediaType } from "../../src/data/contract.ts";
import type { RecoveryProbe } from "./navigation-recovery-bootstrap.ts";
import {
  recoveryDataHeader,
  startRecoveryFixture,
} from "./navigation-recovery-fixture.ts";

type BrowserObservation = {
  console: Array<{ text: string; url: string }>;
  errors: string[];
  dataRequests: Array<{
    url: string;
    status?: number;
    outcome?: string;
  }>;
  failedRequests: Array<{
    url: string;
    error: string | null;
    resourceType: string;
    navigation: boolean;
    accept?: string;
  }>;
};
const evidence: unknown[] = [];
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  await Bun.write(
    ".velveteen/evidence/batch-j-navigation-recovery.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
});

for (const mode of ["development", "production"] as const) {
  describe(`navigation recovery (${mode})`, () => {
    let fixture: Awaited<ReturnType<typeof startRecoveryFixture>>;
    beforeAll(async () => {
      fixture = await startRecoveryFixture(mode);
    });
    afterAll(async () => {
      await fixture?.stop();
    });

    async function observe(
      run: (page: Page, observation: BrowserObservation) => Promise<void>,
    ) {
      fixture.reset();
      const context = await browser.newContext();
      const page = await context.newPage();
      const observation: BrowserObservation = {
        console: [],
        errors: [],
        dataRequests: [],
        failedRequests: [],
      };
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type()))
          observation.console.push({
            text: message.text(),
            url: message.location().url,
          });
      });
      page.on("pageerror", (error) => observation.errors.push(error.message));
      const dataRequests = new Map<
        Request,
        BrowserObservation["dataRequests"][number]
      >();
      const confirmations = new Map<string, PromiseWithResolvers<void>>();
      const confirmData = (marker: string) => {
        let confirmation = confirmations.get(marker);
        if (!confirmation) {
          confirmation = Promise.withResolvers<void>();
          void confirmation.promise.catch(() => {});
          confirmations.set(marker, confirmation);
        }
        return confirmation;
      };
      await page.exposeFunction(
        "confirmRecoveryData",
        (marker: string) => confirmData(marker).promise,
      );
      page.on("request", (request) => {
        if (!request.headers().accept?.includes(dataMediaType)) return;
        const observed = { url: request.url() };
        dataRequests.set(request, observed);
        observation.dataRequests.push(observed);
      });
      page.on("response", (response) => {
        const observed = dataRequests.get(response.request());
        if (observed) observed.status = response.status();
      });
      page.on("requestfinished", (request) => {
        const observed = dataRequests.get(request);
        if (observed) observed.outcome = "finished";
        const marker = request.headers()[recoveryDataHeader];
        if (marker) confirmData(marker).resolve();
      });
      page.on("requestfailed", (request) => {
        const observed = dataRequests.get(request);
        if (observed)
          observed.outcome = request.failure()?.errorText ?? "failed";
        const marker = request.headers()[recoveryDataHeader];
        if (marker)
          confirmData(marker).reject(
            new Error(`Recovery data request failed: ${observed?.outcome}`),
          );
      });
      page.on("requestfailed", (request) =>
        observation.failedRequests.push({
          url: request.url(),
          error: request.failure()?.errorText ?? null,
          resourceType: request.resourceType(),
          navigation: request.isNavigationRequest(),
          accept: request.headers().accept,
        }),
      );
      try {
        await run(page, observation);
        evidence.push({
          mode,
          documents: [...fixture.documents],
          chunkRequests: [...fixture.chunkRequests],
          ...observation,
        });
        expect(observation.errors).toEqual([]);
        const expectedUrl = new URL(fixture.brokenChunk, fixture.origin).href;
        for (const message of observation.console) {
          expect(message.url).toBe(expectedUrl);
          expect([
            "Failed to load resource: the server responded with a status of 404 (Not Found)",
            "Failed to load resource: net::ERR_INTERNET_DISCONNECTED",
          ]).toContain(message.text);
        }
        for (const request of observation.failedRequests)
          expect(request.url).toBe(expectedUrl);
      } finally {
        await context.close();
      }
    }

    async function ready(page: Page) {
      await page.goto(`${fixture.origin}/recovery/`);
      await page.waitForFunction(() =>
        Boolean(globalThis.recoveryProbe?.application),
      );
      expect(await page.locator("[data-page]").textContent()).toBe("Healthy");
    }

    async function failure(page: Page) {
      await page
        .locator('[data-recovery-status][data-failed="true"]')
        .waitFor();
      // A DOM failure marker can precede the replacement document's load event.
      // Do not cancel that document by starting the next navigation early.
      await page.waitForLoadState("load");
      expect(
        await page.locator("[data-recovery-status]").textContent(),
      ).toContain("Navigation failed:");
    }

    test("reloads once for an actual missing chunk and clears the guard after success", async () => {
      await observe(async (page) => {
        await ready(page);
        fixture.setMissing("once");
        await page.getByText("broken", { exact: true }).click();
        await page.waitForURL("**/recovery/broken");
        await page
          .locator("[data-page]")
          .filter({ hasText: "Recovered" })
          .waitFor();
        expect(fixture.documents).toEqual(["/recovery/", "/recovery/broken"]);
        expect(fixture.chunkRequests).toEqual([
          fixture.brokenChunk,
          fixture.brokenChunk,
        ]);
        expect(
          await page.evaluate(() =>
            sessionStorage.getItem("velveteen-fixture-chunk-reload"),
          ),
        ).toBeNull();
      });
    });

    test("a repeat missing chunk displays failure; a successful document resets recovery", async () => {
      await observe(async (page, observation) => {
        await ready(page);
        fixture.setMissing("always");
        await page.getByText("broken", { exact: true }).click();
        await failure(page);
        expect(fixture.documents).toEqual(["/recovery/", "/recovery/broken"]);
        expect(fixture.chunkRequests).toHaveLength(2);
        expect(
          await page.evaluate(() =>
            sessionStorage.getItem("velveteen-fixture-chunk-reload"),
          ),
        ).toBe("attempted");
        await page.goto(`${fixture.origin}/recovery/`);
        await page.waitForFunction(() =>
          Boolean(globalThis.recoveryProbe?.application),
        );
        expect(
          await page.evaluate(() =>
            sessionStorage.getItem("velveteen-fixture-chunk-reload"),
          ),
        ).toBeNull();
        await page.getByText("broken", { exact: true }).click();
        await failure(page);
        expect(fixture.documents).toEqual([
          "/recovery/",
          "/recovery/broken",
          "/recovery/",
          "/recovery/broken",
        ]);
        expect(fixture.chunkRequests).toHaveLength(4);
        expect(
          observation.dataRequests.map(({ url, status, outcome }) => ({
            path: new URL(url).pathname,
            status,
            outcome,
          })),
        ).toEqual(
          [
            "/recovery/",
            "/recovery/broken",
            "/recovery/broken",
            "/recovery/",
            "/recovery/broken",
            "/recovery/broken",
          ].map((path) => ({ path, status: 200, outcome: "finished" })),
        );
      });
    });

    test("unavailable storage cannot trigger a document reload", async () => {
      await observe(async (page) => {
        await page.addInitScript(() =>
          Object.defineProperty(window, "sessionStorage", {
            get() {
              throw new DOMException("Storage unavailable", "SecurityError");
            },
          }),
        );
        await ready(page);
        fixture.setMissing("always");
        await page.getByText("broken", { exact: true }).click();
        await failure(page);
        expect(fixture.documents).toEqual(["/recovery/"]);
        expect(fixture.chunkRequests).toHaveLength(1);
        expect(new URL(page.url()).pathname).toBe("/recovery/");
      });
    });

    test("going offline during a real chunk request exposes failure without reload", async () => {
      await observe(async (page) => {
        await ready(page);
        let requested = false;
        await page.route(
          new URL(fixture.brokenChunk, fixture.origin).href,
          async (route) => {
            requested = true;
            await page.context().setOffline(true);
            await route.abort("internetdisconnected");
          },
        );
        await page.getByText("broken", { exact: true }).click();
        await failure(page);
        expect(requested).toBe(true);
        expect(await page.evaluate(() => navigator.onLine)).toBe(false);
        expect(fixture.documents).toEqual(["/recovery/"]);
        await page.context().setOffline(false);
      });
    });

    test("module evaluation failures remain visible without being mistaken for missing chunks", async () => {
      await observe(async (page, observation) => {
        await ready(page);
        await page.getByText("evaluation", { exact: true }).click();
        await failure(page);
        const errors = await page.evaluate(
          () => (globalThis.recoveryProbe as RecoveryProbe).errors,
        );
        expect(errors.length).toBeGreaterThan(0);
        expect(
          errors.every((message) => message === "Fixture evaluation failed"),
        ).toBe(true);
        expect(fixture.documents).toEqual(["/recovery/"]);
        expect(fixture.chunkRequests).toEqual([]);
        expect(observation.console).toEqual([]);
        expect(observation.failedRequests).toEqual([]);
      });
    });
  });
}
