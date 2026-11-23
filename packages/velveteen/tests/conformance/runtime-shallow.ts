import { expect } from "@playwright/test";
import type { RuntimeCase } from "./runtime-cases.ts";
import type { RuntimeBoundary } from "./runtime-fixture.ts";
import { resolve } from "node:path";

type Put = (path: string, contents: string) => void;

/** Adds the O shallow-routing pages to an already assembled runtime fixture. */
export function writeShallowFixtures(
  put: Put,
  navigationImport: string,
  boundary: RuntimeBoundary,
): void {
  const reference = boundary === "reference";
  const clientContext = JSON.stringify(
    resolve(import.meta.dir, "../../src/client/navigation-context.ts"),
  );
  const stateImport = reference
    ? "import {page as navigationState} from '$app/state';"
    : `import {getNavigationState} from ${clientContext}; const navigationState=getNavigationState();`;
  const lifecycle = reference
    ? "import {afterNavigate,beforeNavigate,onNavigate} from '$app/navigation';"
    : `import {afterNavigate,beforeNavigate,onNavigate} from ${clientContext};`;
  const shallowState = `<p data-shallow-target>{navigationState.shallow?.url.pathname ?? 'none'}</p>
    <p data-shallow-state>{navigationState.state.active ?? 'none'}</p>`;
  put(
    "src/routes/shallow/+page.server.ts",
    "let runs=0;export const load=({depends})=>{depends('/runtime/shallow/resource');return {runs:++runs};};",
  );
  put(
    "src/routes/shallow/+layout.svelte",
    `<script lang="ts">
      ${lifecycle}
      let { children } = $props();
      const record = (hook, event) => {
        const log = Reflect.get(window, 'shallowNavigationLog') ?? [];
        log.push({
          hook, shallow: event.shallow, type: event.type,
          path: ${reference ? "event.to?.url.pathname" : "event.to.pathname"},
          params: ${reference ? "event.to?.params" : "event.params"},
          routeId: ${reference ? "event.to?.route.id" : "event.routeId"}
        });
        Reflect.set(window, 'shallowNavigationLog', log);
      };
      beforeNavigate((event) => {
        record('before', event);
        const path = ${reference ? "event.to?.url.pathname" : "event.to.pathname"};
        if (path === '/runtime/shallow/cancel' ||
            (event.type === 'popstate' && Reflect.get(window, 'blockShallowPop'))) {
          Reflect.deleteProperty(window, 'blockShallowPop');
          event.cancel();
        }
      });
      onNavigate((event) => {
        record('on', event);
        return () => record('complete', event);
      });
      afterNavigate((event) => {
        if (event.type !== 'enter') record('after', event);
      });
    </script>
    {@render children()}`,
  );
  put(
    "src/routes/shallow/+page.svelte",
    `<script lang="ts">
      import { onMount } from 'svelte';
      ${navigationImport}
      ${stateImport}
      let { data } = $props();
      let draft = $state('');
      let ready = $state(false);
      onMount(() => { ready = true; });
    </script>
    <h1 data-rendered-route>shallow-root</h1>
    <p data-shallow-runs>{data.runs}</p>
    <input aria-label="Draft" data-shallow-input bind:value={draft} disabled={!ready} />
    ${shallowState}
    <button onclick={() => navigation.goto('/runtime/shallow/a', { shallow: true, state: { active: 'a' } })}>push</button>
    <button onclick={() => navigation.goto('b', { shallow: true, replace: true, state: { active: 'b' } })}>replace</button>
    <button onclick={() => navigation.goto('/runtime/shallow/cancel', { shallow: true, state: { active: 'cancel' } })}>cancel</button>
    <button onclick={() => navigation.invalidate('resource'${reference ? ", true" : ""})}>refresh</button>
    <button onclick={() => navigation.goto('/runtime/shallow/a')}>regular</button>`,
  );
  put(
    "src/routes/shallow/[id]/+page.svelte",
    `<script lang="ts">
      ${stateImport}
      ${reference ? "" : "let { params } = $props();"}
    </script>
    <h1 data-real-route>real-{${reference ? "navigationState.params.id" : "params.id"}}</h1>
    ${shallowState}`,
  );
}

const path = (url: string, route: string) =>
  new URL(`/runtime${route}`, url).href;

export const runtimeShallow: RuntimeCase[] = [
  {
    id: "O-shallow-routing",
    group: "navigation",
    upstream:
      "packages/kit/test/apps/basics/test/playwright/client.test.js: Shallow routing",
    async run({ url, page }) {
      let dataRequests = 0;
      page.on("request", (request) => {
        if (
          request.headers().accept?.includes("application/x-velveteen-data") ||
          new URL(request.url()).pathname.endsWith("/__data.json")
        )
          dataRequests++;
      });
      await page.goto(path(url, "/shallow"));
      const hookLog = () =>
        page.evaluate(() =>
          (Reflect.get(window, "shallowNavigationLog") ?? []).map(
            ({
              hook,
              shallow,
              type,
              path,
              params,
              routeId,
            }: {
              hook: string;
              shallow: boolean;
              type: string;
              path: string;
              params: Record<string, unknown>;
              routeId: string;
            }) => ({ hook, shallow, type, path, params, routeId }),
          ),
        );
      const draft = page.locator("[data-shallow-input]");
      const loadRuns = page.locator("[data-shallow-runs]");
      await draft.fill("retained");
      const previousRuns = await loadRuns.textContent();
      const baseline = dataRequests;
      await page.getByRole("button", { name: "push", exact: true }).click();
      await expect(page).toHaveURL(path(url, "/shallow/a"));
      await expect(page.locator("[data-rendered-route]")).toHaveText(
        "shallow-root",
      );
      expect(dataRequests).toBe(baseline);
      await expect(page.locator("[data-shallow-target]")).toHaveText(
        "/runtime/shallow/a",
      );
      await expect(page.locator("[data-shallow-state]")).toHaveText("a");
      await expect(page.locator("[data-shallow-input]")).toHaveValue(
        "retained",
      );
      await expect.poll(hookLog).toEqual(
        ["before", "on", "after", "complete"].map((hook) => ({
          hook,
          shallow: true,
          type: "goto",
          path: "/runtime/shallow/a",
          params: { id: "a" },
          routeId: "/shallow/[id]",
        })),
      );
      await page.getByRole("button", { name: "replace", exact: true }).click();
      await expect(page).toHaveURL(path(url, "/shallow/b"));
      await expect(page.locator("[data-rendered-route]")).toHaveText(
        "shallow-root",
      );
      await expect(page.locator("[data-shallow-target]")).toHaveText(
        "/runtime/shallow/b",
      );
      await expect(page.locator("[data-shallow-state]")).toHaveText("b");
      await expect(page.locator("[data-shallow-input]")).toHaveValue(
        "retained",
      );

      await page.evaluate(() => {
        Reflect.set(window, "shallowNavigationLog", []);
      });
      await page.getByRole("button", { name: "cancel", exact: true }).click();
      await expect(page).toHaveURL(path(url, "/shallow/b"));
      await expect(page.locator("[data-shallow-state]")).toHaveText("b");
      await expect.poll(hookLog).toEqual([
        {
          hook: "before",
          shallow: true,
          type: "goto",
          path: "/runtime/shallow/cancel",
          params: { id: "cancel" },
          routeId: "/shallow/[id]",
        },
      ]);
      expect(dataRequests).toBe(baseline);
      expect(await loadRuns.textContent()).toBe(previousRuns);

      const runs = Number(
        await page.locator("[data-shallow-runs]").textContent(),
      );
      await page.getByRole("button", { name: "refresh", exact: true }).click();
      await expect
        .poll(async () => Number(await loadRuns.textContent()))
        .toBe(runs + 1);
      expect(dataRequests).toBe(baseline + 1);
      await expect(page).toHaveURL(path(url, "/shallow/b"));
      await expect(page.locator("[data-shallow-target]")).toHaveText(
        "/runtime/shallow/b",
      );
      await expect(page.locator("[data-shallow-state]")).toHaveText("b");
      await expect(draft).toHaveValue("retained");

      await page.goBack();
      await expect(page).toHaveURL(path(url, "/shallow"));
      await expect(page.locator("[data-shallow-target]")).toHaveText("none");
      await expect(page.locator("[data-shallow-state]")).toHaveText("none");
      await page.goForward();
      await expect(page).toHaveURL(path(url, "/shallow/b"));
      await expect(page.locator("[data-shallow-target]")).toHaveText(
        "/runtime/shallow/b",
      );
      await expect(page.locator("[data-shallow-state]")).toHaveText("b");

      await page.getByRole("button", { name: "regular", exact: true }).click();
      await expect(page.locator("[data-real-route]")).toHaveText("real-a");
      await expect(page.locator("[data-shallow-target]")).toHaveText("none");
      const backHooks = ["before", "on", "after", "complete"].map((hook) => ({
        hook,
        shallow: true,
        type: "popstate",
        path: "/runtime/shallow/b",
        params: { id: "b" },
        routeId: "/shallow/[id]",
      }));
      const clearHookLog = (block = false) =>
        page.evaluate((value) => {
          Reflect.set(window, "shallowNavigationLog", []);
          Reflect.set(window, "blockShallowPop", value);
        }, block);
      await clearHookLog(true);
      await page.evaluate(() => history.back());
      await expect.poll(hookLog).toEqual(backHooks.slice(0, 1));
      await expect(page).toHaveURL(path(url, "/shallow/a"));
      await expect(page.locator("[data-real-route]")).toHaveText("real-a");
      await clearHookLog();
      await page.goBack();
      await expect.poll(hookLog).toEqual(backHooks);
      await expect(page).toHaveURL(path(url, "/shallow/b"));
      await expect(page.locator("[data-rendered-route]")).toHaveText(
        "shallow-root",
      );
      await expect(page.locator("[data-shallow-target]")).toHaveText(
        "/runtime/shallow/b",
      );
      await expect(page.locator("[data-shallow-state]")).toHaveText("b");

      await page.reload();
      await expect(page.locator("[data-real-route]")).toHaveText("real-b");
      await expect(page.locator("[data-shallow-target]")).toHaveText("none");
      await page.waitForFunction(() => Boolean(Reflect.get(window, "runtime")));
      await page.goBack();
      await expect(page).toHaveURL(path(url, "/shallow"));
      await expect(page.locator("[data-rendered-route]")).toHaveText(
        "shallow-root",
      );
      await page.goForward();
      await expect(page).toHaveURL(path(url, "/shallow/b"));
      await expect(page.locator("[data-rendered-route]")).toHaveText(
        "shallow-root",
      );
      await expect(page.locator("[data-shallow-state]")).toHaveText("b");
    },
  },
];
