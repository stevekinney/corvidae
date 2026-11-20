import { expect } from "@playwright/test";
import type { RuntimeCase } from "./runtime-cases.ts";
import type { RuntimeBoundary } from "./runtime-fixture.ts";

const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;

const escapedRoutes = [
  { name: "hash", pathname: "/%23", label: "static-hash" },
  { name: "question", pathname: "/%3F", label: "static-question" },
  { name: "slash", pathname: "/%2F", label: "static-slash" },
  { name: "open bracket", pathname: "/%5B", label: "static-open-bracket" },
  {
    name: "close bracket",
    pathname: "/%5D",
    label: "static-close-bracket",
  },
  {
    name: "Unicode with a dynamic sibling",
    pathname: "/%F0%9F%98%80",
    label: "static-unicode",
    referenceLabel: "dynamic-😀",
  },
  {
    name: "standalone Unicode",
    pathname: "/unicode/%F0%9F%98%80",
    label: "standalone-unicode",
  },
] as const;

/** Adds the R escaped-route pages to an already assembled runtime fixture. */
export function routeEscapeFixtures(
  boundary: RuntimeBoundary,
): Record<string, string> {
  const doubleEncodeHashLink =
    boundary === "candidate" &&
    process.env.VELVETEEN_ROUTE_ESCAPE_DOUBLE_ENCODE === "1";
  const links = escapedRoutes
    .map(
      ({ name, pathname }) =>
        `<a href="/runtime/route-escapes${
          name === "hash" && doubleEncodeHashLink ? "/%2523" : pathname
        }">${name}</a>`,
    )
    .join("");

  return {
    "src/routes/route-escapes/+page.svelte": `<h1>route escapes</h1>
      <nav>${links}</nav>
      <a href="/runtime/route-escapes#same-document">same document</a>
      <p id="same-document">same-document target</p>`,
    "src/routes/route-escapes/[x+23]/+page.svelte":
      '<h1 data-route-label>static-hash</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/[x+3f]/+page.svelte":
      '<h1 data-route-label>static-question</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/[x+2f]/+page.svelte":
      '<h1 data-route-label>static-slash</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/[x+5b]/+page.svelte":
      '<h1 data-route-label>static-open-bracket</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/[x+5d]/+page.svelte":
      '<h1 data-route-label>static-close-bracket</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/[u+1f600]/+page.svelte":
      '<h1 data-route-label>static-unicode</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/unicode/[u+1f600]/+page.svelte":
      '<h1 data-route-label>standalone-unicode</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/[value]/+page.svelte":
      '<script lang="ts">let { data } = $props();</script><h1 data-route-label>dynamic-{data.value}</h1><a href="/runtime/route-escapes">back</a>',
    "src/routes/route-escapes/[value]/+page.server.ts":
      "export const load = ({ params }) => ({ value: params.value });",
  };
}

export const runtimeRouteEscapes: RuntimeCase = {
  id: "R-route-escapes",
  group: "navigation",
  upstream:
    "packages/kit/src/core/sync/create_manifest_data/index.spec.js: encodes invalid characters",
  async run({ url, page, boundary }) {
    const routes = escapedRoutes.map((route) => ({
      ...route,
      label:
        boundary === "reference" && "referenceLabel" in route
          ? route.referenceLabel
          : route.label,
    }));
    for (const { pathname, label } of routes) {
      const response = await fetch(path(url, `/route-escapes${pathname}`));
      expect(response.status, `${pathname} direct HTTP status`).toBe(200);
      expect(await response.text(), `${pathname} direct route label`).toContain(
        label,
      );
    }

    let documentRequests = 0;
    page.on("request", (request) => {
      if (request.resourceType() === "document") documentRequests++;
    });
    await page.goto(path(url, "/route-escapes"));
    await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
    expect(documentRequests, "R initial document request").toBe(1);
    await page.evaluate(() => {
      document.documentElement.dataset.routeEscapeMarker = "retained";
    });

    for (const { name, pathname, label } of routes) {
      const link = page.getByRole("link", { name, exact: true });
      await link.click();
      await expect(
        page.locator("[data-route-label]"),
        `${name} browser route label`,
      ).toHaveText(label);
      await expect(page, `${name} browser URL`).toHaveURL(
        path(url, `/route-escapes${pathname}`),
      );
      expect(documentRequests, `${name} stays same-document`).toBe(1);
      expect(
        await page.evaluate(
          () => document.documentElement.dataset.routeEscapeMarker,
        ),
        `${name} retains document marker`,
      ).toBe("retained");
      await page.getByRole("link", { name: "back", exact: true }).click();
      await expect(page).toHaveURL(path(url, "/route-escapes"));
    }

    const sameDocument = page.getByRole("link", { name: "same document" });
    await sameDocument.click();
    await expect(page, "R same-document URL").toHaveURL(
      path(url, "/route-escapes#same-document"),
    );
    expect(documentRequests, "R same-document link keeps document").toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.dataset.routeEscapeMarker,
      ),
      "R same-document link retains marker",
    ).toBe("retained");
  },
};
